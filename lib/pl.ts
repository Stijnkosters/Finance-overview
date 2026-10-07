import { fetchOrders } from "@/lib/shopify";
import { resolveAdSpend } from "@/lib/adspend";
import { fetchGoogleSpendByCountry, googleAdsConfigured } from "@/lib/googleAds";
import { nichebayConfigured, fetchNicheBayCostByOrder, fetchNicheBayRefunds } from "@/lib/nichebay";
import { SHOPS, getShop, type ShopCfg } from "@/lib/shops";
import { readJson } from "@/lib/store";
import { resolveShopifyCfg, shopHasCredentials } from "@/lib/shopifyAuth";
import costsDrivemax from "@/data/costs.json";
import costsHomivo from "@/data/costs-homivo.json";

// ============================================================
// Kern van de P&L-berekening — gedeeld door /api/pl (dashboard) en
// /api/margin (machine-toegang voor ADSGUARD). Verplaatst uit
// app/api/pl/route.ts zonder gedragswijziging.
// ============================================================

const COSTS_BY_KEY: Record<string, Record<string, { title: string; price: number; cost: number }>> = {
  drivemax: (costsDrivemax as any).costs || {},
  homivo: (costsHomivo as any).costs || {},
};
const FEE_RATE = parseFloat(process.env.FEE_RATE || "0.018");
const FEE_FIXED = parseFloat(process.env.FEE_FIXED || "0.25");

// BTW wordt WEL getoond, maar NIET van de omzet afgetrokken (tenzij true).
const BTW_UIT_OMZET = false;

