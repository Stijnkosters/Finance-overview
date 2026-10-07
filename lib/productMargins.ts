import { fetchNicheBayProductCountry, nichebayConfigured } from "@/lib/nichebay";
import overrides from "@/data/cogs-overrides.json";
import type { CurrentPrices } from "@/lib/shopifyPrices";

const FEE_RATE = 0.018;
const FEE_FIXED = 0.25;

// Basis-berekening zonder overrides — dit wordt gecachet.
export async function computeProductMargins() {
  if (!nichebayConfigured()) throw new Error("NICHEBAY_API_KEY ontbreekt.");
  // Zoekvenster: 30 pagina's = de 3.000 nieuwste orders. Is dat venster vol, dan meldt `truncated` dat.
  const { rows: raw, countries, ordersSeen, fxMissing, skipped, truncated } = await fetchNicheBayProductCountry(30, 100);
  const rows = raw
    // een rij zonder verkoopprijs uit de orders blijft: de huidige Shopify-prijs kan die nog invullen (zie applyOverrides)
    .filter((r) => r.cogs > 0)
    .map((r) => ({
      country: r.country, product: r.name, sku: r.variantId, currency: r.currency,
      sellCurrency: r.sellCurrency,
      verkoop: r.verkoop, cogs: r.cogs, cogsDate: r.cogsDate, orders: r.orders, units: r.units, basis: r.basis,
    }));
  return { generatedAt: new Date().toISOString(), ordersSeen, countries, count: rows.length, rows, fxMissing, skipped, truncated };
}

// Overrides, de huidige verkoopprijs en afgeleide velden — bij ELKE keer laden toegepast (ook op cache), dus altijd live.
// prices = de huidige prijs per variant per land uit Shopify. Staat er een prijs voor de rij, dan is dat de
// verkoopprijs (verkoopBron "shopify"); anders de meest voorkomende prijs uit de orders (verkoopBron "orders").
export function applyOverrides(data: any, prices?: CurrentPrices | null) {
  const hide = ((overrides as any).hideContains || []).map((s: string) => s.toLowerCase());
  const add: Record<string, number> = (overrides as any).addContains || {};
  let fromShopify = 0;
  const rows = (data?.rows || [])
    .filter((r: any) => {
      const nameL = String(r.product || "").toLowerCase();
      return !hide.some((h: string) => nameL.includes(h));
    })
    .map((r: any) => {
      const nameL = String(r.product || "").toLowerCase();
      let cogs = r.cogs;
      let adjusted = false;
      for (const [k, amt] of Object.entries(add)) {
        if (nameL.includes(k.toLowerCase())) { cogs = Math.round((cogs + amt) * 100) / 100; adjusted = true; }
      }
      const live = prices?.[String(r.sku || "")]?.[String(r.country || "")];
      const useLive = !!live && live.eur > 0;
      const verkoop = useLive ? live!.eur : r.verkoop;
      if (useLive) fromShopify++;
      const fees = Math.round((verkoop * FEE_RATE + FEE_FIXED) * 100) / 100;
      const winst = Math.round((verkoop - cogs - fees) * 100) / 100;
      const margePct = verkoop > 0 ? Math.round((winst / verkoop) * 1000) / 10 : null;
      const breakevenRoas = winst > 0 ? Math.round((verkoop / winst) * 100) / 100 : null;
      return {
        ...r, verkoop, verkoopOrders: r.verkoop, verkoopBron: useLive ? "shopify" : "orders",
        sellCurrency: useLive ? live!.currency : r.sellCurrency,
        cogs, fees, winst, margePct, breakevenRoas, adjusted,
      };
    })
    .filter((r: any) => r.verkoop > 0);
  rows.sort((a: any, b: any) => (a.country === b.country ? (b.breakevenRoas ?? -1) - (a.breakevenRoas ?? -1) : a.country < b.country ? -1 : 1));
  return { ...data, count: rows.length, rows, pricesFromShopify: fromShopify };
}
