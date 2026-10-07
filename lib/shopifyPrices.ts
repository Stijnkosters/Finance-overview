import { shopifyGraphQL } from "@/lib/shopify";
import { toEUR } from "@/lib/fx";

// ============================================================
// Huidige verkoopprijs per variant per land, rechtstreeks uit Shopify (Markets).
// Zo volgt "Marge per product" een prijswijziging vanzelf, in plaats van te wachten
// tot de nieuwe prijs de meest voorkomende is in de orders.
// Sleutel: numeriek variant-id → landcode → prijs in EUR (plus het bedrag in de valuta van dat land).
// ============================================================

export type CurrentPrice = { eur: number; amount: number; currency: string };
export type CurrentPrices = Record<string, Record<string, CurrentPrice>>;
// notes = wat er niet (volledig) is opgehaald; de aanroeper toont dat bij de tabel.
export type PriceResult = { data: CurrentPrices; notes: string[]; at: number };

type Cfg = { store?: string; token?: string };
type Raw = Record<string, Record<string, { amount: number; currency: string }>>;

const TTL = 5 * 60 * 1000; // zo lang blijft een opgehaalde prijslijst in het geheugen; "Ververs nu" haalt direct op
const GROUP = 6;           // landen per vraag aan Shopify
const MAX_PAGES = 30;      // 30 x 100 varianten per groep
let cache: { key: string; res: PriceResult } | null = null;
const pending: Record<string, Promise<PriceResult>> = {}; // gelijktijdige aanvragen delen één ophaalactie

function buildQuery(countries: string[]) {
  // de landcodes zijn hierboven al beperkt tot twee hoofdletters
  const fields = countries
    .map((c) => `c_${c}: contextualPricing(context: {country: ${c}}) { price { amount currencyCode } }`)
    .join("\n      ");
  return `
query Prijzen($cursor: String) {
  productVariants(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      ${fields}
    }
  }
}`;
}

async function fetchRaw(cfg: Cfg, countries: string[], signal: AbortSignal, out: Raw): Promise<boolean> {
  const q = buildQuery(countries);
  let cursor: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const data: any = await shopifyGraphQL(q, { cursor }, cfg, signal);
    const conn = data?.productVariants;
    for (const v of conn?.nodes || []) {
      const id = String(v?.id || "").split("/").pop() || "";
      if (!id) continue;
      for (const c of countries) {
        const p = v?.[`c_${c}`]?.price;
        const amount = parseFloat(p?.amount);
        const currency = String(p?.currencyCode || "").toUpperCase();
        if (!(amount > 0) || !currency) continue; // prijs 0 of geen prijs: de rij houdt de prijs uit de orders
        (out[id] ||= {})[c] = { amount, currency };
      }
    }
    if (!conn?.pageInfo?.hasNextPage) return true;
    cursor = conn.pageInfo.endCursor;
  }
  return false; // de grens van MAX_PAGES bereikt: niet alle varianten gelezen
}

async function load(cfg: Cfg, list: string[], budgetMs: number): Promise<PriceResult> {
  const notes: string[] = [];
  const raw: Raw = {};
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), budgetMs); // één tijdslimiet voor alles samen
  const failed: string[] = [];
  let complete = true;
  try {
    for (let i = 0; i < list.length; i += GROUP) {
      const group = list.slice(i, i + GROUP);
      try {
        if (!(await fetchRaw(cfg, group, ctl.signal, raw))) complete = false;
      } catch (e) {
        if (ctl.signal.aborted) throw e;
        // Eén ongeldige landcode laat de hele vraag mislukken: dan per land, en alleen de landen die lukken.
        for (const c of group) {
          try {
            if (!(await fetchRaw(cfg, [c], ctl.signal, raw))) complete = false;
          } catch (e2) {
            if (ctl.signal.aborted) throw e2;
            failed.push(c);
          }
        }
      }
    }
  } catch (e: any) {
    if (ctl.signal.aborted) throw new Error(`Shopify antwoordde niet binnen ${Math.round(budgetMs / 1000)} seconden`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (failed.length === list.length) throw new Error("Shopify gaf voor geen enkel land prijzen terug");
  if (failed.length) notes.push(`geen prijzen voor ${failed.join(", ")}`);
  if (!complete) notes.push("niet alle varianten gelezen (meer dan 3.000)");

  const today = new Date().toISOString().slice(0, 10);
  const data: CurrentPrices = {};
  const noRate = new Set<string>();
  for (const [id, perCountry] of Object.entries(raw)) {
    for (const [c, p] of Object.entries(perCountry)) {
      const eur = p.currency === "EUR" ? p.amount : await toEUR(p.amount, p.currency, today);
      if (eur == null || !(eur > 0)) { noRate.add(p.currency); continue; } // geen koers: geen Shopify-prijs voor deze rij
      (data[id] ||= {})[c] = { eur: Math.round(eur * 100) / 100, amount: p.amount, currency: p.currency };
    }
  }
  if (noRate.size) notes.push(`geen wisselkoers voor ${[...noRate].join(", ")}`);
  return { data, notes, at: Date.now() };
}

// Elke aanroeper wacht hoogstens `ms`, ook op de omrekening van valuta en ook als hij aansluit bij een
// ophaalactie die al liep. De gedeelde ophaalactie zelf loopt door en vult daarna het geheugen.
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Shopify antwoordde niet binnen ${Math.round(ms / 1000)} seconden`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Haalt de huidige prijs per variant op voor de gevraagde landen, binnen `budgetMs`.
 * Lukt het niet binnen die tijd, of geeft Shopify niets terug, dan gooit dit een fout en
 * gebruikt de aanroeper de prijs uit de orders. Wat gedeeltelijk ontbreekt staat in `notes`.
 */
export async function fetchCurrentPrices(cfg: Cfg, countries: string[], fresh = false, budgetMs = 8000): Promise<PriceResult> {
  const list = [...new Set(countries.map((c) => String(c || "").trim().toUpperCase()))]
    .filter((c) => /^[A-Z]{2}$/.test(c))
    .sort();
  if (!list.length) return { data: {}, notes: [], at: Date.now() };
  const key = `${cfg.store || ""}:${list.join(",")}`;
  if (!fresh && cache && cache.key === key && Date.now() - cache.res.at < TTL) return cache.res;
  if (key in pending) return withDeadline(pending[key], budgetMs);
  const job = load(cfg, list, budgetMs)
    .then((res) => {
      if (!cache || cache.key !== key || res.at >= cache.res.at) cache = { key, res }; // een oudere uitkomst overschrijft geen nieuwere
      return res;
    })
    .finally(() => { delete pending[key]; });
  pending[key] = job;
  return withDeadline(job, budgetMs);
}