function dayKeyAmsterdam(iso: string) {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

function round(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

type Bucket = { date: string; orders: number; units: number; revenue: number; btw: number; refunds: number; cogs: number; noCost: number };
type CountryAgg = { country: string; orders: number; units: number; revenue: number; cogs: number; refunds: number };

async function gatherShop(shop: ShopCfg, from: string, to: string) {
  const costs = COSTS_BY_KEY[shop.costsKey] || {};
  const shopifyCfg = await resolveShopifyCfg(shop);
  const orders = await fetchOrders(from, to, shopifyCfg);
  // Orders die vóór de periode zijn geplaatst maar ín de periode zijn bijgewerkt
  // (bv. terugbetaald). Zo tellen refunds op oude orders ook mee.
  const olderTouched = await fetchOrders(
    from, to, shopifyCfg,
    `updated_at:>='${from}T00:00:00Z' updated_at:<='${to}T23:59:59Z' created_at:<'${from}T00:00:00Z'`,
  );
  const adRes = await resolveAdSpend(from, to, shop.ads);
  const adspend = adRes.map;

  // Google-adspend per land (voor ROAS per land). Niet-fataal: faalt de geo-query,
  // dan blijft de per-land-tabel gewoon de drempel (break-even) tonen.
  let adByCountry: Record<string, number> = {};
  const gCid = shop.ads?.googleCustomerId;
  if ((shop.ads?.useGoogleApi ?? true) && googleAdsConfigured(gCid)) {
    try { adByCountry = await fetchGoogleSpendByCountry(from, to, gCid, shop.ads?.googleLoginCustomerId); }
    catch { /* stil: extra info */ }
  }

  let nbMap: Record<string, number> = {};
  let cogsSource = "costs.json";
  let cogsWarning: string | null = null;
  if (shop.nichebay && nichebayConfigured()) {
    // nbMap = inkoop per order in EUR (NicheBay rekent in USD; omgerekend in lib/nichebay.ts)
    try {
      const r = await fetchNicheBayCostByOrder(); nbMap = r.map; cogsSource = "nichebay";
      const w: string[] = [];
      if (r.truncated) w.push("NicheBay: veiligheidsgrens voor het aantal orders bereikt; mogelijk ontbreekt de inkoop van oudere orders.");
      if (r.fx.noDate > 0) w.push(`Inkoop: ${r.fx.noDate} orders zonder datum; daar is geen dagkoers van de order voor.`);
      const zonderEcb = r.fx.nichebay + r.fx.nood + r.fx.onbekend;
      if (zonderEcb > 0) w.push(`Inkoop: ${zonderEcb} orders niet met de ECB-dagkoers omgerekend (${r.fx.nichebay} met de eurokoers van NicheBay, ${r.fx.nood} met noodkoers 0,92, ${r.fx.onbekend} valuta onbekend).`);
      if (w.length) cogsWarning = w.join(" ");
    }
    catch (e: any) { cogsWarning = `NicheBay-koppeling faalde (${e.message}). Val terug op costs.json.`; }
  }

  // Exacte inkoop per order uit geüploade leveranciersfacturen (bv. Win-Win PDF).
  // Deze heeft voorrang op NicheBay en costs.json: het is de echte betaalde prijs.
  const invStore = await readJson(`ordercogs-${shop.costsKey}.json`, { orders: {} });
  const invMap: Record<string, number> = (invStore && invStore.orders) || {};

  let nbMatched = 0, nbZero = 0, ordersNoCost = 0, invMatched = 0;
  const byDay: Record<string, Bucket> = {};
  const byCountry: Record<string, CountryAgg> = {};
  const unmatched: Record<string, { title: string; units: number }> = {};
  const custStats: Record<string, { orders: number; revenue: number }> = {};
  const refundDetails: Record<string, any[]> = {}; // per dag: wie kreeg refund + mailcontact

  for (const o of orders) {
    const day = dayKeyAmsterdam(o.createdAt);
    if (!byDay[day]) byDay[day] = { date: day, orders: 0, units: 0, revenue: 0, btw: 0, refunds: 0, cogs: 0, noCost: 0 };
    const bucket = byDay[day];
    bucket.orders += 1;
    const orderRev = parseFloat(o.totalPriceSet?.shopMoney?.amount || o.subtotalPriceSet?.shopMoney?.amount || "0");
    const orderTax = parseFloat(o.totalTaxSet?.shopMoney?.amount || "0");
    const orderRefund = parseFloat(o.totalRefundedSet?.shopMoney?.amount || "0");
    bucket.revenue += orderRev;
    bucket.btw += orderTax;
    // (refunds worden hieronder apart geboekt op de terugbetaaldatum)

    const cc = String(o.shippingAddress?.countryCodeV2 || "??").toUpperCase();
    if (!byCountry[cc]) byCountry[cc] = { country: cc, orders: 0, units: 0, revenue: 0, cogs: 0, refunds: 0 };
    const cAgg = byCountry[cc];
    cAgg.orders += 1;
    cAgg.revenue += orderRev;
    cAgg.refunds += orderRefund;

    const custId = o.customer?.id || `${shop.id}:guest:${o.id}`;
    if (!custStats[custId]) custStats[custId] = { orders: 0, revenue: 0 };
    custStats[custId].orders += 1;
    custStats[custId].revenue += BTW_UIT_OMZET ? orderRev - orderTax : orderRev;

    const orderNo = String(o.name || "").replace(/^#/, "").trim();
    const numId = String(o.id || "").split("/").pop() || "";
    const invCost = invMap[numId] ?? invMap[orderNo];
    const hasInv = invCost != null && invCost > 0;
    if (hasInv) invMatched += 1;
    const nbCost = nbMap[orderNo] ?? (numId ? nbMap[numId] : undefined);
    const hasNb = nbCost != null && nbCost > 0;
    if (hasNb) nbMatched += 1;
    else if (nbCost != null) nbZero += 1;

    // Order geldt als "gedekt" zodra er een exacte factuurprijs of NicheBay-kost is.
    const orderCovered = hasInv || hasNb;

    let lineCogs = 0;
    let lineCovered = true;
    let orderUnits = 0;
    for (const li of o.lineItems?.nodes || []) {
      const vid = li.variant?.id;
      const qty = li.quantity || 0;
      bucket.units += qty;
      orderUnits += qty;
      const c = vid ? costs[vid] : null;
      if (c) lineCogs += qty * (c.cost || 0);
      else if (vid && !orderCovered) {
        lineCovered = false;
        if (!unmatched[vid]) unmatched[vid] = { title: li.title, units: 0 };
        unmatched[vid].units += qty;
      }
    }
    // Prioriteit: factuur > NicheBay > costs.json-regels.
    const orderCogs = hasInv ? invCost! : hasNb ? nbCost! : lineCogs;
    bucket.cogs += orderCogs;
    cAgg.units += orderUnits;
    cAgg.cogs += orderCogs;
    if (!orderCovered && !lineCovered) { ordersNoCost += 1; bucket.noCost += 1; }
  }

  if (invMatched > 0) {
    cogsSource = cogsSource === "nichebay" ? "win-win factuur + nichebay" : "win-win factuur";
  }

  // Refunds boeken op de DATUM VAN DE TERUGBETALING (niet de orderdatum), voor
  // alle orders die in de periode zijn geplaatst óf bijgewerkt. Zo tellen ook
  // terugbetalingen op oudere orders mee, op de juiste dag.
  for (const o of [...orders, ...olderTouched]) {
    for (const rf of o.refunds || []) {
      const amt = parseFloat(rf.totalRefundedSet?.shopMoney?.amount || "0");
      if (!amt) continue;
      const rfDay = dayKeyAmsterdam(rf.createdAt);
      if (rfDay < from || rfDay > to) continue; // alleen refunds binnen de periode
      if (!byDay[rfDay]) byDay[rfDay] = { date: rfDay, orders: 0, units: 0, revenue: 0, btw: 0, refunds: 0, cogs: 0, noCost: 0 };
      byDay[rfDay].refunds += amt;
      (refundDetails[rfDay] ||= []).push({
        order: String(o.name || "").replace(/^#/, "").trim(),
        customer: o.customer?.displayName || "Gast",
        email: o.customer?.email || "",
        amount: round(amt),
        note: rf.note || "",
        at: rf.createdAt,
        shop: shop.name,
      });
    }
  }

  const missingCosts = Object.entries(costs).filter(([, c]) => !c.cost).map(([id, c]) => ({ id, title: c.title }));

  return {
    byDay, byCountry, custStats, refundDetails, adspend, adByCountry, adRes,
    cogsSource, cogsWarning, nbMatched, nbZero, ordersNoCost,
    orderCount: orders.length,
    unmatched: Object.entries(unmatched).map(([id, v]) => ({ id, ...v })),
    missingCosts,
  };
}

// Break-even ROAS per land = omzet ÷ dekkingsbijdrage (omzet − COGS − fees − refunds).
// Fees geschat met dezelfde formule als de dag-P&L.
function finalizeCountries(byCountry: Record<string, CountryAgg>, adByCountry: Record<string, number> = {}) {
  return Object.values(byCountry).map((c) => {
    const fees = c.revenue * FEE_RATE + c.orders * FEE_FIXED;
    const contrib = c.revenue - c.cogs - fees - c.refunds;
    const breakevenRoas = contrib > 0 ? round(c.revenue / contrib) : 0;
    const marginPct = c.revenue > 0 ? round((contrib / c.revenue) * 100) : 0;
    const adspend = round(adByCountry[c.country] || 0);
    const roas = adspend > 0 ? round(c.revenue / adspend) : 0;
    const netAfterAds = contrib - adspend;
    const marginAfterAdsPct = c.revenue > 0 ? round((netAfterAds / c.revenue) * 100) : 0;
    return {
      country: c.country, orders: c.orders, units: c.units,
      revenue: round(c.revenue), cogs: round(c.cogs), refunds: round(c.refunds),
      fees: round(fees), contributionMargin: round(contrib),
      breakevenRoas, marginPct, adspend, roas,
      netAfterAds: round(netAfterAds), marginAfterAdsPct,
      aov: c.orders > 0 ? round(c.revenue / c.orders) : 0,
    };
  }).sort((a, b) => b.revenue - a.revenue);
}

function finalize(byDay: Record<string, Bucket>, adspend: Record<string, number>, custStats: Record<string, { orders: number; revenue: number }>) {
  const days = Object.values(byDay).map((d) => {
    const fees = d.revenue * FEE_RATE + d.orders * FEE_FIXED;
    const ad = adspend[d.date] || 0;
    const omzet = BTW_UIT_OMZET ? d.revenue - d.btw : d.revenue;
    const grossProfit = omzet - d.cogs;
    const totalProfit = omzet - d.cogs - ad - d.refunds - fees;
    const roas = ad > 0 ? omzet / ad : 0;
    const margePct = omzet > 0 ? (totalProfit / omzet) * 100 : 0;
    const aov = d.orders > 0 ? omzet / d.orders : 0;
    return {
      ...d,
      fees: round(fees), adspend: round(ad),
      grossProfit: round(grossProfit), totalProfit: round(totalProfit),
      roas: round(roas), revenue: round(d.revenue), btw: round(d.btw), omzet: round(omzet),
      margePct: round(margePct), aov: round(aov),
      refunds: round(d.refunds), cogs: round(d.cogs),
    };
  }).sort((a, b) => a.date.localeCompare(b.date));

  const totals: any = days.reduce((t, d) => {
    t.orders += d.orders; t.units += d.units; t.revenue += d.revenue;
    t.btw += d.btw; t.omzet += d.omzet;
    t.refunds += d.refunds; t.cogs += d.cogs; t.fees += d.fees;
    t.adspend += d.adspend; t.totalProfit += d.totalProfit;
    return t;
  }, { orders: 0, units: 0, revenue: 0, btw: 0, omzet: 0, refunds: 0, cogs: 0, fees: 0, adspend: 0, totalProfit: 0 });
  Object.keys(totals).forEach((k) => (totals[k] = round(totals[k])));

  const contrib = totals.omzet - totals.cogs - totals.fees - totals.refunds;
  totals.contributionMargin = round(contrib);
  totals.marginPct = totals.omzet > 0 ? round((contrib / totals.omzet) * 100) : 0;
  totals.netMarginPct = totals.omzet > 0 ? round((totals.totalProfit / totals.omzet) * 100) : 0;
  totals.btwPct = totals.omzet > 0 ? round((totals.btw / totals.omzet) * 100) : 0;
  totals.roas = totals.adspend > 0 ? round(totals.omzet / totals.adspend) : 0;
  totals.breakevenRoas = contrib > 0 ? round(totals.omzet / contrib) : 0;

  const O = totals.orders || 0;
  totals.aov = O > 0 ? round(totals.omzet / O) : 0;
  totals.profitPerOrder = O > 0 ? round(totals.totalProfit / O) : 0;
  totals.cacPerOrder = O > 0 ? round(totals.adspend / O) : 0;
  totals.maxCpa = O > 0 ? round(contrib / O) : 0;
  totals.refundRate = totals.omzet > 0 ? round((totals.refunds / totals.omzet) * 100) : 0;

  const custIds = Object.keys(custStats);
  const uniqueCustomers = custIds.length;
  const repeatCustomers = custIds.filter((k) => custStats[k].orders > 1).length;
  totals.uniqueCustomers = uniqueCustomers;
  totals.repeatRate = uniqueCustomers > 0 ? round((repeatCustomers / uniqueCustomers) * 100) : 0;
  totals.ordersPerCustomer = uniqueCustomers > 0 ? round(O / uniqueCustomers) : 0;
  totals.revenuePerCustomer = uniqueCustomers > 0 ? round(totals.omzet / uniqueCustomers) : 0;
  const marginRatio = totals.omzet > 0 ? contrib / totals.omzet : 0;
  totals.ltv = uniqueCustomers > 0 ? round((totals.omzet / uniqueCustomers) * marginRatio) : 0;

  return { days, totals };
}

export type PLResult =
  | { ok: false; error: string }
  | {
      ok: true;
      shop: string;
      range: { from: string; to: string };
      days: any[];
      countries: any[];
      totals: any;
      perShop: any[];
      adSource: string;
      adBreakdown: { google: number; bing: number; manual: number };
      adConvValue: { google: number; bing: number };
      adWarning: string | null;
      cogsSource: string;
      cogsWarning: string | null;
      nbMatched: number;
      nbZero: number;
      ordersNoCost: number;
      orderCount: number;
      missingCosts: any[];
      unmatched: any[];
    };

/** Berekent de P&L voor één shop of "totaal" (alle geconfigureerde shops). */
export async function computePL(shopParam: string, from: string, to: string): Promise<PLResult> {
  let targets: ShopCfg[];
  if (shopParam === "totaal") {
    const flags = await Promise.all(SHOPS.map((s) => shopHasCredentials(s)));
    targets = SHOPS.filter((_, i) => flags[i]);
  } else {
    targets = [getShop(shopParam)];
  }

  if (!targets.length || (shopParam !== "totaal" && !(await shopHasCredentials(targets[0])))) {
    return {
      ok: false,
      error: `Shop "${shopParam}" is nog niet gekoppeld aan Shopify. Koppel 'm via de Koppelingen-tab (Shopify-koppeling) of zet de env-variabelen in Railway.`,
    };
  }

  const mergedByDay: Record<string, Bucket> = {};
  const mergedCountry: Record<string, CountryAgg> = {};
  const mergedAd: Record<string, number> = {};
  const mergedCust: Record<string, { orders: number; revenue: number }> = {};
  const mergedRefunds: Record<string, any[]> = {};
  const mergedAdCountry: Record<string, number> = {};
  const breakdown = { google: 0, bing: 0, manual: 0 };
  const adConv = { google: 0, bing: 0 };
  const adSources: string[] = [];
  const perShop: any[] = [];
  let nbMatched = 0, nbZero = 0, ordersNoCost = 0, orderCount = 0;
  let cogsSource = "", cogsWarning: string | null = null, adWarning: string | null = null;
  let unmatched: any[] = [];
  let missingCosts: any[] = [];

  for (const shop of targets) {
    const g = await gatherShop(shop, from, to);
    for (const [d, b] of Object.entries(g.byDay)) {
      if (!mergedByDay[d]) mergedByDay[d] = { date: d, orders: 0, units: 0, revenue: 0, btw: 0, refunds: 0, cogs: 0, noCost: 0 };
      const t = mergedByDay[d];
      t.orders += b.orders; t.units += b.units; t.revenue += b.revenue; t.btw += b.btw; t.refunds += b.refunds; t.cogs += b.cogs; t.noCost += b.noCost;
    }
    for (const [cc, c] of Object.entries(g.byCountry)) {
      if (!mergedCountry[cc]) mergedCountry[cc] = { country: cc, orders: 0, units: 0, revenue: 0, cogs: 0, refunds: 0 };
      const t = mergedCountry[cc];
      t.orders += c.orders; t.units += c.units; t.revenue += c.revenue; t.cogs += c.cogs; t.refunds += c.refunds;
    }
    for (const [cc, v] of Object.entries(g.adByCountry || {})) mergedAdCountry[cc] = (mergedAdCountry[cc] || 0) + v;
    for (const [d, list] of Object.entries(g.refundDetails)) (mergedRefunds[d] ||= []).push(...list);
    for (const [d, v] of Object.entries(g.adspend)) mergedAd[d] = (mergedAd[d] || 0) + v;
    for (const [k, v] of Object.entries(g.custStats)) {
      if (!mergedCust[k]) mergedCust[k] = { orders: 0, revenue: 0 };
      mergedCust[k].orders += v.orders; mergedCust[k].revenue += v.revenue;
    }
    breakdown.google += g.adRes.breakdown.google;
    breakdown.bing += g.adRes.breakdown.bing;
    breakdown.manual += g.adRes.breakdown.manual;
    adConv.google += g.adRes.convBreakdown?.google || 0;
    adConv.bing += g.adRes.convBreakdown?.bing || 0;
    if (g.adRes.source && g.adRes.source !== "manual") adSources.push(`${shop.name}: ${g.adRes.source}`);
    nbMatched += g.nbMatched; nbZero += g.nbZero; ordersNoCost += g.ordersNoCost; orderCount += g.orderCount;
    cogsSource = cogsSource ? cogsSource : g.cogsSource;
    if (g.cogsWarning) cogsWarning = (cogsWarning ? cogsWarning + " " : "") + `[${shop.name}] ${g.cogsWarning}`;
    if (g.adRes.warning) adWarning = (adWarning ? adWarning + " " : "") + `[${shop.name}] ${g.adRes.warning}`;
    unmatched = unmatched.concat(g.unmatched.map((u: any) => ({ ...u, shop: shop.name })));
    missingCosts = missingCosts.concat(g.missingCosts.map((m: any) => ({ ...m, shop: shop.name })));

    const fin = finalize(g.byDay, g.adspend, g.custStats);
    perShop.push({ id: shop.id, name: shop.name, totals: fin.totals });
  }

  const { days, totals } = finalize(mergedByDay, mergedAd, mergedCust);

  // Refund-details (klant + mailcontact) aan de juiste dag hangen, hoogste bedrag eerst.
  for (const day of days as any[]) {
    const list = mergedRefunds[day.date];
    if (list && list.length) day.refundList = list.sort((a: any, b: any) => b.amount - a.amount);
  }

  // Terug van leverancier (NicheBay-refunds, EUR via dagkoers): verreken als
  // lagere refund-kost in ALLE totalen (winst, break-even, marges). De dag-rijen
  // blijven de bruto klant-refunds tonen; de TOTAAL-regel is daardoor netto.
  let supplierRefunds = 0;
  if (targets.some((s) => s.nichebay) && nichebayConfigured()) {
    try {
      const fromSec = Math.floor(new Date(from + "T00:00:00Z").getTime() / 1000);
      const toSec = Math.floor(new Date(to + "T23:59:59Z").getTime() / 1000);
      supplierRefunds = (await fetchNicheBayRefunds(fromSec, toSec)).total || 0;
    } catch { /* stil: extra info */ }
  }
  if (supplierRefunds > 0) {
    const grossRefunds = totals.refunds || 0;
    const netRefunds = grossRefunds - supplierRefunds;
    totals.refundsGross = round(grossRefunds);
    totals.supplierRefunds = round(supplierRefunds);
    totals.refunds = round(netRefunds);
    totals.totalProfit = round((totals.totalProfit || 0) + supplierRefunds);
    const contrib = (totals.omzet || 0) - (totals.cogs || 0) - (totals.fees || 0) - netRefunds;
    totals.contributionMargin = round(contrib);
    totals.marginPct = totals.omzet > 0 ? round((contrib / totals.omzet) * 100) : 0;
    totals.netMarginPct = totals.omzet > 0 ? round((totals.totalProfit / totals.omzet) * 100) : 0;
    totals.breakevenRoas = contrib > 0 ? round((totals.omzet || 0) / contrib) : 0;
    const O = totals.orders || 0;
    totals.maxCpa = O > 0 ? round(contrib / O) : 0;
    totals.profitPerOrder = O > 0 ? round((totals.totalProfit || 0) / O) : 0;
    totals.refundRate = totals.omzet > 0 ? round((netRefunds / totals.omzet) * 100) : 0;
  }

  return {
    ok: true,
    shop: shopParam,
    range: { from, to },
    days,
    countries: finalizeCountries(mergedCountry, mergedAdCountry),
    totals,
    perShop,
    adSource: adSources.join(" · ") || "manual",
    adBreakdown: breakdown,
    adConvValue: { google: round(adConv.google), bing: round(adConv.bing) },
    adWarning,
    cogsSource,
    cogsWarning,
    nbMatched, nbZero, ordersNoCost,
    orderCount,
    missingCosts,
    unmatched,
  };
}
