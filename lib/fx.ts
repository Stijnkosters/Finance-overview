// Wisselkoersen via Frankfurter (ECB-dagkoersen, gratis, geen key).
// Zet een vreemd-valuta bedrag om naar EUR op de transactiedatum.
type Hit = { r: number | null; exp: number };
const cache: Record<string, Hit> = {};
const BASE = process.env.FX_API_BASE || "https://api.frankfurter.app";
const FAIL_TTL = 5 * 60 * 1000;   // mislukte koers: na 5 minuten opnieuw proberen
const FRESH_TTL = 60 * 60 * 1000; // koers van vandaag: kan nog die van de vorige handelsdag zijn
const TIMEOUT_MS = 8000;

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// Een koers van een afgesloten dag blijft staan; die van vandaag en een mislukte koers vervallen.
function put(key: string, date: string, r: number | null) {
  const exp = r == null ? Date.now() + FAIL_TTL : date >= todayUTC() ? Date.now() + FRESH_TTL : Infinity;
  cache[key] = { r, exp };
}

async function rateToEUR(currency: string, date: string): Promise<number | null> {
  const cur = (currency || "").toUpperCase();
  if (!cur || cur === "EUR") return 1;
  const key = `${date}:${cur}`;
  const hit = cache[key];
  if (hit && hit.exp > Date.now()) return hit.r;
  try {
    // Frankfurter geeft op weekend/feestdag automatisch de laatste beschikbare koers
    const res = await fetch(`${BASE}/${date}?from=${cur}&to=EUR`, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const j: any = await res.json().catch(() => ({}));
    const r = j?.rates?.EUR;
    put(key, date, typeof r === "number" ? r : null);
    return cache[key].r;
  } catch {
    put(key, date, null);
    return null;
  }
}

// Laadt in één aanroep alle dagkoersen van een periode en vult de cache. Weekend- en
// feestdagen krijgen de laatste koers ervoor. Scheelt een losse aanroep per orderdatum.
// Geeft false terug als de koersbron niet bereikbaar is of niets teruggeeft.
const rangeDone: Record<string, number> = {};
export async function preloadRates(currency: string, fromDate: string, toDate: string): Promise<boolean> {
  const cur = (currency || "").toUpperCase();
  if (!cur || cur === "EUR") return true;
  const key = `${cur}:${fromDate}:${toDate}`;
  if (rangeDone[key] && Date.now() - rangeDone[key] < FRESH_TTL) return true;
  try {
    const res = await fetch(`${BASE}/${fromDate}..${toDate}?from=${cur}&to=EUR`, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const j: any = await res.json().catch(() => ({}));
    const rates: Record<string, any> = j?.rates || {};
    const days = Object.keys(rates).sort();
    if (!days.length) return false;
    let last: number | null = null;
    let di = 0;
    const end = Date.parse(toDate + "T00:00:00Z");
    for (let t = Date.parse(fromDate + "T00:00:00Z"); t <= end; t += 86400000) {
      const d = new Date(t).toISOString().slice(0, 10);
      while (di < days.length && days[di] <= d) {
        const r = rates[days[di]]?.EUR;
        if (typeof r === "number") last = r;
        di++;
      }
      if (last != null) put(`${d}:${cur}`, d, last);
    }
    rangeDone[key] = Date.now();
    return true;
  } catch {
    return false;
  }
}

// Zet bedrag (met teken) om naar EUR. Lukt de koers niet, dan null (overslaan).
export async function toEUR(amount: number, currency: string, date: string): Promise<number | null> {
  const cur = (currency || "").toUpperCase();
  if (!cur || cur === "EUR") return amount;
  const rate = await rateToEUR(cur, date);
  if (rate == null) return null;
  return Math.round(amount * rate * 100) / 100;
}
