// NicheBay Open API client. Haalt per order de kostprijs op en mapt op Shopify-ordernummer.
// Docs: https://app.nichebay.com/shop_admin/apiDocument.html

import { toEUR, preloadRates } from "@/lib/fx";

const BASE = "https://dashboard-admin.nichebay.com/api/open/v1";
const KEY = process.env.NICHEBAY_API_KEY;

export function nichebayConfigured() {
  return !!KEY;
}

async function nbGet(path: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`NicheBay ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  if (j && j.success === false) throw new Error(`NicheBay: ${j.message || "error"}`);
  return j;
}

export async function nbFinancesSample(limit = 20) {
  const j = await nbGet(`/finances?page=1&limit=${limit}`);
  const list = extractList(j);
  return { sample: list[0] || null, count: Array.isArray(list) ? list.length : 0, keys: list[0] ? Object.keys(list[0]) : [] };
}

export async function nbTest() {
  return nbGet("/test");
}

// Tast endpoints af die refunds MET ordernummer zouden kunnen geven.
export async function nbRefundProbe(fromSec: number, toSec: number) {
  const range = `created_at_min=${fromSec}&created_at_max=${toSec}`;
  const paths = [
    "/refunds", "/refund", "/refund/list", "/refund/page", "/refund_order", "/refund_orders", "/order_refunds",
    "/aftersale", "/aftersale/list", "/after_sale", "/after_sale/list", "/after-sales",
    "/returns", "/return", "/return/list", "/order/refunds", "/order/refund", "/finance/refunds", "/finances/refunds",
  ];
  const results: any[] = [];
  for (const p of paths) {
    for (const q of [`?page=1&limit=5&${range}`, `?page=1&limit=5`]) {
      try {
        const res = await fetch(`${BASE}${p}${q}`, { headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" }, cache: "no-store" });
        const text = await res.text();
        let j: any = null; try { j = JSON.parse(text); } catch {}
        const msg = j?.message;
        // Sla 404/"not found" over; toon alleen kansrijke (200 of 400-met-params-hint)
        if (res.status === 404) { results.push({ path: p + q, status: 404 }); break; }
        results.push({ path: p + q, status: res.status, ok: res.ok, message: msg, keys: j?.data ? Object.keys(j.data) : Object.keys(j || {}), sample: text.slice(0, 500) });
        if (res.ok) break; // gevonden, geen 2e variant nodig
      } catch (e: any) {
        results.push({ path: p + q, error: String(e.message).slice(0, 120) });
      }
    }
  }
  return results;
}

// ---- Supplier-refunds (credits die NicheBay terugstort bij retour) ----
// De Invoicing-lijst in het portaal komt uit /finances; regels met method/type
// "Refund" zijn de leverancier-credits. We tellen ze op (totaal + per order).
const METHOD_FIELDS = ["method", "type", "transaction_type", "trans_type", "pay_type", "payment_method", "category", "action", "biz_type", "order_type", "flow_type", "title", "remark"];
const AMOUNT_FIELDS = ["amount", "money", "fee", "sum", "value", "total", "pay_amount", "trans_amount", "change_amount"];
const CURRENCY_FIELDS = ["currency", "currency_code", "coin", "unit"];
const DATE_FIELDS = ["created_at", "create_time", "date", "time", "trans_time", "pay_time", "updated_at"];

const WEEK = 7 * 24 * 3600;
// Korte cache zodat herhaalde P&L-loads dezelfde periode niet steeds opnieuw ophalen.
const _refundCache = new Map<string, { t: number; data: any }>();
const REFUND_TTL = 15 * 60 * 1000;

// Supplier-refunds per order uit /refunds. Velden: order_number, refund_amount
// (aangevraagd), check_amount (goedgekeurd/uitbetaald), check_status (30 = goedgekeurd).
// Bedragen in USD → omgerekend naar EUR met de dagkoers van het weekvenster.
export async function fetchNicheBayRefunds(fromSec: number, toSec: number, maxPages = 20, limit = 100) {
  const cacheKey = `${fromSec}:${toSec}`;
  const hit = _refundCache.get(cacheKey);
  if (hit && Date.now() - hit.t < REFUND_TTL) return hit.data;

  let approvedUsd = 0, requestedUsd = 0, approvedEur = 0, count = 0, pending = 0, fxFailed = 0;
  const byOrder: Record<string, number> = {};     // per order in EUR
  const byOrderUsd: Record<string, number> = {};
  let refundSample: any = null;
  const seenIds = new Set<any>();

  for (let wStart = fromSec; wStart < toSec; wStart += WEEK) {
    const wEnd = Math.min(wStart + WEEK - 1, toSec);
    const fxDate = new Date(wStart * 1000).toISOString().slice(0, 10); // dagkoers van dit venster
    const range = `&created_at_min=${wStart}&created_at_max=${wEnd}`;
    for (let page = 1; page <= maxPages; page++) {
      const j = await nbGet(`/refunds?page=${page}&limit=${limit}${range}`);
      const list: any[] = j?.data?.refunds || [];
      if (!Array.isArray(list) || list.length === 0) break;
      for (const r of list) {
        if (r?.id != null && seenIds.has(r.id)) continue;
        if (r?.id != null) seenIds.add(r.id);
        if (!refundSample) refundSample = r;
        count++;
        requestedUsd += Math.abs(toNum(r?.refund_amount));
        const okAmt = Math.abs(toNum(r?.check_amount));
        if (okAmt <= 0) { pending++; continue; }
        approvedUsd += okAmt;
        const eur = await toEUR(okAmt, "USD", fxDate);
        const eurAmt = eur == null ? okAmt * 0.92 : eur; // val terug op ~0,92 als de koers hapert
        if (eur == null) fxFailed++;
        approvedEur += eurAmt;
        const ono = normNo(r?.order_number || r?.order_no);
        if (ono) {
          byOrder[ono] = Math.round(((byOrder[ono] || 0) + eurAmt) * 100) / 100;
          byOrderUsd[ono] = Math.round(((byOrderUsd[ono] || 0) + okAmt) * 100) / 100;
        }
      }
      if (list.length < limit) break;
    }
  }
  const out = {
    total: Math.round(approvedEur * 100) / 100,        // goedgekeurd, in EUR (dagkoers)
    totalUsd: Math.round(approvedUsd * 100) / 100,
    requestedUsd: Math.round(requestedUsd * 100) / 100,
    count, pending, fxFailed,
    byOrder,        // EUR per order
    byOrderUsd,
    refundSample,
  };
  _refundCache.set(cacheKey, { t: Date.now(), data: out });
  return out;
}

// Mogelijke veldnamen — NicheBay-doc toont de schema's niet, dus we proberen de gangbare.
const ORDER_NO_FIELDS = [
  "order_no", "order_number", "platform_order_no", "platform_order_number",
  "shopify_order_no", "shopify_order_number", "client_order_no", "out_order_no",
  "store_order_no", "source_order_no", "external_order_no", "reference_no",
  "platform_order", "third_order_no", "channel_order_no",
];
const COST_FIELDS = [
  "store_pay_fee", "pay_fee", "total_cost", "cost_total", "order_cost",
  "cost", "cost_price", "pay_amount", "paid_amount", "product_cost",
  "goods_cost", "settle_amount",
];

function pick(obj: any, keys: string[]) {
  for (const k of keys) if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  return null;
}
function toNum(v: any) {
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? 0 : n;
}
function normNo(s: any) {
  return String(s || "").replace(/^#/, "").trim();
}

function extractList(payload: any): any[] {
  const d = payload?.data ?? payload;
  if (Array.isArray(d)) return d;
  return d?.list || d?.orders || d?.items || d?.rows || d?.records || d?.data || [];
}

// ---- Kostprijs van een order in EUR ----
// NicheBay rekent een winkel af in de valuta van `store_currency` (USD of EUR; bij Drivemax USD).
// `store_pay_fee` staat dus in dollars, terwijl de rest van de app in euro's rekent.
// Omrekenen gaat met de ECB-dagkoers van de orderdatum (zelfde bron als de supplier-refunds);
// lukt dat niet, dan het eurobedrag dat NicheBay zelf meestuurt (`order_cost.eur`).
// Bij elke order wordt bijgehouden welke bron is gebruikt, zodat een noodkoers niet ongemerkt blijft.
const FX_FALLBACK = 0.92; // laatste redmiddel voor dollars, zelfde als bij de refunds
export type CostSrc = "eur" | "ecb" | "nichebay" | "nood" | "onbekend";
// De brontellers tellen alleen orders met een kostprijs; orders zonder kostprijs staan in zeroCost.
export type FxStats = Record<CostSrc, number> & { noDate: number; zeroCost: number };
function newFxStats(): FxStats {
  return { eur: 0, ecb: 0, nichebay: 0, nood: 0, onbekend: 0, noDate: 0, zeroCost: 0 };
}

function amsDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

// Tijdstip van een order in seconden (betaald, anders aangemaakt). NicheBay geeft seconden;
// milliseconden en de ISO-velden (paid_date/created_date) worden ook begrepen. 0 = onbekend.
function orderTs(o: any): number {
  const ok = (n: number) => (n > 1262304000 && n < 4102444800 ? n : 0); // tussen 2010 en 2100
  const sec = (v: any) => { let n = toNum(v); if (n > 1e11) n = Math.floor(n / 1000); return ok(n); };
  const iso = (v: any) => { const t = v ? Date.parse(String(v)) : NaN; return isNaN(t) ? 0 : ok(Math.floor(t / 1000)); };
  // eerst de betaaldatum (beide velden), dan de aanmaakdatum
  return sec(o?.paid_at) || iso(o?.paid_date) || sec(o?.created_at) || iso(o?.created_date) || 0;
}

// ecbOk = de koersen zijn voorgeladen (zie preloadFx). Is dat mislukt, dan wordt niet per order
// opnieuw geprobeerd. De waarde hoort bij één berekening en wordt daarom meegegeven, niet gedeeld.
export async function orderCostInfo(o: any, ecbOk = true): Promise<{ eur: number; src: CostSrc; noDate: boolean }> {
  const raw = toNum(pick(o, COST_FIELDS));
  if (raw <= 0) return { eur: 0, src: "eur", noDate: false };
  const cur = String(o?.store_currency || "").trim().toUpperCase();
  if (cur === "EUR") return { eur: raw, src: "eur", noDate: false };
  const nb = toNum(o?.order_cost?.eur);
  // geen valuta bij de order: niet gokken. Het eurobedrag van NicheBay als dat er is, anders het ruwe bedrag met een melding.
  if (!cur) return nb > 0 ? { eur: nb, src: "nichebay", noDate: false } : { eur: raw, src: "onbekend", noDate: false };
  const ts = orderTs(o);
  const noDate = ts === 0;
  if (ecbOk) {
    const eur = await toEUR(raw, cur, amsDay(new Date(noDate ? Date.now() : ts * 1000)));
    if (eur != null && eur > 0) return { eur, src: "ecb", noDate };
  }
  if (nb > 0) return { eur: nb, src: "nichebay", noDate };
  if (cur === "USD") return { eur: Math.round(raw * FX_FALLBACK * 100) / 100, src: "nood", noDate };
  return { eur: raw, src: "onbekend", noDate };
}

// Haalt de dollarkoersen van de laatste 200 dagen in één keer op (orders gaan zelden verder terug).
async function preloadFx(): Promise<boolean> {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10);
  return preloadRates("USD", from, to);
}

// Veiligheidsgrens voor het aantal pagina's (100 x 100 = 10.000 orders). De lus stopt eerder
// zodra NicheBay geen orders meer geeft. Is ook de laatste toegestane pagina vol, dan is niet
// bekend of er nog meer orders zijn: `truncated` meldt dat.
export const NB_MAX_PAGES = 100;

// Bouwt { '11547': kostprijs in EUR } over meerdere pagina's. Geeft ook een ruw sample-order terug
// zodat we de echte veldnamen kunnen verifiëren.
export async function fetchNicheBayCostByOrder(maxPages = NB_MAX_PAGES, limit = 100) {
  const map: Record<string, number> = {};
  const fx = newFxStats();
  let sample: any = null;
  let truncated = false;
  const ecbOk = await preloadFx();
  for (let page = 1; page <= maxPages; page++) {
    const j = await nbGet(`/orders?page=${page}&limit=${limit}`);
    const list = extractList(j);
    if (!Array.isArray(list) || list.length === 0) break;
    if (!sample) sample = list[0];
    for (const o of list) {
      const c = await orderCostInfo(o, ecbOk);
      if (c.eur > 0) { fx[c.src]++; if (c.noDate) fx.noDate++; } else fx.zeroCost++;
      const keys = new Set(
        [o.order_number, o.order_sn, pick(o, ORDER_NO_FIELDS)].map(normNo).filter(Boolean)
      );
      for (const k of keys) map[k] = c.eur;
    }
    if (list.length < limit) break;
    if (page === maxPages) truncated = true;
  }
  return { map, sample, fx, truncated };
}

// Probeert de gangbare endpoints om je wallet/accountsaldo te vinden.
const BALANCE_PATHS = ["/finances", "/finance", "/account", "/account/info", "/wallet", "/balance", "/user", "/user/info", "/userinfo", "/shop", "/shop/info", "/me"];
const BALANCE_FIELDS = ["balance", "available_balance", "wallet_balance", "account_balance", "saldo", "available", "amount", "remain", "remaining", "money", "wallet", "credit"];

function deepFindNumber(obj: any, fields: string[], depth = 0): { field: string; value: number } | null {
  if (!obj || typeof obj !== "object" || depth > 4) return null;
  for (const k of Object.keys(obj)) {
    const lk = k.toLowerCase();
    if (fields.some((f) => lk === f || lk.includes(f))) {
      const n = toNum(obj[k]);
      if (obj[k] != null && obj[k] !== "" && !isNaN(n)) return { field: k, value: n };
    }
  }
  for (const k of Object.keys(obj)) {
    const r = deepFindNumber(obj[k], fields, depth + 1);
    if (r) return r;
  }
  return null;
}

export async function nbProbeBalance() {
  const results: any[] = [];
  let found: { path: string; field: string; value: number } | null = null;
  for (const p of BALANCE_PATHS) {
    try {
      const res = await fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" }, cache: "no-store" });
      const text = await res.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch {}
      const guess = json ? deepFindNumber(json.data ?? json, BALANCE_FIELDS) : null;
      results.push({ path: p, status: res.status, ok: res.ok, body: text.slice(0, 400), guess });
      if (!found && res.ok && json && json.success !== false && guess) found = { path: p, ...guess };
    } catch (e: any) {
      results.push({ path: p, error: e.message });
    }
  }
  return { found, results };
}

// ---- Per-product COGS uit NicheBay order-regels ----
const LINE_ARRAY_FIELDS = ["items", "order_items", "orderItems", "goods", "goods_list", "goodsList", "products", "product_list", "productList", "details", "detail", "sku_list", "skuList", "line_items", "lineItems", "order_goods", "order_detail"];
const NAME_FIELDS = ["product_name", "productName", "goods_name", "goodsName", "name", "title", "product_title", "spu_name", "spuName", "goods_title"];
const SKU_FIELDS = ["sku", "sku_no", "skuNo", "sku_code", "skuCode", "variant_sku", "variantSku", "spu", "spu_no"];
const UNITCOST_FIELDS = ["unit_cost", "unitCost", "cost_price", "costPrice", "purchase_price", "purchasePrice", "unit_price", "unitPrice", "store_pay_fee", "pay_fee", "cost", "price", "settle_price", "settlePrice", "goods_cost", "product_cost"];
const QTY_FIELDS = ["quantity", "qty", "num", "count", "amount", "number"];

function findLineItems(order: any): any[] {
  for (const f of LINE_ARRAY_FIELDS) if (Array.isArray(order?.[f])) return order[f];
  // zoek 1 niveau diep
  for (const k of Object.keys(order || {})) {
    const v = order[k];
    if (Array.isArray(v) && v.length && typeof v[0] === "object") {
      if (v[0] && (pick(v[0], NAME_FIELDS) || pick(v[0], SKU_FIELDS))) return v;
    }
  }
  return [];
}

// ---- De producten van een order, waarover de orderkosten worden verdeeld ----
// - Geannuleerde aantallen (`cancelled_line_items`, bv. "Verzekerde verzending" die NicheBay niet verzendt) gaan eraf.
// - Gratis regels (prijs precies 0, bv. het e-book) krijgen geen eigen deel: hun kosten horen bij de betaalde producten.
//   Is zo'n gratis regel een fysiek cadeau (gewicht > 0), dan geldt de order als bundel en niet als losse prijs.
//   Een order met alleen gratis regels (bv. een vervangende zending) zegt niets over de prijs van een product: geen producten.
// - Meerdere regels van hetzelfde product worden samengevoegd; elke prijs blijft als waarneming bewaard.
// - Is een annulering niet te duiden (aantal ontbreekt), dan is `unsure` true en telt de order niet mee per product.
// Zonder dit lijkt elke order met verzekerde verzending een order met twee producten.
const LINE_PRICE_FIELDS = ["currency_price", "presentment_price", "price", "unit_price"];
const VARIANT_FIELDS = ["variant_id", "variantId", "variant_no", "shopify_variant_id", "sku_id", "skuId"];
const PRODUCTID_FIELDS = ["product_id", "productId", "shopify_product_id", "spu_id"];

export function nbNormName(s: string): string {
  return String(s || "").replace(/™|®/g, "").replace(/\s[–—|].*$/, "").replace(/\s-\s.*$/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function lineQty(li: any): number {
  return Math.max(1, toNum(pick(li, QTY_FIELDS)) || 1);
}

// prices = de prijs per stuk van elke regel van dit product (alleen bekende, betaalde prijzen)
export type OrderProduct = { key: string; name: string; sku: string; vid: string; qty: number; prices: number[]; value: number };
export type OrderProducts = { products: OrderProduct[]; bundle: boolean; unsure: boolean };

// De prijs van een regel: een getal, of null als er geen prijs bij staat (dat is iets anders dan gratis).
function linePrice(li: any): number | null {
  const v = pick(li, LINE_PRICE_FIELDS);
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? null : n;
}

export function orderProducts(order: any): OrderProducts {
  const NONE: OrderProducts = { products: [], bundle: false, unsure: false };
  const all = findLineItems(order).map((li: any) => ({
    id: String(li?.line_id ?? "").trim(),
    name: String(pick(li, NAME_FIELDS) || "").trim(),
    sku: String(pick(li, SKU_FIELDS) || "").trim(),
    vid: String(pick(li, VARIANT_FIELDS) || "").trim(),
    qty: lineQty(li),
    price: linePrice(li),
    weight: toNum(li?.estimated_weight),
  }));
  if (!all.length) return NONE;

  // 1. Geannuleerde aantallen eraf. Eerst de annuleringen met een regel-id (die raken alleen die regel),
  //    dan die op variant, dan die op naam. Nooit meer dan het geannuleerde aantal; aantal 0 annuleert
  //    niets; is het aantal geen heel getal van 0 of meer (of ontbreekt het), dan is de order niet te duiden.
  const cancelled = (Array.isArray(order?.cancelled_line_items) ? order.cancelled_line_items : []).map((c: any) => {
    const q = pick(c, QTY_FIELDS);
    const n = q != null && /^\d+$/.test(String(q).trim()) ? Number(String(q).trim()) : NaN;
    return {
      id: String(c?.line_id ?? "").trim(),
      vid: String(pick(c, VARIANT_FIELDS) || "").trim(),
      name: String(pick(c, NAME_FIELDS) || "").trim(),
      qty: n,
    };
  });
  if (cancelled.some((c: any) => !Number.isSafeInteger(c.qty) || c.qty < 0)) return { products: [], bundle: false, unsure: true };
  const rank = (c: any) => (c.id ? 0 : c.vid ? 1 : 2);
  cancelled.sort((x: any, y: any) => rank(x) - rank(y));
  for (const c of cancelled) {
    let left = c.qty;
    for (const l of all) {
      if (left <= 0) break;
      if (l.qty <= 0) continue;
      const hit = c.id ? l.id === c.id : c.vid ? l.vid === c.vid : !!c.name && l.name === c.name;
      if (!hit) continue;
      const used = Math.min(l.qty, left);
      l.qty -= used;
      left -= used;
    }
  }
  const live = all.filter((l) => l.qty > 0);
  if (!live.length) return NONE; // alles geannuleerd: geen producten

  // 2. Betaald (prijs > 0), gratis (prijs precies 0) en onbekend (geen prijs bij de regel).
  const paid = live.filter((l) => l.price != null && l.price > 0);
  const free = live.filter((l) => l.price != null && l.price <= 0);
  const unknown = live.filter((l) => l.price == null);
  if (!paid.length && !unknown.length) return NONE; // alleen gratis regels
  const bundle = free.some((l) => l.weight > 0);
  const use = paid.concat(unknown); // een regel zonder prijs telt naar aantal

  // 3. Samenvoegen per product.
  const byKey: Record<string, OrderProduct> = {};
  for (const l of use) {
    const key = l.vid ? "v:" + l.vid : l.sku ? "s:" + l.sku.toLowerCase() : l.name ? "n:" + nbNormName(l.name) : "";
    if (!key) continue;
    const p = byKey[key] || (byKey[key] = { key, name: l.name, sku: l.sku, vid: l.vid, qty: 0, prices: [], value: 0 });
    if (!p.name && l.name) p.name = l.name;
    p.qty += l.qty;
    if (l.price != null && l.price > 0) p.prices.push(l.price);
    p.value += l.qty * (l.price != null && l.price > 0 ? l.price : 1);
  }
  return { products: Object.values(byKey), bundle, unsure: false };
}

// ---- De inkoop per stuk van een product kiezen ----
// one   = recentste order met alleen dit product en precies 1 stuk: de prijs van één los stuk.
// clean = recentste order met alleen dit product (ook 2 of meer stuks, dan gedeeld door het aantal).
// any   = recentste order waarin het product zat (bij meer producten naar verkoopprijs verdeeld).
type CostAgg = { oneLast: number; oneDate: number; cleanLast: number; cleanDate: number; anyLast: number; anyDate: number };
function newAgg(): CostAgg {
  return { oneLast: 0, oneDate: 0, cleanLast: 0, cleanDate: 0, anyLast: 0, anyDate: 0 };
}
function addCost(a: CostAgg, unit: number, single: boolean, qty: number, when: number) {
  if (when >= a.anyDate) { a.anyDate = when; a.anyLast = unit; }
  if (single && when >= a.cleanDate) { a.cleanDate = when; a.cleanLast = unit; }
  if (single && qty === 1 && when >= a.oneDate) { a.oneDate = when; a.oneLast = unit; }
}
// Liefst de prijs van één los stuk. Is die meer dan 45 dagen ouder dan de nieuwste order van dit
// product, dan een recentere bron; `basis` en `date` zeggen welke prijs het is en van wanneer.
const STALE_SEC = 45 * 86400;
export type CostBasis = "single-item" | "meer-stuks" | "verdeeld";
function pickCost(a: CostAgg): { cost: number; date: number; basis: CostBasis } {
  const newest = Math.max(a.oneDate, a.cleanDate, a.anyDate);
  if (a.oneLast > 0 && a.oneDate >= newest - STALE_SEC) return { cost: a.oneLast, date: a.oneDate, basis: "single-item" };
  if (a.cleanLast > 0 && a.cleanDate >= newest - STALE_SEC) return { cost: a.cleanLast, date: a.cleanDate, basis: "meer-stuks" };
  return { cost: a.anyLast, date: a.anyDate, basis: "verdeeld" };
}
const round2 = (n: number) => Math.round(n * 100) / 100;
const dayOf = (sec: number) => (sec > 0 ? amsDay(new Date(sec * 1000)) : "");

export async function fetchNicheBayProductCosts(maxPages = 30, limit = 100) {
  const prod: Record<string, { name: string; sku: string; clean: number[]; alloc: number[]; last: number; lastDate: number }> = {};
  let sampleOrder: any = null;
  let sampleLine: any = null;
  let ordersSeen = 0;
  let skipped = 0;
  const ecbOk = await preloadFx();
  for (let page = 1; page <= maxPages; page++) {
    const j = await nbGet(`/orders?page=${page}&limit=${limit}`);
    const list = extractList(j);
    if (!Array.isArray(list) || list.length === 0) break;
    if (!sampleOrder) sampleOrder = list[0];
    for (const o of list) {
      ordersSeen++;
      const c = await orderCostInfo(o, ecbOk);
      const orderCost = c.eur; // totale inkoop van deze order, in EUR
      const { products, bundle, unsure } = orderProducts(o);
      const when = orderTs(o);
      if (orderCost > 0 && (unsure || c.src === "onbekend" || when === 0)) { skipped++; continue; } // niet te duiden: telt niet mee per product
      if (!products.length || orderCost <= 0) continue;
      if (!sampleLine) sampleLine = findLineItems(o)[0] || null;
      const single = products.length === 1 && !bundle;
      // gewicht per product = verkoopprijs × aantal
      const totW = products.reduce((t, x) => t + x.value, 0) || products.length;
      for (const pr of products) {
        const allocated = products.length === 1 ? orderCost : orderCost * (pr.value / totW);
        const unit = allocated / pr.qty;
        if (unit <= 0) continue;
        const key = (pr.sku || pr.name || pr.vid).toLowerCase();
        const p = prod[key] || (prod[key] = { name: pr.name || pr.sku, sku: pr.sku, clean: [], alloc: [], last: 0, lastDate: 0 });
        if (pr.name && !p.name) p.name = pr.name;
        if (single) p.clean.push(unit); else p.alloc.push(unit);
        if (when >= p.lastDate) { p.lastDate = when; p.last = unit; }
      }
    }
    if (list.length < limit) break;
  }
  const products = Object.values(prod).map((p) => {
    const src = p.clean.length ? p.clean : p.alloc;
    const avg = src.length ? src.reduce((a, b) => a + b, 0) / src.length : 0;
    return {
      name: p.name, sku: p.sku,
      avgCost: Math.round(avg * 100) / 100,
      lastCost: Math.round(p.last * 100) / 100,
      orders: p.clean.length + p.alloc.length,
      basis: p.clean.length ? "single-item" : "verdeeld",
    };
  }).sort((a, b) => b.avgCost - a.avgCost);
  return { products, ordersSeen, skipped, sampleOrder, sampleLine };
}

// ---- Productcatalogus-probe: zoekt het juiste endpoint voor huidige inkoopprijs per product ----
export async function nbCatalogProbe() {
  const candidates = [
    "/products?page=1&limit=5", "/product/list?page=1&limit=5", "/product?page=1&limit=5",
    "/goods?page=1&limit=5", "/goods/list?page=1&limit=5", "/goods/page?page=1&limit=5",
    "/store/products?page=1&limit=5", "/store/goods?page=1&limit=5",
    "/sku?page=1&limit=5", "/sku/list?page=1&limit=5", "/product/page?page=1&limit=5",
    "/spu?page=1&limit=5", "/spu/list?page=1&limit=5", "/catalog?page=1&limit=5",
  ];
  const results: any[] = [];
  for (const path of candidates) {
    try {
      const j = await nbGet(path);
      const list = extractList(j);
      results.push({
        path,
        ok: true,
        count: Array.isArray(list) ? list.length : 0,
        keys: list && list[0] ? Object.keys(list[0]) : (j?.data ? Object.keys(j.data) : Object.keys(j || {})),
        sample: (list && list[0]) || j?.data || j || null,
      });
      if (Array.isArray(list) && list.length) break; // gevonden
    } catch (e: any) {
      results.push({ path, ok: false, error: String(e.message).slice(0, 120) });
    }
  }
  return results;
}

// ---- Huidige inkoopprijs per product uit orders, in EUR (incl. tax via store_pay_fee) ----
// Geeft de inkoop per stuk per product, gekeyd op Shopify variant-id én op genormaliseerde naam.
export async function fetchNicheBayCurrentCosts(maxPages = 30, limit = 100) {
  type P = { name: string; variantId: string; cost: CostAgg; orders: number };
  const byVar: Record<string, P> = {};
  const byName: Record<string, P> = {};
  let ordersSeen = 0;
  let skipped = 0;
  const ecbOk = await preloadFx();
  const upd = (m: Record<string, P>, key: string, name: string, vid: string, unit: number, single: boolean, qty: number, when: number) => {
    const p = m[key] || (m[key] = { name, variantId: vid, cost: newAgg(), orders: 0 });
    if (name && !p.name) p.name = name;
    if (vid && !p.variantId) p.variantId = vid;
    p.orders++;
    addCost(p.cost, unit, single, qty, when);
  };
  for (let page = 1; page <= maxPages; page++) {
    const j = await nbGet(`/orders?page=${page}&limit=${limit}`);
    const list = extractList(j);
    if (!Array.isArray(list) || list.length === 0) break;
    for (const o of list) {
      ordersSeen++;
      const c = await orderCostInfo(o, ecbOk);
      const orderCost = c.eur;
      const { products, bundle, unsure } = orderProducts(o);
      const when = orderTs(o);
      if (orderCost > 0 && (unsure || c.src === "onbekend" || when === 0)) { skipped++; continue; }
      if (!products.length || orderCost <= 0) continue;
      const single = products.length === 1 && !bundle;
      const totW = products.reduce((t, x) => t + x.value, 0) || products.length;
      for (const pr of products) {
        const unit = (products.length === 1 ? orderCost : orderCost * (pr.value / totW)) / pr.qty;
        if (unit <= 0) continue;
        if (pr.vid) upd(byVar, pr.vid, pr.name, pr.vid, unit, single, pr.qty, when);
        if (pr.name) upd(byName, nbNormName(pr.name), pr.name, pr.vid, unit, single, pr.qty, when);
      }
    }
    if (list.length < limit) break;
  }
  const flat = (p: P) => {
    const c = pickCost(p.cost);
    return { name: p.name, variantId: p.variantId, cost: round2(c.cost), date: dayOf(c.date), orders: p.orders, basis: c.basis };
  };
  const outVar: Record<string, any> = {}; for (const [k, v] of Object.entries(byVar)) outVar[k] = flat(v);
  const outName: Record<string, any> = {}; for (const [k, v] of Object.entries(byName)) outName[k] = flat(v);
  return { byVariant: outVar, byName: outName, ordersSeen, skipped };
}

// ---- Marge per product PER LAND uit orders ----
// verkoop = meest voorkomende prijs per stuk in dat land (≈ listprijs, vóór korting), in EUR; betaalde de klant
//           in een andere valuta, dan omgerekend tegen de koers van vandaag (`sellCurrency` bewaart de valuta).
// cogs    = inkoop per stuk in EUR, zie pickCost (incl. tax en verzending via store_pay_fee).
export async function fetchNicheBayProductCountry(maxPages = 30, limit = 100) {
  type Agg = {
    name: string; variantId: string;
    sellCounts: Record<string, number>; // sleutel: "<valuta>|<prijs>"
    cost: CostAgg;
    orders: number; units: number;
  };
  const map: Record<string, Agg> = {}; // key = `${country}|${prodKey}`
  const countryOrders: Record<string, number> = {};
  let ordersSeen = 0;
  let skipped = 0;   // orders die niet (volledig) meetellen: valuta, datum of annulering niet te duiden
  let truncated = false;
  const ecbOk = await preloadFx();
  for (let page = 1; page <= maxPages; page++) {
    const j = await nbGet(`/orders?page=${page}&limit=${limit}`);
    const list = extractList(j);
    if (!Array.isArray(list) || list.length === 0) break;
    for (const o of list) {
      ordersSeen++;
      const c = await orderCostInfo(o, ecbOk);
      const orderCost = c.eur;
      const { products, bundle, unsure } = orderProducts(o);
      const when = orderTs(o);
      if (orderCost > 0 && (unsure || c.src === "onbekend" || when === 0)) { skipped++; continue; }
      if (!products.length || orderCost <= 0) continue;
      const cc = String(o?.address?.country || o?.country || "??").toUpperCase();
      // valuta waarin de klant betaalde; ontbreekt die, dan telt de verkoopprijs van deze order niet mee
      const cur = String(o?.currency || "").trim().toUpperCase();
      if (!cur) skipped++;
      const single = products.length === 1 && !bundle;
      countryOrders[cc] = (countryOrders[cc] || 0) + 1;
      const totW = products.reduce((t, x) => t + x.value, 0) || products.length;
      for (const pr of products) {
        const prodKey = pr.vid || "n:" + nbNormName(pr.name || pr.sku);
        const key = `${cc}|${prodKey}`;
        const a = map[key] || (map[key] = { name: pr.name || pr.vid, variantId: pr.vid, sellCounts: {}, cost: newAgg(), orders: 0, units: 0 });
        if (pr.name && !a.name) a.name = pr.name;
        if (pr.vid && !a.variantId) a.variantId = pr.vid;
        a.orders++;
        a.units += pr.qty;
        if (cur) for (const price of pr.prices) { const b = `${cur}|${price.toFixed(2)}`; a.sellCounts[b] = (a.sellCounts[b] || 0) + 1; }
        const cogsUnit = (products.length === 1 ? orderCost : orderCost * (pr.value / totW)) / pr.qty;
        if (cogsUnit > 0) addCost(a.cost, cogsUnit, single, pr.qty, when);
      }
    }
    if (list.length < limit) break;
    if (page === maxPages) truncated = true; // ook de laatste pagina was vol: er zijn mogelijk oudere orders
  }
  const mode = (m: Record<string, number>) => {
    let best = ""; let n = -1;
    for (const [k, v] of Object.entries(m)) if (v > n) { n = v; best = k; }
    const i = best.indexOf("|");
    return i < 0 ? { cur: "EUR", price: 0 } : { cur: best.slice(0, i), price: Number(best.slice(i + 1)) || 0 };
  };
  const today = new Date().toISOString().slice(0, 10);
  const rows: any[] = [];
  let fxMissing = 0; // rijen weggelaten omdat de verkoopprijs niet naar euro's kon
  for (const [key, a] of Object.entries(map)) {
    const cc = key.split("|")[0];
    const m = mode(a.sellCounts);
    let verkoop = m.price;
    if (m.cur !== "EUR" && verkoop > 0) {
      const v = await toEUR(verkoop, m.cur, today);
      // geen koers: niet met een verkeerd bedrag rekenen, wel melden. De rij blijft zonder verkoopprijs,
      // zodat de huidige Shopify-prijs hem nog kan invullen; lukt dat niet, dan valt hij daar weg.
      if (v == null) fxMissing++;
      verkoop = v ?? 0;
    }
    const c = pickCost(a.cost);
    rows.push({
      country: cc, name: a.name, variantId: a.variantId, currency: "EUR", sellCurrency: m.cur,
      verkoop: round2(verkoop),
      cogs: round2(c.cost), cogsDate: dayOf(c.date),
      basis: c.basis,
      orders: a.orders, units: a.units,
    });
  }
  const countries = Object.entries(countryOrders).map(([code, n]) => ({ code, orders: n })).sort((x, y) => y.orders - x.orders);
  return { rows, countries, ordersSeen, fxMissing, skipped, truncated };
}
