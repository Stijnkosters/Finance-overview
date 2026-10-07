import { NextResponse } from "next/server";
import { computeProductMargins, applyOverrides } from "@/lib/productMargins";
import { readJson, writeJson, persistenceEnabled } from "@/lib/store";
import { fetchCurrentPrices, type CurrentPrices } from "@/lib/shopifyPrices";
import { getShop } from "@/lib/shops";
import { resolveShopifyCfg } from "@/lib/shopifyAuth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

let running = false;
let refreshWarning: string | null = null; // de laatste verversing op de achtergrond lukte niet (volledig)
const KEY = "product-margins-v3.json"; // v3: inkoop in EUR (was USD) → negeert oude cache, berekent 1x vers

// De huidige verkoopprijzen uit Shopify, bij elke keer laden (5 minuten in het geheugen; bij "Ververs nu" direct).
// Begrensd in tijd: bij een bestaande cache hoogstens 5 seconden, bij vers berekenen 10. Lukt het niet,
// dan blijft de prijs uit de orders staan en zegt `priceWarning` waarom; ontbreekt er een deel, dan ook.
async function livePrices(data: any, fresh: boolean, budgetMs: number): Promise<{ prices: CurrentPrices | null; priceWarning: string | null }> {
  try {
    const countries = [...new Set((data?.rows || []).map((r: any) => String(r.country || "")))] as string[];
    const cfg = await resolveShopifyCfg(getShop("drivemax"));
    const res = await fetchCurrentPrices(cfg, countries, fresh, budgetMs);
    return { prices: res.data, priceWarning: res.notes.length ? `Huidige prijzen uit Shopify onvolledig: ${res.notes.join("; ")}. Daar komt de verkoopprijs uit de orders.` : null };
  } catch (e: any) {
    return { prices: null, priceWarning: `Huidige prijzen uit Shopify niet opgehaald (${String(e?.message || e).slice(0, 120)}); de verkoopprijs komt uit de orders.` };
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const force = url.searchParams.get("refresh") === "1";

  let cache: any = null;
  try { cache = await readJson(KEY, null); } catch { cache = null; }
  const ageH = cache?.generatedAt ? (Date.now() - new Date(cache.generatedAt).getTime()) / 3600000 : Infinity;

  if (cache && !force) {
    if (ageH >= 12 && !running && persistenceEnabled()) {
      running = true;
      // een onvolledige berekening (koers ontbrak) overschrijft de cache niet; de melding blijft staan tot het wel lukt
      (async () => {
        try {
          const d = await computeProductMargins();
          if (d.fxMissing) refreshWarning = `Verversen lukte niet volledig (${d.fxMissing} rijen zonder wisselkoers); dit zijn de oudere cijfers.`;
          else { await writeJson(KEY, d); refreshWarning = null; }
        } catch (e: any) { refreshWarning = `Verversen mislukt (${String(e?.message || e).slice(0, 120)}); dit zijn de oudere cijfers.`; }
        finally { running = false; }
      })();
    }
    // overrides live toepassen op de gecachte basis-data
    const lp = await livePrices(cache, false, 5000);
    return NextResponse.json({ ...applyOverrides(cache, lp.prices), cached: true, ageHours: Math.round(ageH * 10) / 10, refreshWarning, priceWarning: lp.priceWarning });
  }

  try {
    const base = await computeProductMargins();
    if (persistenceEnabled() && !base.fxMissing) { try { await writeJson(KEY, base); refreshWarning = null; } catch {} }
    const lp = await livePrices(base, true, 10000);
    return NextResponse.json({ ...applyOverrides(base, lp.prices), cached: false, priceWarning: lp.priceWarning });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
