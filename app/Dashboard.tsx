"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine, Cell, PieChart, Pie,
} from "recharts";
import { TrendingUp, TrendingDown, LayoutDashboard, CalendarDays, Receipt, Wallet, RefreshCw, Upload, Trash2, Repeat, Package, ShoppingCart, LogOut } from "lucide-react";

const eur = (n: number) => new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(n || 0);

// Vaste terugval zodat de categorie-dropdowns nooit leeg zijn, ook als /api/data hapert.
const FALLBACK_CATEGORIES = [
  "Software", "AI/Tools", "Ads", "Agency", "Boekhouding",
  "Bankkosten", "Team", "Verzending", "Voorraad", "Leverancier betalingen", "Pandkosten", "Refund klant", "Transfer", "Privé", "Overig",
];
const numf = (n: number, d = 2) => new Intl.NumberFormat("nl-NL", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n || 0);
const pctf = (n: number) => `${(n * 100).toFixed(1).replace(".", ",")}%`;
const ddmm = (iso: string) => { const [, m, d] = iso.split("-"); return `${d}-${m}`; };
const ddmmyyyy = (iso: string) => { const [y, m, d] = iso.split("-"); return `${d}-${m}-${y}`; };

function rangeFor(period: string) {
  const to = new Date();
  const from = new Date();
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (period === "dezemaand") {
    const y = to.getFullYear(), m = to.getMonth();
    return { from: ymd(new Date(y, m, 1)), to: ymd(new Date(y, m + 1, 0)) };
  }
  if (period === "vandaag") { /* same day */ }
  else if (period === "week") from.setDate(to.getDate() - 6);
  else if (period === "maand") from.setDate(to.getDate() - 29);
  else if (period === "kwartaal") from.setDate(to.getDate() - 89);
  else if (period === "jaar") return { from: `${to.getFullYear()}-01-01`, to: ymd(to) };
  return { from: ymd(from), to: ymd(to) };
}

function lastMonths(n: number) {
  const out: any[] = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    const y = d.getFullYear(), m = d.getMonth();
    const first = new Date(y, m, 1), last = new Date(y, m + 1, 0);
    out.push({
      val: `${y}-${String(m + 1).padStart(2, "0")}`,
      label: first.toLocaleDateString("nl-NL", { month: "long", year: "numeric" }),
      from: `${y}-${String(m + 1).padStart(2, "0")}-01`,
      to: last.toISOString().slice(0, 10),
    });
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}
const MONTHS = lastMonths(12);
const EXCLUDED_CATS = ["Transfer", "Refund klant", "Refund", "Ads", "Marketing", "Leverancier betalingen"];
const EXP_COLS: [string, string, boolean][] = [
  ["date", "Datum", true], ["omschrijving", "Omschrijving", true], ["category", "Categorie", true],
  ["note", "Notitie", false], ["methode", "Methode", false], ["bedrag", "Bedrag", false],
];
const LOCKED_COLS = new Set(EXP_COLS.filter(([, , lock]) => lock).map(([k]) => k));

export default function Dashboard() {
  const [tab, setTab] = useState("overzicht");
  const [period, setPeriod] = useState("dezemaand");
  const [shop, setShop] = useState("drivemax");
  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");
  const [monthSel, setMonthSel] = useState("");
  const [expMonth, setExpMonth] = useState("");
  const [expSearch, setExpSearch] = useState("");
  const [expMethod, setExpMethod] = useState("");
  const [hiddenCols, setHiddenCols] = useState<string[]>([]);
  useEffect(() => { try { const s = localStorage.getItem("dmx_hiddencols"); if (s) setHiddenCols(JSON.parse(s)); } catch {} }, []);
  const toggleCol = (k: string) => setHiddenCols((h) => {
    if (LOCKED_COLS.has(k)) return h;
    const n = h.includes(k) ? h.filter((x) => x !== k) : [...h, k];
    try { localStorage.setItem("dmx_hiddencols", JSON.stringify(n)); } catch {}
    return n;
  });
  const showCol = (k: string) => LOCKED_COLS.has(k) || !hiddenCols.includes(k);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSel = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const clearSel = () => setSelected(new Set());
  const deleteSelected = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    if (!confirm(`${ids.length} transactie(s) verwijderen?`)) return;
    try {
      await fetch(`/api/expense`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
      clearSel();
      await reloadData();
    } catch {}
  };
  const [pl, setPl] = useState<any>(null);
  const [data, setData] = useState<any>({ expenses: [], liquid: [], openInvoices: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const getRange = () => (fromInput && toInput ? { from: fromInput, to: toInput } : rangeFor(period));

  const reqRef = useRef(0);
  const load = async () => {
    const myReq = ++reqRef.current;
    setLoading(true); setError(null);
    try {
      const { from, to } = getRange();
      const [r1, r2] = await Promise.all([
        fetch(`/api/pl?from=${from}&to=${to}&shop=${shop}`).then((r) => r.json()),
        fetch(`/api/data`).then((r) => r.json()),
      ]);
      // Verouderd antwoord? (shop/periode is intussen gewijzigd) → negeren.
      if (myReq !== reqRef.current) return;
      if (!r1.ok) throw new Error(r1.error || "P&L ophalen mislukt");
      setPl(r1); setData(r2);
    } catch (e: any) { if (myReq === reqRef.current) setError(e.message); }
    finally { if (myReq === reqRef.current) setLoading(false); }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [period, fromInput, toInput, shop]);


  const reloadData = async () => {
    try { const r = await fetch(`/api/data`).then((x) => x.json()); setData(r); } catch {}
  };
  const saveCat = async (e: any, category: string) => {
    setData((d: any) => ({ ...d, expenses: (d.expenses || []).map((x: any) => (x.id === e.id ? { ...x, category } : x)) }));
    try {
      await fetch(`/api/expense`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: e.id, mkey: e.mkey, category, remember: true }) });
      await reloadData();
    } catch {}
  };
  const saveNote = async (e: any, note: string) => {
    setData((d: any) => ({ ...d, expenses: (d.expenses || []).map((x: any) => (x.id === e.id ? { ...x, note } : x)) }));
    try {
      await fetch(`/api/expense`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: e.id, note, remember: false }) });
    } catch {}
  };
  const saveLabel = async (e: any, label: string) => {
    setData((d: any) => ({ ...d, expenses: (d.expenses || []).map((x: any) => (x.id === e.id ? { ...x, label } : x)) }));
    try {
      await fetch(`/api/expense`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: e.id, mkey: e.mkey, label, remember: true }) });
      await reloadData();
    } catch {}
  };

  const pickQuick = (v: string) => { setFromInput(""); setToInput(""); setMonthSel(""); setPeriod(v); };
  const pickMonth = (val: string) => {
    setMonthSel(val);
    const m = MONTHS.find((x) => x.val === val);
    if (m) { setFromInput(m.from); setToInput(m.to); }
  };
  const custom = !!(fromInput && toInput);

  const days = pl?.days || [];
  const countries = pl?.countries || [];
  const totals = pl?.totals || {};
  const [openRefund, setOpenRefund] = useState<string | null>(null);

  const NON_COST = EXCLUDED_CATS;
  const expensesInRange = useMemo(() => {
    if (!pl) return [];
    const { from, to } = pl.range;
    const inRange = (data.expenses || []).filter((e: any) => e.date >= from && e.date <= to && !NON_COST.includes(e.category));
    // Totaal: alle overhead. Losse shop: alleen de aan die shop getagde (directe) kosten.
    if (shop === "totaal") return inRange;
    return inRange.filter((e: any) => e.store === shop);
  }, [data, pl, shop]);
  const overhead = expensesInRange.reduce((a: number, e: any) => a + (e.bedrag || 0), 0) - expensesInRange.filter((e: any) => e.category === "Privé").reduce((a: number, e: any) => a + (e.bedrag || 0), 0);
  const prive = expensesInRange.filter((e: any) => e.category === "Privé").reduce((a: number, e: any) => a + (e.bedrag || 0), 0);

  const timeline = useMemo(() => {
    let cum = 0;
    const exByDay: Record<string, number> = {};
    expensesInRange.forEach((e: any) => { exByDay[e.date] = (exByDay[e.date] || 0) + (e.bedrag || 0); });
    return days.map((d: any) => {
      const net = d.totalProfit - (exByDay[d.date] || 0);
      cum += net;
      return { date: d.date, label: ddmm(d.date), dag: Math.round(net), cumulatief: Math.round(cum) };
    });
  }, [days, expensesInRange]);

  const netTotal = (totals.totalProfit || 0) - overhead - prive;
  const allTimeNet = timeline.length ? timeline[timeline.length - 1].cumulatief : 0;
  const up = allTimeNet >= 0;

  const liquid = (data.liquid || []).reduce((a: number, r: any) => a + (r.amount || 0), 0);
  const due = (data.openInvoices || []).reduce((a: number, r: any) => a + (r.amount || 0), 0);

  const costBreakdown = useMemo(() => {
    const items = [
      { key: "Productkosten (COGS)", val: totals.cogs || 0 },
      { key: "Advertentiekosten", val: totals.adspend || 0 },
      { key: "Overhead", val: overhead },
      { key: "Privé", val: prive },
      { key: "Refunds", val: totals.refunds || 0 },
      { key: "Shopify fees (schatting)", val: totals.fees || 0 },
    ].filter((i) => i.val > 0).sort((a, b) => b.val - a.val);
    const sum = items.reduce((a, i) => a + i.val, 0) || 1;
    return items.map((i) => ({ ...i, share: i.val / sum }));
  }, [totals, overhead, prive]);

  const byCategory = useMemo(() => {
    const m: Record<string, number> = {};
    expensesInRange.forEach((e: any) => { m[e.category || "Overig"] = (m[e.category || "Overig"] || 0) + (e.bedrag || 0); });
    const items = Object.entries(m).map(([key, val]) => ({ key, val: val as number })).sort((a, b) => b.val - a.val);
    const sum = items.reduce((a, i) => a + i.val, 0) || 1;
    return { items: items.map((i) => ({ ...i, share: i.val / sum })), total: items.reduce((a, i) => a + i.val, 0) };
  }, [expensesInRange]);

  return (
    <div>
      <header className="top">
        <div className="brand">
          <div className="logo">P&amp;L</div>
          <div>
            <div className="title">Drivemax Profit Cockpit</div>
            <div className="sub">Auto-COGS uit Shopify-orders</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="seg" onClick={load} title="Verversen" style={{ cursor: "pointer" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 13px" }}>
              <RefreshCw size={14} /> Verversen
            </span>
          </button>
          <button
            className="seg"
            onClick={async () => { await fetch("/api/login", { method: "DELETE" }); window.location.href = "/login"; }}
            title="Uitloggen"
            style={{ cursor: "pointer" }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 13px" }}>
              <LogOut size={14} /> Uitloggen
            </span>
          </button>
        </div>
      </header>

      <nav className="nav">
        {[
          ["overzicht", "Overzicht", LayoutDashboard],
          ["pl", "Dagelijkse P&L", CalendarDays],
          ["orders", "Per order", ShoppingCart],
          ["uitgaves", "Uitgaves", Receipt],
          ["vaste", "Vaste lasten", Repeat],
          ["marges", "Marge per product", Package],
          ["prijs", "Prijswijziging", TrendingUp],
          ["balans", "Vermogen", Wallet],
          ["import", "Koppelingen", Upload],
        ].map(([k, label, Icon]: any) => (
          <button key={k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>
            <Icon size={16} /> {label}
          </button>
        ))}
      </nav>

      {tab !== "uitgaves" && (
        <div className="shopbar">
          <div className="seg shopseg">
            {[["drivemax", "Drivemax"], ["homivo", "Homivo"], ["totaal", "Totaal"]].map(([v, l]) => (
              <button key={v} className={shop === v ? "on" : ""} onClick={() => setShop(v)}>{l}</button>
            ))}
          </div>
          <span className="shopnote">{shop === "totaal" ? "Alle shops + alle overhead" : "Per shop · incl. eigen getagde kosten"}</span>
        </div>
      )}

      <main className="main">
        <div className="row-between">
          <h2 className="h2">{tab === "overzicht" ? "Overzicht" : tab === "pl" ? "Dagelijkse P&L" : tab === "orders" ? "Per order" : tab === "uitgaves" ? "Uitgaves" : tab === "vaste" ? "Vaste lasten" : tab === "marges" ? "Marge per product" : tab === "prijs" ? "Prijswijziging" : tab === "balans" ? "Vermogen" : "Koppelingen"}</h2>
          {tab !== "import" && tab !== "uitgaves" && tab !== "marges" && tab !== "vaste" && tab !== "prijs" && (
            <div className="ctrls">
              <div className="seg">
                {[["dezemaand", "Deze maand"], ["vandaag", "Vandaag"], ["week", "Week"], ["maand", "30d"], ["kwartaal", "90d"], ["jaar", "Dit jaar"]].map(([v, l]) => (
                  <button key={v} className={!custom && period === v ? "on" : ""} onClick={() => pickQuick(v)}>{l}</button>
                ))}
              </div>
              <select className="msel" value={monthSel} onChange={(e) => pickMonth(e.target.value)}>
                <option value="">Maand…</option>
                {MONTHS.map((m) => <option key={m.val} value={m.val}>{m.label}</option>)}
              </select>
              <input className="dinp" type="date" value={fromInput} onChange={(e) => { setMonthSel(""); setFromInput(e.target.value); }} />
              <span className="dim">→</span>
              <input className="dinp" type="date" value={toInput} onChange={(e) => { setMonthSel(""); setToInput(e.target.value); }} />
            </div>
          )}
          {tab === "uitgaves" && (
            <div className="ctrls">
              <input
                className="dinp expsearch"
                type="text"
                placeholder="Zoek op omschrijving…"
                value={expSearch}
                onChange={(e) => setExpSearch(e.target.value)}
              />
              {expSearch && <button className="clrbtn" onClick={() => setExpSearch("")}>×</button>}
              <select className="msel" value={expMethod} onChange={(e) => setExpMethod(e.target.value)}>
                <option value="">Alle methodes</option>
                {(Array.from(new Set((data.expenses || []).map((e: any) => e.methode).filter(Boolean))).sort() as string[]).map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <select className="msel" value={expMonth} onChange={(e) => setExpMonth(e.target.value)}>
                <option value="">Alle maanden</option>
                {MONTHS.map((m) => <option key={m.val} value={m.val}>{m.label}</option>)}
              </select>
            </div>
          )}
        </div>
        {pl && (tab === "overzicht" || tab === "pl") && (
          <div className="rangelbl dim">Periode: {ddmmyyyy(pl.range.from)} – {ddmmyyyy(pl.range.to)}</div>
        )}

        {error && tab !== "import" && <div className="banner err">Fout: {error}. Check je env vars in Railway.</div>}
        {loading && tab !== "import" && <div className="loading">Data ophalen…</div>}

        {!loading && !error && pl && (
          <>
            {pl.cogsWarning && tab === "overzicht" && (
              <div className="banner warn">{pl.cogsWarning}</div>
            )}
            {pl.cogsSource === "nichebay" && tab === "overzicht" && (
              <div className={`banner ${(pl.ordersNoCost || 0) > 0 ? "warn" : "info"}`}>
                COGS uit NicheBay · {pl.nbMatched}/{pl.orderCount} orders met echte kostprijs.
                {(pl.nbZero || 0) > 0 && ` ${pl.nbZero} orders gaven €0 bij NicheBay (nog niet gefactureerd) → teruggevallen op je eigen inkoopprijzen.`}
                {(pl.ordersNoCost || 0) > 0 && ` ⚠️ ${pl.ordersNoCost} orders hebben €0 COGS (geen NicheBay-kost én geen prijs in costs.json) → je winst is te hoog. Vul de inkoopprijzen aan.`}
                {pl.nbMatched === 0 && (pl.nbZero || 0) === 0 && " Geen matches — open /api/nichebay om de veldnamen te checken."}
              </div>
            )}
            {pl.adWarning && tab === "overzicht" && (
              <div className="banner warn">{pl.adWarning}</div>
            )}
            {pl.cogsSource !== "nichebay" && pl.missingCosts?.length > 0 && tab === "overzicht" && (
              <div className="banner warn">
                {pl.missingCosts.length} producten hebben nog geen inkoopprijs in <b>costs.json</b> → hun COGS telt als €0. Vul ze in voor een kloppende winst.
              </div>
            )}
            {pl.unmatched?.length > 0 && tab === "overzicht" && (
              <div className="banner info">
                {pl.unmatched.length} verkochte variant(en) staan niet in costs.json (bijv. nieuwe producten). Voeg hun variant-GID toe.
              </div>
            )}

            {tab === "overzicht" && (
              <>
                <section className={`hero ${up ? "up" : "down"}`}>
                  <div>
                    <div className="hero-label">Netto resultaat · {pl.range.from} t/m {pl.range.to}</div>
                    <div className="hero-value">
                      {up ? <TrendingUp size={28} /> : <TrendingDown size={28} />}
                      <span>{eur(netTotal)}</span>
                    </div>
                    <div className="hero-note">{up ? "In de plus." : "In de min — kosten drukken."} P&L-winst {eur(totals.totalProfit || 0)} − overhead {eur(overhead)} − privé {eur(prive)}.</div>
                  </div>
                  <div>
                    <ResponsiveContainer width="100%" height={120}>
                      <AreaChart data={timeline} margin={{ top: 6, right: 4, left: 4, bottom: 0 }}>
                        <defs>
                          <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={up ? "#0E8A52" : "#CE2C2C"} stopOpacity={0.35} />
                            <stop offset="100%" stopColor={up ? "#0E8A52" : "#CE2C2C"} stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <ReferenceLine y={0} stroke="rgba(255,255,255,.4)" strokeDasharray="3 3" />
                        <Tooltip content={<TipCum />} />
                        <Area type="monotone" dataKey="cumulatief" stroke={up ? "#0E8A52" : "#CE2C2C"} strokeWidth={2.5} fill="url(#g)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </section>

                <div className="kpis">
                  <Kpi label="Omzet" value={eur(totals.omzet || 0)} sub={`waarvan ${eur(totals.btw || 0)} btw`} />
                  <Kpi label={`COGS${pl.cogsSource === "nichebay" ? " · NicheBay" : " · handmatig"}`} value={eur(totals.cogs || 0)} tone="down" />
                  <Kpi
                    label={`Ad spend${pl.adSource && pl.adSource !== "manual" ? ` · ${pl.adSource}` : ""}`}
                    value={eur(totals.adspend || 0)}
                    sub={pl.adBreakdown && (pl.adBreakdown.bing > 0 || pl.adBreakdown.google > 0) ? `G ${eur(pl.adBreakdown.google || 0)} · B ${eur(pl.adBreakdown.bing || 0)}` : undefined}
                  />
                  <Kpi label="P&L winst" value={eur(totals.totalProfit || 0)} tone={(totals.totalProfit || 0) >= 0 ? "up" : "down"} />
                  <Kpi label="Netto na overhead" value={eur(netTotal)} tone={netTotal >= 0 ? "up" : "down"} />
                  <Kpi label="Orders / units" value={`${totals.orders || 0} / ${totals.units || 0}`} />
                  <Kpi label="AOV (gem. orderwaarde)" value={eur(totals.aov || 0)} sub={`max CPA ${eur(totals.maxCpa || 0)}`} />
                  <Kpi label="Winst / order" value={eur(totals.profitPerOrder || 0)} tone={(totals.profitPerOrder || 0) >= 0 ? "up" : "down"} sub={`${eur(totals.cacPerOrder || 0)} ad/order`} />
                  <Kpi
                    label="ROAS (deze periode)"
                    value={(totals.adspend || 0) > 0 ? `${numf(totals.roas || 0, 2)}×` : "—"}
                    tone={(totals.adspend || 0) > 0 ? ((totals.roas || 0) >= (totals.breakevenRoas || 0) ? "up" : "down") : undefined}
                    sub={(totals.breakevenRoas || 0) > 0 ? `break-even ${numf(totals.breakevenRoas, 2)}×` : undefined}
                  />
                  <Kpi
                    label="Break-even ROAS"
                    value={(totals.breakevenRoas || 0) > 0 ? `${numf(totals.breakevenRoas, 2)}×` : "—"}
                    sub={(totals.marginPct || 0) > 0 ? `marge ${numf(totals.marginPct, 1)}%` : undefined}
                  />
                </div>

                <Card title="Klantwaarde (LTV)" subtitle={`over ${ddmmyyyy(pl.range.from)} – ${ddmmyyyy(pl.range.to)}`}>
                  <div className="kpis">
                    <Kpi label="LTV (winst per klant)" value={eur(totals.ltv || 0)} tone="up" sub={`${eur(totals.revenuePerCustomer || 0)} omzet/klant`} />
                    <Kpi label="Unieke klanten" value={`${totals.uniqueCustomers || 0}`} />
                    <Kpi label="Herhaalaankopen" value={`${numf(totals.repeatRate || 0, 1)}%`} sub={`${numf(totals.ordersPerCustomer || 0, 2)} orders/klant`} />
                    <Kpi label="Refund-ratio" value={`${numf(totals.refundRate || 0, 1)}%`} tone={(totals.refundRate || 0) > 5 ? "down" : undefined} />
                  </div>
                  <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                    LTV = gemiddelde winst (dekkingsbijdrage) per klant in deze periode. Voor een échte LTV kies je een langere periode (bijv. 90d of een heel jaar) — dan zie je hoeveel klanten terugkomen. Komt LTV ruim boven je CAC ({eur(totals.cacPerOrder || 0)}/order)? Dan kun je meer voor klanten betalen en agressiever schalen.
                  </p>
                </Card>

                {((pl.adBreakdown?.google || 0) + (pl.adBreakdown?.bing || 0)) > 0 && (() => {
                  const g = pl.adBreakdown?.google || 0, b = pl.adBreakdown?.bing || 0;
                  const gc = pl.adConvValue?.google || 0, bc = pl.adConvValue?.bing || 0;
                  const totSpend = g + b, totConv = gc + bc;
                  const roas = (conv: number, spend: number) => (spend > 0 ? conv / spend : 0);
                  const mer = totSpend > 0 ? (totals.omzet || 0) / totSpend : 0;
                  const row = (naam: string, spend: number, conv: number, hasConv: boolean) => (
                    <tr>
                      <td className="nowrap strong">{naam}</td>
                      <td className="r mono">{eur(spend)}</td>
                      <td className="r mono dim">{totSpend > 0 ? `${numf((spend / totSpend) * 100, 0)}%` : "—"}</td>
                      <td className="r mono">{hasConv ? eur(conv) : "—"}</td>
                      <td className="r mono strong">{hasConv && spend > 0 ? `${numf(roas(conv, spend))}×` : "n.b."}</td>
                    </tr>
                  );
                  return (
                    <Card title="ROAS per kanaal" subtitle="platform-gemeten conversiewaarde ÷ ad spend">
                      <div className="table-wrap">
                        <table className="table">
                          <thead><tr><th>Kanaal</th><th className="r">Ad spend</th><th className="r">Aandeel</th><th className="r">Conversiewaarde</th><th className="r">ROAS</th></tr></thead>
                          <tbody>
                            {row("Google", g, gc, gc > 0)}
                            {row("Bing", b, bc, bc > 0)}
                            <tr style={{ borderTop: "2px solid var(--line)" }}>
                              <td className="nowrap strong">Samen</td>
                              <td className="r mono strong">{eur(totSpend)}</td>
                              <td className="r mono dim">100%</td>
                              <td className="r mono strong">{totConv > 0 ? eur(totConv) : "—"}</td>
                              <td className="r mono strong">{totConv > 0 ? `${numf(roas(totConv, totSpend))}×` : "n.b."}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                      <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                        ROAS per kanaal = de <b>conversiewaarde die het platform zelf meet</b> ÷ de spend van dat kanaal (Shopify kan omzet niet aan een kanaal toewijzen, dus dit is de platform-ROAS). Ter vergelijking: je blended <b>MER</b> (totale omzet ÷ totale ad spend) = <b>{numf(mer)}×</b>.
                        {bc === 0 && b > 0 && <> <br /><b>Bing:</b> conversiewaarde is er nog niet — die komt binnen zodra de Bing-cache opnieuw is gesynct (met de nieuwe Revenue-kolom).</>}
                      </p>
                    </Card>
                  );
                })()}

                <div className="grid2">
                  <Card title="Waar gaat je geld heen">
                    <div className="breakdown">
                      {costBreakdown.length === 0 && <div className="muted">Nog geen kosten.</div>}
                      {costBreakdown.map((c) => (
                        <div key={c.key}>
                          <div className="bd-head"><span>{c.key}</span><span className="mono">{eur(c.val)} · {pctf(c.share)}</span></div>
                          <div className="bar"><div className="bar-fill" style={{ width: `${c.share * 100}%` }} /></div>
                        </div>
                      ))}
                    </div>
                  </Card>
                  <Card title="Cashpositie" subtitle="uit accounts.json">
                    <div className="cash">
                      <div className="cash-row"><span>Liquide middelen</span><b className="mono">{eur(liquid)}</b></div>
                      <div className="cash-row"><span>Openstaand</span><b className="mono amber">{eur(due)}</b></div>
                      <div className="cash-div" />
                      <div className="cash-row big"><span>Netto positie</span><b className={`mono ${liquid - due >= 0 ? "green" : "red"}`}>{eur(liquid - due)}</b></div>
                    </div>
                  </Card>
                </div>

                {(() => {
                  const bruto = pl.totals.totalProfit || 0;
                  const bizExp = expensesInRange.filter((e: any) => e.category !== "Privé");
                  const sumE = (arr: any[]) => arr.reduce((a: number, e: any) => a + (e.bedrag || 0), 0);
                  const ohGeneral = sumE(bizExp.filter((e: any) => e.store !== "drivemax" && e.store !== "homivo"));
                  const ohTag = (s: string) => sumE(bizExp.filter((e: any) => e.store === s));
                  const ohTotal = sumE(bizExp);
                  const perShop = pl.perShop || [];
                  const totalRev = pl.totals.omzet || 0;
                  const nettoTotal = bruto - ohTotal;
                  const ohScope = shop === "drivemax" ? ohTag("drivemax") + ohGeneral : shop === "homivo" ? ohTag("homivo") + ohGeneral : ohTotal;
                  const nettoScope = bruto - ohScope;
                  const priveAll = (data.expenses || []).filter((e: any) => e.category === "Privé" && e.date >= pl.range.from && e.date <= pl.range.to).reduce((a: number, e: any) => a + (e.bedrag || 0), 0);
                  return (
                    <Card title="Nettowinst na overhead" subtitle="omzet − COGS − ads − fees − refunds − overhead (excl. privé)">
                      {perShop.length > 1 ? (
                        <div className="table-wrap">
                          <table className="table">
                            <thead><tr><th>Shop</th><th className="r">Omzet</th><th className="r">Bruto</th><th className="r">Overhead</th><th className="r">Netto</th><th className="r">Marge%</th></tr></thead>
                            <tbody>
                              {perShop.map((s: any) => {
                                const rev = s.totals.omzet || 0;
                                const share = totalRev > 0 ? rev / totalRev : 0;
                                const oh = ohTag(s.id) + ohGeneral * share;
                                const b = s.totals.totalProfit || 0;
                                const netto = b - oh;
                                return (
                                  <tr key={s.id}>
                                    <td>{s.name}</td>
                                    <td className="r mono">{eur(rev)}</td>
                                    <td className="r mono">{eur(b)}</td>
                                    <td className="r mono dim">{eur(oh)}</td>
                                    <td className={`r mono strong ${netto >= 0 ? "green" : "red"}`}>{eur(netto)}</td>
                                    <td className={`r mono ${netto >= 0 ? "green" : "red"}`}>{rev > 0 ? numf((netto / rev) * 100, 1) + "%" : "—"}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                            <tfoot>
                              <tr>
                                <td>Totaal</td>
                                <td className="r mono">{eur(totalRev)}</td>
                                <td className="r mono">{eur(bruto)}</td>
                                <td className="r mono">{eur(ohTotal)}</td>
                                <td className={`r mono strong ${nettoTotal >= 0 ? "green" : "red"}`}>{eur(nettoTotal)}</td>
                                <td className={`r mono strong ${nettoTotal >= 0 ? "green" : "red"}`}>{totalRev > 0 ? numf((nettoTotal / totalRev) * 100, 1) + "%" : "—"}</td>
                              </tr>
                            </tfoot>
                          </table>
                          <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>Getagde kosten gaan naar hun shop; algemene kosten ({eur(ohGeneral)}) zijn pro-rata naar omzet verdeeld.</p>
                          {priveAll > 0 && (
                            <div className="cash" style={{ marginTop: 12 }}>
                              <div className="cash-row"><span>Zakelijke nettowinst</span><b className={`mono ${nettoTotal >= 0 ? "green" : "red"}`}>{eur(nettoTotal)}</b></div>
                              <div className="cash-row"><span>Privé opgenomen</span><b className="mono amber">−{eur(priveAll)}</b></div>
                              <div className="cash-div" />
                              <div className="cash-row big"><span>Over na privé</span><b className={`mono ${(nettoTotal - priveAll) >= 0 ? "green" : "red"}`}>{eur(nettoTotal - priveAll)}</b></div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="cash">
                          <div className="cash-row"><span>Bruto (winst vóór overhead)</span><b className="mono">{eur(bruto)}</b></div>
                          <div className="cash-row"><span>Overhead (excl. privé)</span><b className="mono red">−{eur(ohScope)}</b></div>
                          <div className="cash-div" />
                          <div className="cash-row big"><span>Nettowinst</span><b className={`mono ${nettoScope >= 0 ? "green" : "red"}`}>{eur(nettoScope)}</b></div>
                          {priveAll > 0 && <>
                            <div className="cash-row"><span>Privé opgenomen <span className="dim">(heel bedrijf)</span></span><b className="mono amber">−{eur(priveAll)}</b></div>
                            <div className="cash-div" />
                            <div className="cash-row big"><span>Over na privé</span><b className={`mono ${(nettoScope - priveAll) >= 0 ? "green" : "red"}`}>{eur(nettoScope - priveAll)}</b></div>
                          </>}
                          <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>Alleen je directe (aan deze shop getagde) kosten. Op <b>Totaal</b> worden de algemene kosten pro-rata bijgeteld. Privé is geen bedrijfskost en telt niet in de nettowinst.</p>
                        </div>
                      )}
                    </Card>
                  );
                })()}

                <Card title="Uitgaven per categorie" subtitle={`overhead · transfers niet meegeteld · totaal ${eur(byCategory.total)}`}>
                  <div className="breakdown">
                    {byCategory.items.length === 0 && <div className="muted">Geen overhead in deze periode. Kies een maand of importeer je bankafschrift.</div>}
                    {byCategory.items.map((c) => (
                      <div key={c.key}>
                        <div className="bd-head"><span>{c.key}</span><span className="mono">{eur(c.val)} · {pctf(c.share)}</span></div>
                        <div className="bar"><div className="bar-fill alt" style={{ width: `${c.share * 100}%` }} /></div>
                      </div>
                    ))}
                  </div>
                </Card>

                <Card title="Resultaat per dag" subtitle="netto (P&L − overhead)">
                  {timeline.length === 0 ? <div className="muted">Geen orders in deze periode.</div> : (
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={timeline}>
                        <CartesianGrid vertical={false} stroke="#EEF0F4" />
                        <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#8A909C" }} tickLine={false} axisLine={false} />
                        <YAxis tick={{ fontSize: 11, fill: "#8A909C" }} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => (v / 1000).toFixed(0) + "k"} />
                        <ReferenceLine y={0} stroke="#C9CDD6" />
                        <Tooltip content={<TipDag />} cursor={{ fill: "rgba(58,63,214,.05)" }} />
                        <Bar dataKey="dag" radius={[3, 3, 0, 0]}>
                          {timeline.map((d, i) => <Cell key={i} fill={d.dag >= 0 ? "#0E8A52" : "#CE2C2C"} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </Card>
              </>
            )}

            {tab === "pl" && (<>
              <Card title="Dagelijkse P&L" subtitle={`${days.length} dagen · btw informatief, niet van de winst af`}>
                  {(() => {
                    const missDays = days.filter((d: any) => (d.noCost || 0) > 0);
                    const missOrders = missDays.reduce((a: number, d: any) => a + (d.noCost || 0), 0);
                    return missDays.length > 0 ? (
                      <div className="banner warn" style={{ marginBottom: 12 }}>
                        ⚠ <b>Some cogs are missing.</b> {missOrders} order(s) op {missDays.length} dag(en) hebben nog geen inkoop-COGS — upload de bijbehorende Win-Win factuur (Koppelingen-tab). Tot die tijd is de winst op die dagen te hoog.
                      </div>
                    ) : null;
                  })()}
                  {(totals.supplierRefunds || 0) > 0 && (
                    <div className="banner info" style={{ marginBottom: 12 }}>
                      <b>Terug van leverancier</b> (NicheBay): €{numf(totals.supplierRefunds || 0)} verrekend (USD→EUR dagkoers). Klant-refunds bruto €{numf(totals.refundsGross || 0)} → <b>netto refund-kost €{numf(totals.refunds || 0)}</b>. Winst, marge en break-even hieronder zijn <b>netto</b>. <span className="dim">De dag-rijen tonen de bruto klant-refunds, dus de TOTAAL-regel wijkt bewust €{numf(totals.supplierRefunds || 0)} af van de som van de dagen.</span>
                    </div>
                  )}
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Datum</th><th className="r">Orders</th><th className="r">AOV</th>
                          <th className="r">Omzet</th><th className="r">BTW</th><th className="r">Refunds</th>
                          <th className="r">COGS</th><th className="r">Fees</th><th className="r">Ad</th>
                          <th className="r">Gross</th><th className="r">Winst</th><th className="r">Marge %</th>
                          <th className="r">ROAS</th><th className="r">Break-even</th>
                        </tr>
                      </thead>
                      <tbody>
                        {days.length === 0 && <tr><td colSpan={14} className="dim center">Geen orders.</td></tr>}
                        {days.map((d: any) => {
                          const cm = (d.omzet || 0) - (d.cogs || 0) - (d.fees || 0) - (d.refunds || 0);
                          const be = cm > 0 ? d.revenue / cm : null;
                          const roasOk = be != null && d.roas ? d.roas >= be : null;
                          const refList = d.refundList || [];
                          const refOpen = openRefund === d.date;
                          return (
                          <Fragment key={d.date}>
                          <tr>
                            <td className="nowrap">{ddmmyyyy(d.date)}</td>
                            <td className="r mono">{d.orders}</td>
                            <td className="r mono">{d.orders ? eur(d.aov) : "—"}</td>
                            <td className="r mono">{eur(d.omzet)}</td>
                            <td className="r mono amber">{d.btw ? eur(d.btw) : "—"}</td>
                            <td className="r mono dim">
                              {d.refunds
                                ? (refList.length
                                    ? <button type="button" className={`refbtn ${refOpen ? "open" : ""}`} onClick={() => setOpenRefund(refOpen ? null : d.date)} title="Bekijk welke klanten refund kregen">{eur(d.refunds)} <span className="refcaret">{refOpen ? "▲" : "▼"}</span></button>
                                    : eur(d.refunds))
                                : "—"}
                            </td>
                            <td className="r mono">
                              {eur(d.cogs)}
                              {d.noCost > 0 && (
                                <span
                                  className="amber"
                                  title={`${d.noCost} van ${d.orders} orders heeft nog geen inkoop-COGS (factuur nog niet geüpload). Some cogs are missing.`}
                                  style={{ marginLeft: 6, cursor: "help", fontSize: 12 }}
                                >⚠ {d.noCost}</span>
                              )}
                            </td>
                            <td className="r mono dim">{eur(d.fees)}</td>
                            <td className="r mono">{d.adspend ? eur(d.adspend) : "—"}</td>
                            <td className="r mono">{eur(d.grossProfit)}</td>
                            <td className={`r mono strong ${d.totalProfit >= 0 ? "green" : "red"}`}>{eur(d.totalProfit)}</td>
                            <td className={`r mono ${d.margePct >= 0 ? "green" : "red"}`}>{d.omzet ? `${numf(d.margePct, 1)}%` : "—"}</td>
                            <td className={`r mono ${roasOk === null ? "" : roasOk ? "green" : "red"}`}>{d.roas ? numf(d.roas) : "—"}</td>
                            <td className="r mono dim">{be != null ? numf(be) : "—"}</td>
                          </tr>
                          {refOpen && refList.length > 0 && (
                            <tr className="refdetail">
                              <td colSpan={14}>
                                <div className="refdetail-wrap">
                                  <div className="refdetail-head">Refunds op {ddmmyyyy(d.date)} · {refList.length} {refList.length > 1 ? "klanten" : "klant"}</div>
                                  {refList.map((r: any, i: number) => (
                                    <div className="refrow" key={i}>
                                      <span className="refcust">{r.customer}{pl?.shop === "totaal" && r.shop ? <span className="dim"> · {r.shop}</span> : null}</span>
                                      <span className="reforder dim">{r.order ? `#${r.order}` : ""}</span>
                                      <span className="refamt mono">{eur(r.amount)}</span>
                                      {r.email
                                        ? <a className="refmail" href={`mailto:${r.email}`} title="Mail deze klant">{r.email}</a>
                                        : <span className="refmail dim">geen e-mail</span>}
                                    </div>
                                  ))}
                                </div>
                              </td>
                            </tr>
                          )}
                          </Fragment>
                        );})}
                      </tbody>
                      {days.length > 0 && (
                        <tfoot>
                          <tr>
                            <td>TOTAAL</td>
                            <td className="r mono">{totals.orders}</td>
                            <td className="r mono">{eur(totals.aov || 0)}</td>
                            <td className="r mono">{eur(totals.omzet || 0)}</td>
                            <td className="r mono amber">{eur(totals.btw || 0)}</td>
                            <td className="r mono" title={(totals.supplierRefunds || 0) > 0 ? `Netto: bruto €${numf(totals.refundsGross || 0)} − €${numf(totals.supplierRefunds || 0)} terug van leverancier` : undefined}>{eur(totals.refunds)}{(totals.supplierRefunds || 0) > 0 ? " *" : ""}</td>
                            <td className="r mono">{eur(totals.cogs)}</td>
                            <td className="r mono">{eur(totals.fees)}</td>
                            <td className="r mono">{eur(totals.adspend)}</td>
                            <td className="r mono">{eur((totals.omzet || 0) - (totals.cogs || 0))}</td>
                            <td className={`r mono strong ${totals.totalProfit >= 0 ? "green" : "red"}`}>{eur(totals.totalProfit)}</td>
                            <td className={`r mono strong ${(totals.netMarginPct || 0) >= 0 ? "green" : "red"}`}>{numf(totals.netMarginPct || 0, 1)}%</td>
                            <td className={`r mono strong ${(totals.adspend || 0) > 0 && (totals.roas || 0) >= (totals.breakevenRoas || 0) ? "green" : "red"}`}>{(totals.adspend || 0) > 0 ? numf(totals.roas || 0) : "—"}</td>
                            <td className="r mono">{(totals.breakevenRoas || 0) > 0 ? numf(totals.breakevenRoas) : "—"}</td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                </Card>

                {countries.length > 0 && (
                  <Card title="Break-even ROAS per land" subtitle="omzet ÷ dekkingsbijdrage (omzet − COGS − fees − refunds) per land">
                    <div className="table-wrap">
                      <table className="table">
                        <thead><tr>
                          <th>Country</th><th className="r">Orders</th><th className="r">AOV</th><th className="r">Revenue</th><th className="r">Google-spend</th><th className="r">ROAS</th>
                          <th className="r">COGS</th><th className="r">Refunds</th><th className="r">Fees</th>
                          <th className="r">Contribution</th><th className="r">Margin %</th><th className="r">Margin after ads %</th><th className="r">Break-even ROAS</th>
                        </tr></thead>
                        <tbody>
                          {countries.map((c: any) => (
                            <tr key={c.country}>
                              <td className="nowrap strong">{c.country}</td>
                              <td className="r mono">{c.orders}</td>
                              <td className="r mono">{eur(c.aov)}</td>
                              <td className="r mono">{eur(c.revenue)}</td>
                              <td className="r mono dim">{c.adspend ? eur(c.adspend) : "—"}</td>
                              <td className={`r mono strong ${c.roas ? (c.roas >= c.breakevenRoas ? "green" : "red") : ""}`}>{c.roas ? numf(c.roas) : "—"}</td>
                              <td className="r mono">{eur(c.cogs)}</td>
                              <td className="r mono dim">{c.refunds ? eur(c.refunds) : "—"}</td>
                              <td className="r mono dim">{eur(c.fees)}</td>
                              <td className="r mono">{eur(c.contributionMargin)}</td>
                              <td className={`r mono ${c.marginPct >= 0 ? "green" : "red"}`}>{numf(c.marginPct, 1)}%</td>
                              <td className={`r mono strong ${(c.marginAfterAdsPct || 0) >= 0 ? "green" : "red"}`}>{c.adspend ? `${numf(c.marginAfterAdsPct, 1)}%` : "—"}</td>
                              <td className="r mono strong">{c.breakevenRoas > 0 ? numf(c.breakevenRoas) : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="muted" style={{ marginTop: 8 }}>
                      Break-even ROAS = de <b>drempel</b> (omzet ÷ dekkingsbijdrage) — hoeveel omzet je per euro advertentie nodig hebt om quitte te spelen; lager = meer marge-ruimte. <b>ROAS</b> = je gerealiseerde omzet ÷ Google-spend in dat land (o.b.v. klantlocatie). <span className="green">Groen</span> = boven break-even (winst), <span className="red">rood</span> = eronder. Alleen Google-spend (Bing ~1% niet per land); organische omzet zit wel in de omzet, dus dit is je blended ROAS per land. <b>Marge na ads %</b> = wat er per land overblijft ná product- én advertentiekosten (nog vóór overhead) — dít is je echte winstgevendheid per land.
                    </p>
                  </Card>
                )}
            </>)}

            {tab === "uitgaves" && (
              <BespaarLijst rows={(data.expenses || []).filter((e: any) => e.manual)} onChange={reloadData} />
            )}

            {tab === "uitgaves" && (
              <ManualExpenses
                rows={(data.expenses || []).filter((e: any) => e.manual)}
                cats={(data.categories && data.categories.length) ? data.categories : FALLBACK_CATEGORIES}
                methods={Array.from(new Set((data.expenses || []).map((e: any) => e.methode).filter(Boolean))) as string[]}
                month={expMonth}
                onChange={reloadData}
              />
            )}

            {false && tab === "uitgaves" && (() => {
              const q = expSearch.trim().toLowerCase();
              const rows = [...(data.expenses || [])]
                .filter((e: any) => !e.manual)
                .filter((e: any) => !expMonth || (e.date || "").startsWith(expMonth))
                .filter((e: any) => !expMethod || e.methode === expMethod)
                .filter((e: any) => !q || [e.label, e.raw, e.category, e.methode, e.note]
                  .some((f: any) => String(f || "").toLowerCase().includes(q)))
                .sort((a: any, b: any) => (b.date || "").localeCompare(a.date || ""));
              const visCount = EXP_COLS.filter(([k]) => showCol(k)).length;
              const allSel = rows.length > 0 && rows.every((e: any) => selected.has(e.id));
              const toggleAll = () => { const n = new Set(selected); allSel ? rows.forEach((e: any) => n.delete(e.id)) : rows.forEach((e: any) => n.add(e.id)); setSelected(n); };
              return (
                <Card title="Uitgaves" subtitle={`${rows.length} regels${data.importedCount ? ` · ${data.importedCount} geïmporteerd` : ""} · categorie wijzigen = onthouden`}>
                  <div className="colbar">
                    <span className="dim">Kolommen:</span>
                    {EXP_COLS.filter(([k]) => !LOCKED_COLS.has(k)).map(([k, l]) => (
                      <button key={k} className={`colchip ${showCol(k) ? "on" : ""}`} onClick={() => toggleCol(k)}>{l}</button>
                    ))}
                  </div>
                  {selected.size > 0 && (
                    <div className="bulkbar">
                      <span>{selected.size} geselecteerd</span>
                      <button className="bulkdel" onClick={deleteSelected}><Trash2 size={14} /> Verwijderen</button>
                      <button className="bulkclear" onClick={clearSel}>Deselecteren</button>
                    </div>
                  )}
                  <div className="table-wrap">
                    <table className="table">
                      <thead><tr>
                        <th className="selcol"><input type="checkbox" checked={allSel} onChange={toggleAll} /></th>
                        {EXP_COLS.map(([k, l]) => showCol(k) ? <th key={k} className={k === "bedrag" ? "r" : ""}>{l}</th> : null)}
                      </tr></thead>
                      <tbody>
                        {rows.length === 0 && <tr><td colSpan={visCount + 1} className="dim center">Geen uitgaves in deze periode.</td></tr>}
                        {rows.map((e: any, i: number) => (
                          <ExpenseRow key={e.id || i} e={e} cats={(data.categories && data.categories.length) ? data.categories : FALLBACK_CATEGORIES} show={showCol}
                            sel={selected.has(e.id)} onSel={() => toggleSel(e.id)} onCat={saveCat} onNote={saveNote} onLabel={saveLabel} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              );
            })()}

          </>
        )}

        {tab === "balans" && <VermogenPanel />}
        {tab === "vaste" && <FixedCosts expenses={data.expenses || []} />}
        {tab === "marges" && <ProductMargins shop={shop} />}
        {tab === "prijs" && <PriceImpact shop={shop} />}
        {tab === "orders" && <OrdersTab shop={shop} from={getRange().from} to={getRange().to} />}

        {tab === "import" && <ImportPanel onDone={load} onReload={reloadData} cats={(data.categories && data.categories.length) ? data.categories : FALLBACK_CATEGORIES} expenses={data.expenses || []} />}
      </main>
    </div>
  );
}

const STORE_OPTS = [
  { v: "algemeen", l: "Algemeen" },
  { v: "drivemax", l: "Drivemax" },
  { v: "homivo", l: "Homivo" },
];
const storeLabel = (v: string) => STORE_OPTS.find((s) => s.v === v)?.l || "Algemeen";
const BEOORD_OPTS = [
  { v: "", l: "—" },
  { v: "goed", l: "Goed" },
  { v: "slecht", l: "Slecht" },
  { v: "nakijken", l: "Nakijken" },
];
const monthLabelNL = (m: string) => {
  const [y, mo] = m.split("-");
  return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString("nl-NL", { month: "long", year: "numeric" });
};
const METHOD_PRESETS = ["AMEX", "RABO", "RABO-CC", "WISE", "REVOLUT"];

function BespaarLijst({ rows, onChange }: any) {
  const [busy, setBusy] = useState(false);
  const curMonth = new Date().toISOString().slice(0, 7);
  const [mMonth, setMMonth] = useState<string>(curMonth);
  const allFlagged = (rows || []).filter((r: any) => r.beoordeling === "slecht" || r.beoordeling === "nakijken");
  const monthsInData = Array.from(new Set(allFlagged.map((r: any) => (r.date || "").slice(0, 7)).filter(Boolean)));
  const monthOpts = Array.from(new Set([curMonth, ...monthsInData])).sort().reverse() as string[];
  const flagged = allFlagged.filter((r: any) => mMonth === "all" || (r.date || "").startsWith(mMonth));
  const open = flagged.filter((r: any) => !r.done).sort((a: any, b: any) => (b.date || "").localeCompare(a.date || ""));
  const done = flagged.filter((r: any) => r.done);
  const totOpen = open.reduce((a: number, r: any) => a + (r.bedrag || 0), 0);
  const totSlecht = open.filter((r: any) => r.beoordeling === "slecht").reduce((a: number, r: any) => a + (r.bedrag || 0), 0);
  const totNakijk = open.filter((r: any) => r.beoordeling === "nakijken").reduce((a: number, r: any) => a + (r.bedrag || 0), 0);

  const post = (r: any, patch: any) =>
    fetch(`/api/manual-expense`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uid: r.uid, date: r.date, omschrijving: r.omschrijving, methode: r.methode, bedrag: r.bedrag, category: r.category, store: r.store, beoordeling: r.beoordeling, note: r.note, done: !!r.done, ...patch }) });

  const setDone = async (r: any, d: boolean) => {
    setBusy(true);
    try { await post(r, { done: d }); await onChange(); } catch {} finally { setBusy(false); }
  };
  const editNote = async (r: any, note: string) => {
    try { await post(r, { note }); await onChange(); } catch {}
  };

  if (!allFlagged.length) return null;

  return (
    <Card title="Bespaar-lijst" subtitle={`${open.length} open · potentiële besparing ${eur(totOpen)}${done.length ? ` · ${done.length} afgehandeld` : ""}`}>
      <div className="manmonth">
        <span className="dim">Maand:</span>
        <select className="msel" value={mMonth} onChange={(e) => setMMonth(e.target.value)}>
          {monthOpts.map((m) => <option key={m} value={m}>{monthLabelNL(m)}</option>)}
          <option value="all">Alle maanden</option>
        </select>
      </div>
      <div className="besp-chips">
        {totSlecht > 0 && <span className="besp-chip slecht">Slecht: <b>{eur(totSlecht)}</b></span>}
        {totNakijk > 0 && <span className="besp-chip nakijk">Nakijken: <b>{eur(totNakijk)}</b></span>}
      </div>
      {open.length === 0 ? (
        <p className="muted" style={{ margin: "10px 0 0" }}>{done.length > 0 ? "Alles afgehandeld — niks meer op te ruimen." : "Geen gemarkeerde uitgaves in deze maand."}</p>
      ) : (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table className="table">
            <thead><tr>
              <th>Datum</th><th>Omschrijving</th><th className="r">Bedrag</th><th>Oordeel</th><th>Store</th><th>Actie / notitie</th><th></th>
            </tr></thead>
            <tbody>
              {open.map((r: any) => (
                <tr key={r.uid} className={r.beoordeling === "slecht" ? "man-slecht" : "man-nakijken"}>
                  <td className="nowrap">{r.date ? ddmmyyyy(r.date) : "—"}</td>
                  <td>{r.omschrijving || r.label}</td>
                  <td className="r mono strong">{eur(r.bedrag)}</td>
                  <td><span className={`besp-badge ${r.beoordeling}`}>{r.beoordeling === "slecht" ? "Slecht" : "Nakijken"}</span></td>
                  <td className="dim">{storeLabel(r.store)}</td>
                  <td><input className="cellinp mannote" placeholder="bijv. opzeggen / onderhandelen" defaultValue={r.note} onBlur={(e) => e.target.value !== (r.note || "") && editNote(r, e.target.value)} /></td>
                  <td className="r"><button className="besp-done" title="Markeer als afgehandeld" disabled={busy} onClick={() => setDone(r, true)}>✓ Klaar</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {done.length > 0 && (
        <details className="besp-donewrap">
          <summary>{done.length} afgehandeld ({eur(done.reduce((a: number, r: any) => a + (r.bedrag || 0), 0))})</summary>
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {done.map((r: any) => (
                  <tr key={r.uid} className="besp-donerow">
                    <td className="nowrap">{r.date ? ddmmyyyy(r.date) : "—"}</td>
                    <td style={{ textDecoration: "line-through" }}>{r.omschrijving || r.label}</td>
                    <td className="r mono">{eur(r.bedrag)}</td>
                    <td className="dim">{r.note}</td>
                    <td className="r"><button className="bulkclear" onClick={() => setDone(r, false)}>Terug</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </Card>
  );
}

function ManualExpenses({ rows, cats, methods, onChange }: any) {
  const today = new Date().toISOString().slice(0, 10);
  const blank = { date: today, omschrijving: "", methode: "RABO", bedrag: "", category: "Overig", store: "algemeen", beoordeling: "", note: "" };
  const [form, setForm] = useState<any>(blank);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const curMonth = today.slice(0, 7);
  const [mMonth, setMMonth] = useState<string>(curMonth);
  const monthsInData = Array.from(new Set((rows || []).map((r: any) => (r.date || "").slice(0, 7)).filter(Boolean)));
  const monthOpts = Array.from(new Set([curMonth, ...monthsInData])).sort().reverse() as string[];

  const methodOpts = Array.from(new Set([...METHOD_PRESETS, ...(methods || [])]));
  const shown = (rows || [])
    .filter((r: any) => mMonth === "all" || (r.date || "").startsWith(mMonth))
    .sort((a: any, b: any) => (b.date || "").localeCompare(a.date || ""));

  const save = async (payload: any) => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/manual-expense`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error || "Opslaan mislukt");
      await onChange();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const add = async () => {
    if (!String(form.omschrijving).trim()) { setErr("Vul een omschrijving in."); return; }
    if (form.bedrag === "" || isNaN(Number(form.bedrag))) { setErr("Vul een geldig bedrag in."); return; }
    await save({ ...form, bedrag: Number(form.bedrag) });
    setForm({ ...blank, date: form.date, methode: form.methode, store: form.store });
  };

  const editRow = (r: any, patch: any) =>
    save({ uid: r.uid, date: r.date, omschrijving: r.omschrijving, methode: r.methode, bedrag: r.bedrag, category: r.category, store: r.store, beoordeling: r.beoordeling, note: r.note, ...patch });

  const del = async (r: any) => {
    if (!confirm("Deze regel verwijderen?")) return;
    setBusy(true); setErr(null);
    try {
      const x = await fetch(`/api/manual-expense`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uid: r.uid }) }).then((y) => y.json());
      if (!x.ok) throw new Error(x.error || "Verwijderen mislukt");
      await onChange();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const zakelijk = shown.filter((r: any) => r.category !== "Privé").reduce((a: number, r: any) => a + (r.bedrag || 0), 0);
  const slecht = shown.filter((r: any) => r.beoordeling === "slecht" && r.category !== "Privé").reduce((a: number, r: any) => a + (r.bedrag || 0), 0);
  const nakijken = shown.filter((r: any) => r.beoordeling === "nakijken").length;

  return (
    <Card title="Handmatige uitgaves" subtitle={`jouw eigen sheet · ${shown.length} regels · zakelijk ${eur(zakelijk)}${slecht ? ` · slecht ${eur(slecht)}` : ""}${nakijken ? ` · ${nakijken} na te kijken` : ""}`}>
      <div className="manmonth">
        <span className="dim">Maand:</span>
        <select className="msel" value={mMonth} onChange={(e) => setMMonth(e.target.value)}>
          {monthOpts.map((m) => <option key={m} value={m}>{monthLabelNL(m)}</option>)}
          <option value="all">Alle maanden</option>
        </select>
      </div>
      <div className="manform">
        <input className="dinp" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
        <input className="dinp manwide" type="text" placeholder="Omschrijving" value={form.omschrijving} onChange={(e) => setForm({ ...form, omschrijving: e.target.value })} onKeyDown={(e) => e.key === "Enter" && add()} />
        <select className="msel" value={form.methode} onChange={(e) => setForm({ ...form, methode: e.target.value })}>{methodOpts.map((m) => <option key={m} value={m}>{m}</option>)}</select>
        <input className="dinp r manamt" type="number" step="0.01" placeholder="0,00" value={form.bedrag} onChange={(e) => setForm({ ...form, bedrag: e.target.value })} onKeyDown={(e) => e.key === "Enter" && add()} />
        <select className="msel" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{cats.map((c: string) => <option key={c} value={c}>{c}</option>)}</select>
        <select className="msel" value={form.store} onChange={(e) => setForm({ ...form, store: e.target.value })}>{STORE_OPTS.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}</select>
        <select className="msel" value={form.beoordeling} onChange={(e) => setForm({ ...form, beoordeling: e.target.value })}>{BEOORD_OPTS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
        <input className="dinp" type="text" placeholder="Note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className="addbtn" onClick={add} disabled={busy}>+ Toevoegen</button>
      </div>
      {err && <div className="banner err" style={{ marginTop: 8 }}>{err}</div>}
      <div className="mansum">
        {STORE_OPTS.map((s) => {
          const t = shown.filter((r: any) => r.category !== "Privé" && (r.store || "algemeen") === s.v).reduce((a: number, r: any) => a + (r.bedrag || 0), 0);
          return t ? <span key={s.v} className="mansum-item">{s.l}: <b>{eur(t)}</b></span> : null;
        })}
        {(() => {
          const p = shown.filter((r: any) => r.category === "Privé").reduce((a: number, r: any) => a + (r.bedrag || 0), 0);
          return p ? <span className="mansum-item" style={{ opacity: 0.7 }}>Privé (apart, geen bedrijfskost): <b>{eur(p)}</b></span> : null;
        })()}
      </div>
      <div className="table-wrap" style={{ marginTop: 10 }}>
        <table className="table">
          <thead><tr>
            <th>Datum</th><th>Omschrijving</th><th>Methode</th><th className="r">Bedrag</th><th>Categorie</th><th>Store</th><th>Oordeel</th><th>Note</th><th></th>
          </tr></thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={9} className="dim center">Nog geen handmatige regels. Voeg hierboven je eerste uitgave toe.</td></tr>}
            {shown.map((r: any) => (
              <tr key={r.uid} className={r.beoordeling === "goed" ? "man-goed" : r.beoordeling === "slecht" ? "man-slecht" : r.beoordeling === "nakijken" ? "man-nakijken" : ""}>
                <td className="nowrap"><input className="cellinp" type="date" defaultValue={r.date} onBlur={(e) => e.target.value !== r.date && editRow(r, { date: e.target.value })} /></td>
                <td><input className="cellinp manwide" defaultValue={r.omschrijving} onBlur={(e) => e.target.value !== r.omschrijving && editRow(r, { omschrijving: e.target.value })} /></td>
                <td><select className="cellsel" value={r.methode} onChange={(e) => editRow(r, { methode: e.target.value })}>{Array.from(new Set([...METHOD_PRESETS, r.methode].filter(Boolean))).map((m) => <option key={m as string} value={m as string}>{m as string}</option>)}</select></td>
                <td className="r"><input className="cellinp r manamt" type="number" step="0.01" defaultValue={r.bedrag} onBlur={(e) => Number(e.target.value) !== r.bedrag && editRow(r, { bedrag: Number(e.target.value) })} /></td>
                <td><select className="cellsel" value={r.category} onChange={(e) => editRow(r, { category: e.target.value })}>{cats.map((c: string) => <option key={c} value={c}>{c}</option>)}</select></td>
                <td><select className="cellsel" value={r.store || "algemeen"} onChange={(e) => editRow(r, { store: e.target.value })}>{STORE_OPTS.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}</select></td>
                <td><select className="cellsel" value={r.beoordeling || ""} onChange={(e) => editRow(r, { beoordeling: e.target.value })}>{BEOORD_OPTS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select></td>
                <td><input className="cellinp mannote" placeholder="notitie…" defaultValue={r.note} onBlur={(e) => e.target.value !== r.note && editRow(r, { note: e.target.value })} /></td>
                <td className="r"><button className="rowdel" title="Verwijderen" onClick={() => del(r)}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const FIXED_EXCLUDE = ["Transfer", "Refund", "Refund klant", "Ads", "Marketing", "Leverancier betalingen", "Privé"];

function FixedCosts({ expenses }: { expenses: any[] }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [minMonths, setMinMonths] = useState(2);

  const { rows, cats, totalMonthly, cutoff, asOf } = useMemo(() => {
    const groups: Record<string, any> = {};
    let asOf = "";
    (expenses || []).forEach((e) => {
      if (e.deleted) return;
      if (FIXED_EXCLUDE.includes(e.category)) return;
      if (!/^\d{4}-\d{2}/.test(e.date || "")) return;
      if ((e.date || "") > asOf) asOf = e.date;
      const ym = e.date.slice(0, 7);
      const key = e.mkey || e.label || e.raw || "?";
      const g = groups[key] || (groups[key] = { key, label: e.label || e.raw || key, category: e.category, perMonth: {}, lastDate: "" });
      g.perMonth[ym] = (g.perMonth[ym] || 0) + (e.bedrag || 0);
      if ((e.date || "") >= g.lastDate) { g.lastDate = e.date; g.label = e.label || g.label; g.category = e.category || g.category; }
    });
    if (!asOf) asOf = new Date().toISOString().slice(0, 10);
    const cutoff = new Date(new Date(asOf + "T00:00:00").getTime() - 31 * 86400000).toISOString().slice(0, 10);
    let rows = Object.values(groups).map((g: any) => {
      const months = Object.keys(g.perMonth).sort();
      const vals = months.map((m) => g.perMonth[m]);
      const total = vals.reduce((a: number, b: number) => a + b, 0);
      const monthly = total / months.length;
      const latest = g.perMonth[months[months.length - 1]];
      const first = g.perMonth[months[0]];
      const rising = months.length >= 2 && latest > first * 1.15;
      return { ...g, months: months.length, monthly, latest, total, rising };
    });
    rows = rows.filter((r: any) => r.months >= minMonths && r.lastDate >= cutoff);
    const cats = Array.from(new Set(rows.map((r: any) => r.category))).sort();
    if (cat) rows = rows.filter((r: any) => r.category === cat);
    if (q.trim()) { const s = q.toLowerCase(); rows = rows.filter((r: any) => (r.label + " " + r.category).toLowerCase().includes(s)); }
    rows.sort((a: any, b: any) => b.monthly - a.monthly);
    const totalMonthly = rows.reduce((a: number, r: any) => a + r.monthly, 0);
    return { rows, cats, totalMonthly, cutoff, asOf };
  }, [expenses, q, cat, minMonths]);

  return (
    <div className="fixed-wrap">
      <div className="fixed-topgrid">
        <div className="fixed-total">
          <span className="muted">Geschatte vaste lasten</span>
          <b className="mono">{eur(totalMonthly)}<span className="per">/maand</span></b>
          <span className="fixed-year mono">≈ {eur(totalMonthly * 12)} per jaar</span>
        </div>
        <div className="fixed-note muted">
          Terugkerende kosten die in minstens {minMonths} verschillende maanden voorkomen én waarvan de laatste betaling binnen 31 dagen valt (peildatum {ddmmyyyy(asOf)}, dus vanaf {ddmmyyyy(cutoff)}). Gestopte of opgezegde abo's vallen er zo automatisch uit. Per maand gemiddeld, gesorteerd op bedrag — bovenaan = grootste besparingskans. Ads, transfers, refunds, leverancier­betalingen en privé zijn uitgesloten.
        </div>
      </div>

      <div className="fixed-controls">
        <input className="expsearch" placeholder="Zoek leverancier…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">Alle categorieën</option>
          {cats.map((c: string) => <option key={c} value={c}>{c}</option>)}
        </select>
        <div className="seg minm">
          {[2, 3, 4].map((n) => (
            <button key={n} className={minMonths === n ? "on" : ""} onClick={() => setMinMonths(n)}>≥{n} mnd</button>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-body">
          <table className="fixed-table">
            <thead>
              <tr><th>Leverancier</th><th>Categorie</th><th className="r">Maanden</th><th className="r">Gem./maand</th><th className="r">Laatste</th><th className="r">Per jaar</th></tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={6} className="muted">Geen terugkerende kosten gevonden.</td></tr>}
              {rows.map((r: any) => (
                <tr key={r.key}>
                  <td>{r.label}{r.rising && <span className="risetag" title="Loopt op t.o.v. eerste maand">↑ stijgt</span>}</td>
                  <td><span className="cattag">{r.category}</span></td>
                  <td className="r mono">{r.months}</td>
                  <td className="r mono b">{eur(r.monthly)}</td>
                  <td className="r mono">{eur(r.latest)}</td>
                  <td className="r mono muted">{eur(r.monthly * 12)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const LAND_NAAM: Record<string, string> = { NL: "Nederland", BE: "België", DE: "Duitsland", FR: "Frankrijk", PL: "Polen", AT: "Oostenrijk", LU: "Luxemburg", ES: "Spanje", IT: "Italië" };

function OrdersTab({ shop, from, to }: { shop: string; from: string; to: string }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    setLoading(true); setErr("");
    fetch(`/api/orders?shop=${shop}&from=${from}&to=${to}`)
      .then((r) => r.json())
      .then((j) => { if (j.error) setErr(j.error); else setData(j); })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [shop, from, to]);

  const rows = useMemo(() => {
    let rs = data?.rows || [];
    if (q.trim()) { const s = q.toLowerCase(); rs = rs.filter((r: any) => (r.order + " " + r.items).toLowerCase().includes(s)); }
    return rs;
  }, [data, q]);

  if (loading && !data) return <div className="muted" style={{ padding: 20 }}>Orders laden…</div>;
  if (err) return <div className="card"><div className="card-body"><p className="err">Kon orders niet laden: {err}</p></div></div>;
  const t = data?.totals || {};

  return (
    <div className="fixed-wrap">
      <div className="fixed-controls">
        <input className="expsearch" placeholder="Zoek ordernr of product…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="muted" style={{ fontSize: 13 }}>{data?.count || 0} orders · {ddmmyyyy(from)} – {ddmmyyyy(to)}</span>
      </div>
      <div className="card"><div className="card-body">
        <div className="table-wrap">
          <table className="table otable">
            <thead><tr>
              <th>Order</th><th>Datum</th><th>Producten</th><th className="r">Omzet</th><th className="r">Refund</th><th className="r">COGS</th><th className="r">Fees</th><th className="r">Winst</th><th className="r">Marge %</th><th className="r">Break-even</th>
            </tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={10} className="dim center">Geen orders.</td></tr>}
              {rows.map((r: any, i: number) => (
                <tr key={i}>
                  <td className="nowrap mono">{r.order}</td>
                  <td className="nowrap">{ddmmyyyy(r.date)}</td>
                  <td className="dim" style={{ maxWidth: 170, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }} title={r.items}>{r.items}</td>
                  <td className="r mono">{eur(r.revenue)}</td>
                  <td className="r mono dim">{r.refunds ? eur(r.refunds) : "—"}</td>
                  <td className="r mono">{r.cogs != null ? eur(r.cogs) : "—"}</td>
                  <td className="r mono dim">{eur(r.fees)}</td>
                  <td className={`r mono strong ${r.winst >= 0 ? "green" : "red"}`}>{eur(r.winst)}</td>
                  <td className="r mono">{r.margePct != null ? r.margePct.toFixed(1) + "%" : "—"}</td>
                  <td className="r mono dim">{r.breakevenRoas != null ? numf(r.breakevenRoas) : "—"}</td>
                </tr>
              ))}
            </tbody>
            {rows.length > 0 && (
              <tfoot><tr>
                <td>TOTAAL</td><td>{t.orders}</td><td></td>
                <td className="r mono">{eur(t.revenue)}</td>
                <td className="r mono">{eur(t.refunds)}</td>
                <td className="r mono">{eur(t.cogs)}</td>
                <td className="r mono">{eur(t.fees)}</td>
                <td className={`r mono strong ${t.winst >= 0 ? "green" : "red"}`}>{eur(t.winst)}</td>
                <td className="r mono">{t.revenue > 0 ? ((t.winst / t.revenue) * 100).toFixed(1) + "%" : "—"}</td>
                <td className="r mono">{t.breakevenRoas != null ? numf(t.breakevenRoas) : "—"}</td>
              </tr></tfoot>
            )}
          </table>
        </div>
      </div></div>
    </div>
  );
}

function PriceImpact({ shop }: { shop: string }) {
  const [products, setProducts] = useState<any[]>([]);
  const [changes, setChanges] = useState<any[]>([]);
  const [form, setForm] = useState<any>({ variantId: "", oldPrice: "", newPrice: "", date: new Date().toISOString().slice(0, 10) });
  const [win, setWin] = useState(30);
  const [sel, setSel] = useState<any>(null);       // gekozen wijziging
  const [res, setRes] = useState<any>(null);        // analyse-resultaat
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [lastCheck, setLastCheck] = useState<string | null>(null);
  const [autoEnabled, setAutoEnabled] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  const loadList = () => {
    setSyncing(true);
    fetch(`/api/price-impact?shop=${shop}`).then(r => r.json()).then(j => {
      if (j.ok) { setProducts(j.products || []); setChanges(j.changes || []); setLastCheck(j.lastCheck || null); setAutoEnabled(j.autoEnabled !== false); }
    }).catch(() => {}).finally(() => setSyncing(false));
  };
  useEffect(() => { loadList(); setSel(null); setRes(null); }, [shop]);

  const saveDate = (id: string, date: string) => {
    fetch(`/api/price-impact`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shop, action: "editDate", id, date }) })
      .then(r => r.json()).then(j => { if (j.ok) { setChanges(j.changes || []); setEditId(null); if (sel?.id === id) analyze({ ...sel, date }); } });
  };

  const analyze = (change: any, window = win) => {
    setSel(change); setLoading(true); setErr(""); setRes(null);
    fetch(`/api/price-impact?shop=${shop}&variantId=${encodeURIComponent(change.variantId)}&date=${change.date}&window=${window}`)
      .then(r => r.json())
      .then(j => { if (j.ok) setRes(j); else setErr(j.error || "Kon niet berekenen"); })
      .catch(e => setErr(String(e)))
      .finally(() => setLoading(false));
  };

  const addChange = () => {
    if (!form.variantId || !form.date) { setErr("Kies een product en een datum."); return; }
    fetch(`/api/price-impact`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shop, action: "add", ...form }) })
      .then(r => r.json()).then(j => {
        if (j.ok) { setChanges(j.changes || []); setForm({ variantId: "", oldPrice: "", newPrice: "", date: new Date().toISOString().slice(0, 10) }); if (j.entry) analyze(j.entry); }
        else setErr(j.error || "Vastleggen mislukt");
      }).catch(e => setErr(String(e)));
  };

  const delChange = (id: string) => {
    if (!confirm("Deze prijswijziging verwijderen?")) return;
    fetch(`/api/price-impact`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shop, action: "delete", id }) })
      .then(r => r.json()).then(j => { if (j.ok) { setChanges(j.changes || []); if (sel?.id === id) { setSel(null); setRes(null); } } });
  };

  const onPickProduct = (vid: string) => {
    const p = products.find(x => x.variantId === vid);
    setForm((f: any) => ({ ...f, variantId: vid, oldPrice: p ? String(p.price) : f.oldPrice }));
  };

  // Verschil-cel: pijl + kleur. good=true → hoger is beter (groen), false → hoger is slechter (rood).
  const Delta = ({ before, after, good = true, money = false, dec = 0 }: any) => {
    const d = (after || 0) - (before || 0);
    if (Math.abs(d) < 0.005) return <span className="muted">—</span>;
    const up = d > 0;
    const positive = good ? up : !up;
    const col = positive ? "var(--up)" : "var(--down)";
    return <span style={{ color: col, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}>
      {up ? <TrendingUp size={13} /> : <TrendingDown size={13} />}{(up ? "+" : "") + (money ? eur(d) : numf(d, dec))}
    </span>;
  };

  const cell: any = { padding: "8px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums" };
  const th: any = { padding: "8px 12px", textAlign: "left", color: "var(--muted, #888)", fontSize: 12, fontWeight: 600 };

  return (
    <div className="fixed-wrap">
      {/* Automatisch-status */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 9, height: 9, borderRadius: "50%", background: autoEnabled ? "var(--up)" : "var(--down)", display: "inline-block" }} />
              {autoEnabled ? "Automatisch — ik houd de Shopify-prijzen zelf bij" : "Automatisch bijhouden staat uit"}
            </div>
            <div className="muted" style={{ padding: 0, marginTop: 3, fontSize: 13 }}>
              {autoEnabled
                ? <>Zodra je in Shopify een prijs wijzigt, verschijnt die hier vanzelf (datum = wanneer ik het opmerk). {lastCheck ? <>Laatst gecheckt: <b>{new Date(lastCheck).toLocaleString("nl-NL", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</b>.</> : "Eerste keer: ik leg nu de huidige prijzen vast als startpunt."}</>
                : <>Er is nog geen opslag (DATA_DIR) ingesteld, dus ik kan prijzen niet onthouden. Zet een Railway Volume + DATA_DIR aan, dan gaat dit vanzelf.</>}
            </div>
          </div>
          <button onClick={loadList} disabled={syncing} title="Nu checken" style={{ display: "inline-flex", alignItems: "center", gap: 6, font: "inherit", fontSize: 13, fontWeight: 600, padding: "8px 14px", border: "1px solid var(--line)", borderRadius: 10, background: "var(--card)", color: "var(--ink)", cursor: "pointer", opacity: syncing ? .6 : 1 }}>
            <RefreshCw size={14} className={syncing ? "spin" : ""} /> {syncing ? "Checken…" : "Nu checken"}
          </button>
          <button onClick={() => setShowManual(v => !v)} style={{ font: "inherit", fontSize: 13, fontWeight: 600, padding: "8px 14px", border: "1px dashed var(--line)", borderRadius: 10, background: "transparent", color: "var(--accent)", cursor: "pointer" }}>
            {showManual ? "Handmatig sluiten" : "Handmatig toevoegen"}
          </button>
        </div>
      </div>

      <p className="muted" style={{ marginTop: 0, maxWidth: 720, paddingTop: 0 }}>
        Klik een wijziging aan om het effect te zien: een periode <b>vóór</b> vs een even lange periode <b>ná</b>.
        De <b>productwinst</b> is per product (excl. ads); <b>totale winst</b> en <b>ROAS</b> zijn store-breed.
      </p>

      {/* Handmatig vastleggen (optioneel — bv. een datum backfillen) */}
      {showManual && (
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 240, flex: 1 }}>
            <span className="muted" style={{ fontSize: 12 }}>Product</span>
            <select value={form.variantId} onChange={e => onPickProduct(e.target.value)} style={{ padding: "8px 10px" }}>
              <option value="">— kies een product —</option>
              {products.map(p => <option key={p.variantId} value={p.variantId}>{p.title}</option>)}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, width: 110 }}>
            <span className="muted" style={{ fontSize: 12 }}>Oude prijs €</span>
            <input type="number" step="0.01" value={form.oldPrice} onChange={e => setForm({ ...form, oldPrice: e.target.value })} style={{ padding: "8px 10px" }} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, width: 110 }}>
            <span className="muted" style={{ fontSize: 12 }}>Nieuwe prijs €</span>
            <input type="number" step="0.01" value={form.newPrice} onChange={e => setForm({ ...form, newPrice: e.target.value })} style={{ padding: "8px 10px" }} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, width: 150 }}>
            <span className="muted" style={{ fontSize: 12 }}>Datum wijziging</span>
            <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} style={{ padding: "8px 10px" }} />
          </label>
          <button onClick={addChange} style={{ padding: "9px 18px", fontWeight: 600, font: "inherit", fontSize: 13, border: "1px solid var(--accent, #3E6E31)", borderRadius: 10, background: "var(--accent, #3E6E31)", color: "#fff", cursor: "pointer" }}>Vastleggen</button>
        </div>
      </div>
      )}

      {err && <div className="card" style={{ marginBottom: 16 }}><div className="card-body"><span className="err">{err}</span></div></div>}

      {/* Lijst met vastgelegde wijzigingen */}
      {changes.length === 0 ? (
        <p className="muted">Nog geen prijswijzigingen opgemerkt. Zodra je in Shopify een prijs aanpast, verschijnt die hier automatisch — je hoeft niks te doen.</p>
      ) : (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {changes.map(c => (
              <div key={c.id} onClick={() => analyze(c)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, cursor: "pointer", background: sel?.id === c.id ? "var(--card2, rgba(120,120,120,.12))" : "transparent" }}>
                {c.auto
                  ? <span title="Automatisch opgemerkt" style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: .3, padding: "2px 7px", borderRadius: 20, background: "var(--up-soft, #E7F4EC)", color: "var(--up)" }}>AUTO</span>
                  : <span title="Handmatig toegevoegd" style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: .3, padding: "2px 7px", borderRadius: 20, background: "var(--accent-soft, #ECEDFB)", color: "var(--accent)" }}>HAND</span>}
                <b style={{ flex: 1 }}>{c.title}</b>
                <span className="mono">{eur(c.oldPrice)} → {eur(c.newPrice)}</span>
                {editId === c.id ? (
                  <input type="date" defaultValue={c.date} autoFocus onClick={e => e.stopPropagation()} onChange={e => saveDate(c.id, e.target.value)} style={{ padding: "4px 8px", font: "inherit", fontSize: 12 }} />
                ) : (
                  <button onClick={(e) => { e.stopPropagation(); setEditId(c.id); }} title="Datum corrigeren" className="muted" style={{ width: 104, textAlign: "right", border: "none", background: "none", cursor: "pointer", padding: 0, fontSize: 13 }}>{ddmmyyyy(c.date)} ✎</button>
                )}
                <button onClick={(e) => { e.stopPropagation(); delChange(c.id); }} title="Verwijderen" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--down)" }}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Analyse */}
      {sel && (
        <>
          <div className="seg" style={{ marginBottom: 14 }}>
            {[14, 30, 60].map(w => (
              <button key={w} className={win === w ? "on" : ""} onClick={() => { setWin(w); analyze(sel, w); }}>{w} dagen</button>
            ))}
          </div>

          {loading && <p className="muted">Berekenen…</p>}
          {res && (
            <>
              {!res.volledig && (
                <div className="card" style={{ marginBottom: 14 }}><div className="card-body" style={{ fontSize: 13 }}>
                  ⏳ Er zijn sinds de wijziging pas <b>{res.afterDays} dagen</b> verstreken. We vergelijken eerlijk over <b>{res.afterDays} dagen</b> vóór vs ná (nog niet de volle {res.window}).
                </div></div>
              )}

              {/* PRODUCT */}
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="card-body">
                  <h3 style={{ margin: "0 0 4px" }}>{res.title} — per product</h3>
                  <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>Alleen dit product · excl. advertentiekosten</p>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                    <thead><tr>
                      <th style={th}></th>
                      <th style={{ ...th, textAlign: "right" }}>Vóór ({res.afterDays}d)</th>
                      <th style={{ ...th, textAlign: "right" }}>Ná ({res.afterDays}d)</th>
                      <th style={{ ...th, textAlign: "right" }}>Verschil</th>
                    </tr></thead>
                    <tbody>
                      {[
                        ["Verkochte stuks", "units", false, true],
                        ["Omzet", "revenue", true, true],
                        ["COGS (inkoop)", "cogs", true, false],
                        ["Productwinst", "winst", true, true],
                      ].map(([label, key, money, good]: any) => (
                        <tr key={key} style={{ borderTop: "1px solid var(--line, #eee)" }}>
                          <td style={{ padding: "8px 12px", fontWeight: key === "winst" ? 700 : 400 }}>{label}</td>
                          <td style={cell}>{money ? eur(res.product.before[key]) : res.product.before[key]}</td>
                          <td style={{ ...cell, fontWeight: key === "winst" ? 700 : 400 }}>{money ? eur(res.product.after[key]) : res.product.after[key]}</td>
                          <td style={cell}><Delta before={res.product.before[key]} after={res.product.after[key]} good={good} money={money} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* STORE */}
              <div className="card">
                <div className="card-body">
                  <h3 style={{ margin: "0 0 4px" }}>Hele shop ({res.shop}) — advertentie-effect</h3>
                  <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>Store-breed in dezelfde periode · totale winst is inclusief ads</p>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                    <thead><tr>
                      <th style={th}></th>
                      <th style={{ ...th, textAlign: "right" }}>Vóór ({res.afterDays}d)</th>
                      <th style={{ ...th, textAlign: "right" }}>Ná ({res.afterDays}d)</th>
                      <th style={{ ...th, textAlign: "right" }}>Verschil</th>
                    </tr></thead>
                    <tbody>
                      <tr style={{ borderTop: "1px solid var(--line, #eee)" }}>
                        <td style={{ padding: "8px 12px", fontWeight: 700 }}>Totale winst</td>
                        <td style={cell}>{eur(res.store.before.totalProfit)}</td>
                        <td style={{ ...cell, fontWeight: 700 }}>{eur(res.store.after.totalProfit)}</td>
                        <td style={cell}><Delta before={res.store.before.totalProfit} after={res.store.after.totalProfit} good money /></td>
                      </tr>
                      <tr style={{ borderTop: "1px solid var(--line, #eee)" }}>
                        <td style={{ padding: "8px 12px", fontWeight: 700 }}>ROAS</td>
                        <td style={cell}>{numf(res.store.before.roas, 2)}</td>
                        <td style={{ ...cell, fontWeight: 700 }}>{numf(res.store.after.roas, 2)}</td>
                        <td style={cell}><Delta before={res.store.before.roas} after={res.store.after.roas} good dec={2} /></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function ProductMargins({ shop }: { shop: string }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("verkocht");
  const [land, setLand] = useState("");

  const load = (refresh = false) => {
    setLoading(true); setErr("");
    fetch(`/api/product-margins${refresh ? "?refresh=1" : ""}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.error) setErr(j.error);
        else {
          setData(j);
          const cs = j.countries || [];
          const has = (c: string) => cs.some((x: any) => x.code === c);
          setLand((prev) => prev || (has("NL") ? "NL" : cs[0]?.code || ""));
        }
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(false); }, []);

  const rows = useMemo(() => {
    let rs = (data?.rows || []).filter((r: any) => r.country === land);
    if (q.trim()) { const s = q.toLowerCase(); rs = rs.filter((r: any) => r.product.toLowerCase().includes(s) || (r.sku || "").toLowerCase().includes(s)); }
    const cmp: any = {
      verkocht: (a: any, b: any) => (b.units ?? 0) - (a.units ?? 0),
      beroas: (a: any, b: any) => (b.breakevenRoas ?? -1) - (a.breakevenRoas ?? -1),
      winst: (a: any, b: any) => (b.winst ?? -1e9) - (a.winst ?? -1e9),
      marge: (a: any, b: any) => (b.margePct ?? -1e9) - (a.margePct ?? -1e9),
      cogs: (a: any, b: any) => (b.cogs ?? -1) - (a.cogs ?? -1),
      naam: (a: any, b: any) => a.product.localeCompare(b.product),
    };
    return [...rs].sort(cmp[sort] || cmp.beroas);
  }, [data, q, sort, land]);

  if (loading && !data) return <div className="muted" style={{ padding: 20 }}>Marges laden… (eerste keer duurt even — NicheBay-orders worden doorlopen)</div>;
  if (err) return <div className="card"><div className="card-body"><p className="err">Kon marges niet laden: {err}</p></div></div>;

  const countries = data?.countries || [];
  const cur = rows[0]?.currency || "EUR";

  const exportCsv = () => {
    const all = (data?.rows || []);
    const head = ["Land", "Product", "Verkocht", "Valuta", "Verkoop", "Inkoop (COGS)", "Fees", "Winst", "Marge %", "Break-even ROAS"];
    const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [head.join(";")];
    for (const r of all) {
      lines.push([
        LAND_NAAM[r.country] || r.country,
        r.product,
        r.units,
        r.currency,
        r.verkoop, r.cogs, r.fees, r.winst,
        r.margePct != null ? r.margePct : "",
        r.breakevenRoas != null ? r.breakevenRoas : "verlies",
      ].map(esc).join(";"));
    }
    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `marges-per-product-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed-wrap">
      <div className="fixed-topgrid">
        <div className="fixed-total">
          <span className="muted">Producten met marge</span>
          <b className="mono" style={{ color: "var(--up)" }}>{rows.length}<span className="per">in {LAND_NAAM[land] || land || "—"}</span></b>
          <span className="fixed-year mono">{data?.cached ? `cache ${Math.round((data.ageHours || 0))}u oud` : "vers berekend"}</span>
        </div>
        <div className="fixed-note muted">
          Per land, indicatief: verkoopprijs = de huidige prijs in Shopify voor dat land, vóór korting (na een prijswijziging: open dit tabblad opnieuw na hoogstens 5 minuten, of klik Ververs nu); geeft Shopify geen prijs, dan de meest voorkomende prijs uit de orders (houd de muis op het bedrag voor de bron).{data?.rows?.length ? ` ${data.pricesFromShopify ?? 0} van de ${data.rows.length} rijen hebben de Shopify-prijs.` : ""}{data?.priceWarning ? ` ${data.priceWarning}` : ""} Inkoop (COGS) = de laatste all-in prijs per stuk uit NicheBay incl. tax/tarief, omgerekend van dollars naar euro's (ECB-dagkoers); houd de muis op het bedrag voor de datum.{data?.fxMissing ? ` Bij ${data.fxMissing} rij(en) was er geen wisselkoers voor de prijs uit de orders; die staan er alleen als Shopify een prijs gaf.` : ""}{data?.skipped ? ` ${data.skipped} order(s) tellen niet (volledig) mee: valuta, datum of annulering niet te duiden.` : ""}{data?.truncated ? " Alleen de 3.000 nieuwste orders zijn bekeken." : ""}{data?.refreshWarning ? ` ${data.refreshWarning}` : ""} Fees geschat op 1,8% + €0,25. <b>Break-even ROAS</b> = verkoop ÷ winst — laag = veel advertentieruimte, hoog = kwetsbaar. Standaard op meest verkocht: bovenaan je bestsellers — hoog volume + dunne marge = beste onderhandelkaart bij je leverancier.
        </div>
      </div>

      <div className="fixed-controls">
        <div className="seg">
          {countries.map((c: any) => (
            <button key={c.code} className={land === c.code ? "on" : ""} onClick={() => setLand(c.code)}>{LAND_NAAM[c.code] || c.code}</button>
          ))}
        </div>
        <input className="expsearch" placeholder="Zoek product…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="verkocht">Sorteer: meest verkocht (bestsellers)</option>
          <option value="beroas">Sorteer: break-even ROAS</option>
          <option value="winst">Sorteer: winst per stuk</option>
          <option value="marge">Sorteer: marge %</option>
          <option value="cogs">Sorteer: inkoopprijs</option>
          <option value="naam">Sorteer: naam</option>
        </select>
        <button className="clrbtn" onClick={() => load(true)} disabled={loading}>{loading ? "Verversen…" : "Ververs nu"}</button>
        <button className="clrbtn" onClick={exportCsv} disabled={!data?.rows?.length}>⬇ Exporteer CSV (alle landen)</button>
      </div>

      <div className="card"><div className="card-body">
        <table className="fixed-table">
          <thead>
            <tr><th>Product</th><th className="r">Verkocht</th><th className="r">Verkoop</th><th className="r">Inkoop</th><th className="r">Fees</th><th className="r">Winst/stuk</th><th className="r">Marge %</th><th className="r">Break-even ROAS</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={8} className="muted">Geen producten voor dit land.</td></tr>}
            {rows.map((r: any, i: number) => {
              const be = r.breakevenRoas;
              const beClass = be == null ? "" : be >= 3 ? "beroas-bad" : be >= 2 ? "beroas-mid" : "beroas-good";
              return (
                <tr key={i}>
                  <td>{r.product}{r.basis === "verdeeld" && <span className="risetag" style={{ color: "var(--muted)" }} title="COGS geschat uit multi-product orders">~</span>}</td>
                  <td className="r mono b">{r.units}</td>
                  <td className="r mono" title={r.verkoopBron === "shopify" ? `huidige prijs in Shopify${r.verkoopOrders && Math.abs(r.verkoopOrders - r.verkoop) >= 0.01 ? `; in de orders meestal ${eur(r.verkoopOrders)}` : ""}` : "meest voorkomende prijs in de orders"}>{eur(r.verkoop)}</td>
                  <td className="r mono" title={r.cogsDate ? `prijs van ${r.cogsDate}${r.basis === "meer-stuks" ? " (order met meer stuks, per stuk)" : r.basis === "verdeeld" ? " (geschat uit een order met meer producten)" : ""}` : undefined}>{eur(r.cogs)}</td>
                  <td className="r mono muted">{eur(r.fees)}</td>
                  <td className="r mono b" style={{ color: r.winst < 0 ? "var(--down)" : "var(--up)" }}>{eur(r.winst)}</td>
                  <td className="r mono">{r.margePct != null ? r.margePct.toFixed(1) + "%" : "—"}</td>
                  <td className={`r mono b ${beClass}`}>{be != null ? be.toFixed(2) : "verlies"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div></div>
    </div>
  );
}

const ASSET_TYPES = ["Cash", "Crypto", "Edelmetaal", "Beleggingen", "Vastgoed", "Voorraad", "Debiteuren", "Overig"];
const ALLOC_COLORS = ["#3A3FD6", "#0E8A52", "#B4791C", "#CE2C2C", "#7B61FF", "#0AA2C0", "#D6336C", "#5F6672", "#E0A81E"];
function guessType(name = ""): string {
  const s = (name || "").toLowerCase();
  if (/crypto|btc|bitcoin|\beth\b|ether|coin|binance|kraken|ledger/.test(s)) return "Crypto";
  if (/zilver|silver|\bgoud\b|\bgold\b|edelmetaal|platina|metaal/.test(s)) return "Edelmetaal";
  if (/belegg|aandel|\betf\b|effecten|degiro|broker|fonds|mexem|etoro|trading ?212|ibkr|interactive/.test(s)) return "Beleggingen";
  if (/vastgoed|woning|\bhuis\b|pand|onroerend|hypothe/.test(s)) return "Vastgoed";
  if (/voorraad|inventory/.test(s)) return "Voorraad";
  if (/debiteur|te betalen|te ontvangen|openstaand|nichebay|uit te betalen/.test(s)) return "Debiteuren";
  if (/spaar|bank|contant|\bcash\b|rekening|revolut|wise|paypal|mollie|shopify|kas/.test(s)) return "Cash";
  return "Overig";
}

function VermogenPanel() {
  const [assets, setAssets] = useState<any[]>([]);
  const [liab, setLiab] = useState<any[]>([]);
  const [assetsP, setAssetsP] = useState<any[]>([]);
  const [liabP, setLiabP] = useState<any[]>([]);
  const [date, setDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [snaps, setSnaps] = useState<any[]>([]);
  const [persisted, setPersisted] = useState(true);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [scope, setScope] = useState<"zakelijk" | "prive">("zakelijk");

  const load = async () => {
    try {
      const r = await fetch("/api/vermogen").then((x) => x.json());
      if (r.ok) {
        setAssets(r.assets || []); setLiab(r.liabilities || []);
        setAssetsP(r.assetsPrive || []); setLiabP(r.liabPrive || []);
        setDate(r.date || new Date().toISOString().slice(0, 10));
        setSnaps(r.snapshots || []); setPersisted(r.persisted !== false);
      }
    } catch {}
  };
  useEffect(() => { load(); }, []);

  const bodyNow = (over: any = {}) => ({ assets, liabilities: liab, assetsPrive: assetsP, liabPrive: liabP, date, ...over });
  const autosave = async (over: any = {}) => {
    try { await fetch("/api/vermogen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bodyNow(over)) }); } catch {}
  };

  // welke set rijen is actief
  const list = scope === "zakelijk" ? (which: "a" | "l") => (which === "a" ? assets : liab) : (which: "a" | "l") => (which === "a" ? assetsP : liabP);
  const setList = (which: "a" | "l", rows: any[]) => {
    if (scope === "zakelijk") { which === "a" ? setAssets(rows) : setLiab(rows); }
    else { which === "a" ? setAssetsP(rows) : setLiabP(rows); }
  };

  const edit = (which: "a" | "l", i: number, field: string, value: any) => {
    setDirty(true);
    const rows = list(which).map((r: any, idx: number) => (idx === i ? { ...r, [field]: value } : r));
    setList(which, rows);
  };
  const addRow = (which: "a" | "l") => { setDirty(true); setList(which, [...list(which), { name: "", amount: 0 }]); };
  const removeRow = (which: "a" | "l", i: number) => {
    setDirty(true);
    const rows = list(which).filter((_: any, idx: number) => idx !== i);
    setList(which, rows);
    setTimeout(() => autosave(scope === "zakelijk" ? (which === "a" ? { assets: rows } : { liabilities: rows }) : (which === "a" ? { assetsPrive: rows } : { liabPrive: rows })), 0);
  };

  const sum = (rows: any[]) => (rows || []).reduce((a, r) => a + (Number(r.amount) || 0), 0);
  const netZ = sum(assets) - sum(liab);
  const netP = sum(assetsP) - sum(liabP);
  const netT = netZ + netP;
  const aTot = scope === "zakelijk" ? sum(assets) : sum(assetsP);
  const lTot = scope === "zakelijk" ? sum(liab) : sum(liabP);

  const saveSheet = async () => {
    try {
      const r = await fetch("/api/vermogen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bodyNow({ action: "save" })) }).then((x) => x.json());
      if (r.ok) { setSnaps(r.snapshots || []); setSaved(true); setDirty(false); setTimeout(() => setSaved(false), 1800); }
    } catch {}
  };
  const delSnap = async (d: string) => {
    try {
      const r = await fetch("/api/vermogen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "deleteSnapshot", date: d }) }).then((x) => x.json());
      if (r.ok) setSnaps(r.snapshots || []);
    } catch {}
  };

  const rows = (which: "a" | "l") => (
    <div className="cash">
      {list(which).map((r: any, i: number) => (
        <div className="vrow" key={i}>
          <input className="vname" value={r.name} placeholder="naam" onChange={(e) => edit(which, i, "name", e.target.value)} onBlur={() => autosave()} />
          {which === "a" && (
            <select className="vtype" value={r.type || guessType(r.name)} onChange={(e) => { edit(which, i, "type", e.target.value); setTimeout(() => autosave(), 0); }}>
              {ASSET_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
          <input className="vamt mono" type="number" step="0.01" value={r.amount} placeholder="0,00" onChange={(e) => edit(which, i, "amount", e.target.value)} onBlur={() => autosave()} />
          <button className="vdel" onClick={() => removeRow(which, i)} title="Verwijderen">×</button>
        </div>
      ))}
      <button className="vadd" onClick={() => addRow(which)}>+ regel</button>
    </div>
  );

  return (
    <>
      {!persisted && <div className="banner warn">Geen opslag actief — zet DATA_DIR + Railway Volume, anders wordt je vermogen niet bewaard.</div>}

      <div className={`hero ${netT >= 0 ? "up" : "down"}`} style={{ marginBottom: 14, gridTemplateColumns: "1fr" }}>
        <div>
          <div className="hero-label">TOTAAL VERMOGEN · STAND PER {ddmmyyyy(date)}</div>
          <div className="hero-value">{netT >= 0 ? <TrendingUp size={30} /> : <TrendingDown size={30} />} {eur(netT)}</div>
          <div className="hero-note">Zakelijk {eur(netZ)} · Privé {eur(netP)}.{saved ? " ✓ opgeslagen" : dirty ? " · niet opgeslagen" : ""}</div>
        </div>
      </div>

      <Card title="Bijwerken" subtitle="jij vult zelf in en kiest de datum">
        <div className="ctrls" style={{ flexWrap: "wrap", alignItems: "center" }}>
          <span className="dim" style={{ fontSize: 13 }}>Stand per datum:</span>
          <input className="vdate" type="date" value={date} onChange={(e) => { setDate(e.target.value); setDirty(true); }} onBlur={() => autosave()} style={{ minWidth: 150 }} />
          <button className="bulkdel" style={{ background: "var(--accent)" }} onClick={saveSheet}>Opslaan</button>
          {saved && <span className="green" style={{ fontSize: 13 }}>✓ vastgelegd op {ddmmyyyy(date)}</span>}
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          Vul je bezittingen en schulden in (wissel hieronder tussen <b>Zakelijk</b> en <b>Privé</b>), kies de datum, en klik op <b>Opslaan</b>. Elke keer dat je opslaat leg je een meetpunt vast. Tip: haal je winst naar privé? Dan zie je hier dat je zakelijk gelijk blijft maar je privé (en totaal) stijgt.
        </p>
      </Card>

      <div className="ctrls" style={{ marginTop: 14 }}>
        <button className={`colchip ${scope === "zakelijk" ? "on" : ""}`} onClick={() => setScope("zakelijk")}>Zakelijk ({eur(netZ)})</button>
        <button className={`colchip ${scope === "prive" ? "on" : ""}`} onClick={() => setScope("prive")}>Privé ({eur(netP)})</button>
      </div>

      <div className="grid2" style={{ marginTop: 10 }}>
        <Card title={`Bezittingen · ${scope === "zakelijk" ? "zakelijk" : "privé"}`} subtitle={eur(aTot)}>{rows("a")}</Card>
        <Card title={`Schulden · ${scope === "zakelijk" ? "zakelijk" : "privé"}`} subtitle={eur(lTot)}>{rows("l")}</Card>
      </div>

      {(() => {
        const activeA = scope === "zakelijk" ? assets : assetsP;
        const posA = activeA.filter((r: any) => (Number(r.amount) || 0) > 0);
        const totalA = posA.reduce((a: number, r: any) => a + (Number(r.amount) || 0), 0);
        if (totalA <= 0) return null;
        const byType: Record<string, number> = {};
        posA.forEach((r: any) => { const t = r.type || guessType(r.name); byType[t] = (byType[t] || 0) + (Number(r.amount) || 0); });
        const typeRows = Object.entries(byType).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
        const assetRows = posA.map((r: any) => ({ name: r.name || "?", value: Number(r.amount) || 0, type: r.type || guessType(r.name) })).sort((a: any, b: any) => b.value - a.value);
        const pct = (v: number) => Math.round((v / totalA) * 100);
        return (
          <Card title={`Asset-allocatie · ${scope === "zakelijk" ? "zakelijk" : "privé"}`} subtitle={`waar zit je ${eur(totalA)} aan bezittingen in`}>
            <div className="alloc-grid">
              <div className="alloc-chart">
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie data={typeRows} dataKey="value" nameKey="name" innerRadius={54} outerRadius={92} paddingAngle={2} stroke="none">
                      {typeRows.map((t, i) => <Cell key={t.name} fill={ALLOC_COLORS[i % ALLOC_COLORS.length]} />)}
                    </Pie>
                    <Tooltip formatter={(v: any, n: any) => [`${eur(v)} · ${pct(v)}%`, n]} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="alloc-legend">
                {typeRows.map((t, i) => (
                  <div className="alloc-row" key={t.name}>
                    <span className="alloc-dot" style={{ background: ALLOC_COLORS[i % ALLOC_COLORS.length] }} />
                    <span className="alloc-name">{t.name}</span>
                    <span className="alloc-val mono"><b>{pct(t.value)}%</b> <span className="dim">· {eur(t.value)}</span></span>
                  </div>
                ))}
              </div>
            </div>
            <div className="breakdown" style={{ marginTop: 16 }}>
              <div className="alloc-sub dim">Per bezitting</div>
              {assetRows.map((r: any) => (
                <div key={r.name}>
                  <div className="bd-head"><span>{r.name} <span className="dim">· {r.type}</span></span><span className="mono">{pct(r.value)}% · {eur(r.value)}</span></div>
                  <div className="bar"><div className="bar-fill" style={{ width: `${pct(r.value)}%` }} /></div>
                </div>
              ))}
            </div>
          </Card>
        );
      })()}

      <div className="ctrls" style={{ marginTop: 14, justifyContent: "flex-end" }}>
        <button className="bulkdel" style={{ background: "var(--accent)" }} onClick={saveSheet}>Opslaan (stand per {ddmmyyyy(date)})</button>
        {saved && <span className="green" style={{ fontSize: 13 }}>✓ opgeslagen</span>}
      </div>

      {snaps.length > 0 && (
        <Card title="Vermogen over tijd" subtitle="elke keer dat je opslaat is een meetpunt">
          <ResponsiveContainer width="100%" height={210}>
            <AreaChart data={snaps.map((s) => ({ ...s, netTotal: s.netTotal ?? s.net, label: ddmmyyyy(s.date) }))}>
              <defs>
                <linearGradient id="vgt" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#3A3FD6" stopOpacity={0.22} /><stop offset="100%" stopColor="#3A3FD6" stopOpacity={0} /></linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="#EEF0F4" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#8A909C" }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 11, fill: "#8A909C" }} tickLine={false} axisLine={false} width={52} tickFormatter={(v) => (v / 1000).toFixed(0) + "k"} />
              <Tooltip formatter={(v: any, n: any) => [eur(v), n === "netTotal" ? "Totaal" : n === "net" ? "Zakelijk" : "Privé"]} labelStyle={{ color: "#1A1D24" }} />
              <Area type="monotone" dataKey="netTotal" stroke="#3A3FD6" strokeWidth={2} fill="url(#vgt)" name="netTotal" />
              <Area type="monotone" dataKey="net" stroke="#0E8A52" strokeWidth={1.5} fill="transparent" name="net" />
              <Area type="monotone" dataKey="netPrive" stroke="#CE2C2C" strokeWidth={1.5} fill="transparent" name="netPrive" />
            </AreaChart>
          </ResponsiveContainer>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table className="table">
              <thead><tr><th>Datum</th><th className="r">Zakelijk</th><th className="r">Privé</th><th className="r">Totaal</th><th className="r">Verschil</th><th></th></tr></thead>
              <tbody>
                {[...snaps].reverse().map((s, i, arr) => {
                  const tot = s.netTotal ?? s.net;
                  const prev = arr[i + 1];
                  const prevTot = prev ? (prev.netTotal ?? prev.net) : null;
                  const delta = prevTot == null ? null : tot - prevTot;
                  return (
                    <tr key={s.date}>
                      <td className="nowrap">{ddmmyyyy(s.date)}</td>
                      <td className="r mono">{eur(s.net)}</td>
                      <td className="r mono">{eur(s.netPrive ?? 0)}</td>
                      <td className="r mono strong">{eur(tot)}</td>
                      <td className={`r mono ${delta == null ? "dim" : delta >= 0 ? "green" : "red"}`}>{delta == null ? "—" : `${delta >= 0 ? "▲" : "▼"} ${eur(Math.abs(delta))}`}</td>
                      <td className="r"><button className="vdel" onClick={() => delSnap(s.date)} title="Meetpunt verwijderen">×</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

function ImportPanel({ onDone, onReload, cats, expenses }: any) {
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [res, setRes] = useState<any>(null);
  const [pending, setPending] = useState<any[]>([]);
  const [income, setIncome] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Automatische koppelingen
  const [ppBusy, setPpBusy] = useState(false);
  const [ppMsg, setPpMsg] = useState<string | null>(null);
  const [bankBusy, setBankBusy] = useState(false);
  const [bankMsg, setBankMsg] = useState<string | null>(null);
  const [institutions, setInstitutions] = useState<any[]>([]);
  const [connected, setConnected] = useState<any[]>([]);
  const [chosenInst, setChosenInst] = useState("");

  const editIncome = async (e: any, category: string) => {
    setIncome((rows) => rows.map((x) => (x.id === e.id ? { ...x, category } : x)));
    try { await fetch("/api/income", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: e.id, category }) }); } catch {}
  };

  const syncPaypal = async () => {
    setPpBusy(true); setPpMsg(null);
    try {
      const r = await fetch("/api/paypal/sync").then((x) => x.json());
      if (r.ok) {
        const bd = (r.balanceBreakdown || []).filter((b: any) => b.currency !== "EUR");
        const bdTxt = bd.length ? ` (incl. ${bd.map((b: any) => `${b.currency} ${b.value}${b.eur != null ? `→${eur(b.eur)}` : " (koers ?)"}`).join(", ")})` : "";
        const fxTxt = r.fx && r.fx.converted ? ` · ${r.fx.converted} vreemde valuta omgerekend` : "";
        const fxFail = r.fx && r.fx.failed ? ` · ${r.fx.failed} koers niet gevonden` : "";
        setPpMsg(`PayPal: saldo ${r.balance ? eur(r.balance) : "?"}${bdTxt} · ${r.staged} nieuw in wachtrij · ${r.income} inkomend · ${r.duplicates} dubbel${fxTxt}${fxFail}.`);
        await refreshPending(); onReload && onReload();
      }
      else setPpMsg(r.error || "Mislukt.");
    } catch (e: any) { setPpMsg(e.message); } finally { setPpBusy(false); }
  };

  const loadBanks = async () => {
    setBankBusy(true); setBankMsg(null);
    try {
      const r = await fetch("/api/banks").then((x) => x.json());
      if (r.ok) { setInstitutions(r.institutions || []); setConnected(r.connected || []); if (!r.institutions?.length) setBankMsg("Geen banken gevonden."); }
      else setBankMsg(r.error || "Mislukt.");
    } catch (e: any) { setBankMsg(e.message); } finally { setBankBusy(false); }
  };

  const connectBank = async () => {
    const inst = institutions.find((i) => i.id === chosenInst);
    if (!inst) return;
    setBankBusy(true); setBankMsg(null);
    try {
      const r = await fetch("/api/banks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ institutionId: inst.id, name: inst.name }) }).then((x) => x.json());
      if (r.ok && r.link) { window.open(r.link, "_blank"); setBankMsg("Log in bij je bank in het nieuwe tabblad en geef toestemming. Klik daarna op 'Synchroniseer banken'."); loadBanks(); }
      else setBankMsg(r.error || "Mislukt.");
    } catch (e: any) { setBankMsg(e.message); } finally { setBankBusy(false); }
  };

  const syncBanks = async () => {
    setBankBusy(true); setBankMsg(null);
    try {
      const r = await fetch("/api/banks/sync").then((x) => x.json());
      if (r.ok) {
        const lines = (r.results || []).map((x: any) => x.status === "OK" ? `${x.name}: ${x.balance != null ? eur(x.balance) + " · " : ""}${x.staged} nieuw · ${x.income} inkomend` : `${x.name}: ${x.note || x.error || x.status}`);
        setBankMsg(lines.join(" | ") || r.note || "Geen banken gekoppeld.");
        await refreshPending(); onReload && onReload();
      } else setBankMsg(r.error || "Mislukt.");
    } catch (e: any) { setBankMsg(e.message); } finally { setBankBusy(false); }
  };
  const [source, setSource] = useState("rabobank");

  // --- Win-Win inkoopfactuur (PDF) → exacte COGS per order ---
  const [invShop, setInvShop] = useState("homivo");
  const [invBusy, setInvBusy] = useState(false);
  const [invDrag, setInvDrag] = useState(false);
  const [invErr, setInvErr] = useState<string | null>(null);
  const [invRes, setInvRes] = useState<any>(null);
  const [invStatus, setInvStatus] = useState<any>(null);

  const loadInvStatus = async (s = invShop) => {
    try {
      const r = await fetch(`/api/cogs-invoice?shop=${s}`).then((x) => x.json());
      if (r.ok) setInvStatus(r);
    } catch {}
  };
  useEffect(() => { loadInvStatus(invShop); /* eslint-disable-next-line */ }, [invShop]);

  const [invDebug, setInvDebug] = useState<any>(null);
  const [invDebugMode, setInvDebugMode] = useState(false);
  const [matchInfo, setMatchInfo] = useState<any>(null);
  const runMatch = async () => {
    setMatchInfo({ loading: true });
    try {
      const r = await fetch(`/api/cogs-invoice?shop=${invShop}&match=1`).then((x) => x.json());
      setMatchInfo(r.match || { error: "geen data" });
    } catch (e: any) { setMatchInfo({ error: e.message }); }
  };
  const uploadInvoice = async (file: File) => {
    setInvBusy(true); setInvErr(null); setInvRes(null); setInvDebug(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("shop", invShop);
      const r = await fetch(`/api/cogs-invoice${invDebugMode ? "?debug=1" : ""}`, { method: "POST", body: fd }).then((x) => x.json());
      if (r.debug) { setInvDebug(r); return; }
      if (!r.ok) {
        setInvErr(r.error || "Upload mislukt");
        if (r.sample != null) setInvDebug({ sample: r.sample, len: r.textLen });
        return;
      }
      setInvRes(r);
      await loadInvStatus(invShop);
      onReload && onReload();
    } catch (e: any) { setInvErr(e.message); }
    finally { setInvBusy(false); }
  };

  const resetInvoices = async () => {
    if (!confirm(`Alle opgeslagen inkoop-COGS voor ${invShop} wissen?`)) return;
    setInvBusy(true); setInvErr(null);
    try {
      await fetch(`/api/cogs-invoice?shop=${invShop}`, { method: "DELETE" });
      setInvRes(null); await loadInvStatus(invShop); onReload && onReload();
    } finally { setInvBusy(false); }
  };

  // --- Shopify-koppeling (OAuth) ---
  const [connShop, setConnShop] = useState("homivo");
  const [connStatus, setConnStatus] = useState<any>(null);
  const [connMsg, setConnMsg] = useState<string | null>(null);
  const loadConnStatus = async (s = connShop) => {
    try { const r = await fetch(`/api/shopify/status?shop=${s}`).then((x) => x.json()); if (r.ok) setConnStatus(r); } catch {}
  };
  useEffect(() => { loadConnStatus(connShop); /* eslint-disable-next-line */ }, [connShop]);
  // terugkoppeling na de OAuth-redirect (?shopify_connected / ?shopify_error)
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("shopify_connected")) {
      setConnMsg(`Shopify gekoppeld voor ${p.get("shopify_connected")}. 🎉`);
      onReload && onReload();
      window.history.replaceState({}, "", window.location.pathname);
    } else if (p.get("shopify_error")) {
      setConnMsg(`Koppelen mislukt: ${p.get("shopify_error")}`);
      window.history.replaceState({}, "", window.location.pathname);
    }
    /* eslint-disable-next-line */
  }, []);
  const disconnectShopify = async () => {
    if (!confirm(`Shopify-koppeling voor ${connShop} verwijderen?`)) return;
    try { await fetch(`/api/shopify/status?shop=${connShop}`, { method: "DELETE" }); await loadConnStatus(connShop); onReload && onReload(); } catch {}
  };
  const [psel, setPsel] = useState<Set<string>>(new Set());
  const togglePsel = (id: string) => setPsel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const SOURCE_OPTIONS = [
    ["rabobank", "Rabobank"], ["wise", "Wise"], ["revolut", "Revolut"],
    ["rabo_cc", "Rabo creditcard"], ["amex", "American Express"], ["paypal", "PayPal"], ["anders", "Anders"],
  ];

  // wachtrij ophalen bij openen (blijft staan na herladen)
  useEffect(() => {
    fetch(`/api/import`).then((r) => r.json()).then((r) => { if (r.ok) { setPending(r.pending || []); setIncome(r.income || []); } }).catch(() => {});
  }, []);

  const refreshPending = async () => {
    try { const r = await fetch(`/api/import`).then((x) => x.json()); if (r.ok) { setPending(r.pending || []); setIncome(r.income || []); } } catch {}
  };

  const upload = async (file: File) => {
    setBusy(true); setErr(null); setMsg(null); setRes(null);
    try {
      const text = await file.text();
      const r = await fetch(`/api/import?source=${source}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: text }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error || "Import mislukt");
      setRes(r);
      setPending(r.pending || []);
      setIncome(r.income || []);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const editCat = async (e: any, category: string) => {
    setPending((p) => p.map((x) => (x.id === e.id ? { ...x, category } : x)));
    try {
      await fetch(`/api/expense`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: e.id, mkey: e.mkey, category, remember: true }) });
      await refreshPending(); onReload && onReload();
    } catch {}
  };
  const editLabel = async (e: any, label: string) => {
    setPending((p) => p.map((x) => (x.id === e.id ? { ...x, label } : x)));
    try {
      await fetch(`/api/expense`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: e.id, mkey: e.mkey, label, remember: true }) });
      await refreshPending(); onReload && onReload();
    } catch {}
  };

  const approve = async (ids?: string[]) => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/import/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ids && ids.length ? { ids } : {}) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error || "Goedkeuren mislukt");
      setPsel(new Set());
      await refreshPending();
      setMsg(`${r.approved} transactie(s) goedgekeurd en toegevoegd${r.revived ? ` · ${r.revived} hersteld` : ""}.`);
      onDone && onDone();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const discard = async () => {
    if (!confirm("Wachtrij verwerpen? Deze import gaat dan niet door.")) return;
    setBusy(true);
    try { await fetch(`/api/import?what=pending`, { method: "DELETE" }); setPending([]); setRes(null); setMsg("Wachtrij verworpen."); }
    finally { setBusy(false); }
  };

  const removeSelected = async (ids: string[]) => {
    if (!ids.length) return;
    if (!confirm(`${ids.length} regel(s) uit de wachtrij verwijderen? Dit kan niet ongedaan worden gemaakt.`)) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/import?what=pending&ids=${encodeURIComponent(ids.join(","))}`, { method: "DELETE" }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error || "Verwijderen mislukt");
      setPsel(new Set());
      await refreshPending();
      setMsg(`${r.removed ?? ids.length} regel(s) verwijderd.`);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const reset = async () => {
    if (!confirm("Alle reeds goedgekeurde geïmporteerde uitgaves verwijderen?")) return;
    setBusy(true);
    try { await fetch("/api/import", { method: "DELETE" }); onDone && onDone(); setMsg("Goedgekeurde import gewist."); } finally { setBusy(false); }
  };

  const pendingTotal = pending.reduce((a, e) => a + (["Transfer", "Privé"].includes(e.category) ? 0 : (e.bedrag || 0)), 0);

  return (
    <>
      <Card title="Maand-checklist" subtitle="welke CSV's heb je per maand al aangeleverd">
        {(() => {
          const exps = expenses || [];
          // maanden vanaf januari 2026 t/m de vorige (afgeronde) maand
          const months: { val: string; label: string }[] = [];
          const cur = new Date();
          const firstOfCurrent = new Date(cur.getFullYear(), cur.getMonth(), 1);
          let d = new Date(2026, 0, 1);
          while (d < firstOfCurrent) {
            months.push({
              val: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
              label: d.toLocaleDateString("nl-NL", { month: "long", year: "numeric" }),
            });
            d.setMonth(d.getMonth() + 1);
          }
          // providers = vaste lijst van jouw rekeningen (key = label in je data, naam = weergave)
          const FIXED_PROVIDERS: { key: string; name: string }[] = [
            { key: "RABO", name: "Rabobank" },
            { key: "AMEX", name: "American Express" },
            { key: "PAYPAL", name: "PayPal" },
            { key: "REVOLUT", name: "Revolut" },
            { key: "WISE", name: "Wise" },
            { key: "RABO-CC", name: "Rabo creditcard" },
          ];
          const fixedKeys = new Set(FIXED_PROVIDERS.map((p) => p.key));
          const extra = (Array.from(new Set(exps.map((e: any) => e.methode).filter(Boolean))) as string[])
            .filter((k) => !fixedKeys.has(k))
            .map((k) => ({ key: k, name: k }));
          const providers = [...FIXED_PROVIDERS, ...extra];

          const count = (mv: string, key: string) =>
            exps.filter((e: any) => e.methode === key && (e.date || "").startsWith(mv)).length;

          const missing: string[] = [];
          months.forEach((mo) => providers.forEach((p) => { if (count(mo.val, p.key) === 0) missing.push(`${mo.label} · ${p.name}`); }));

          if (!months.length) return <p className="muted" style={{ marginTop: 0 }}>Nog geen afgeronde maand sinds januari 2026.</p>;

          return (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                Per maand zie je welke providers al binnen zijn (✓ met aantal) en welke je nog moet aanleveren (—).
                Gebaseerd op de transacties die je al hebt geïmporteerd.
              </p>
              {missing.length > 0 ? (
                <div className="banner warn" style={{ marginBottom: 12 }}>
                  <b>Nog aanleveren:</b> {missing.join("  ·  ")}
                </div>
              ) : (
                <div className="banner ok" style={{ marginBottom: 12 }}>Alles compleet t/m vorige maand. 🎉</div>
              )}
              <div style={{ overflowX: "auto" }}>
                <table className="table cov">
                  <thead>
                    <tr>
                      <th>Maand</th>
                      {providers.map((p) => <th key={p.key} className="center">{p.name}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {months.map((mo) => (
                      <tr key={mo.val}>
                        <td className="nowrap strong" style={{ textTransform: "capitalize" }}>{mo.label}</td>
                        {providers.map((p) => {
                          const n = count(mo.val, p.key);
                          return (
                            <td key={p.key} className="center">
                              {n > 0
                                ? <span className="covok">✓ <span className="dim">{n}</span></span>
                                : <span className="covmiss">—</span>}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          );
        })()}
      </Card>

      <Card title="Shopify-koppeling" subtitle="orders & omzet per shop">
        {connMsg && <div className={`banner ${connMsg.startsWith("Shopify gekoppeld") ? "ok" : "err"}`} style={{ marginBottom: 12 }}>{connMsg}</div>}
        <p className="muted" style={{ marginTop: 0 }}>
          Koppel een shop met Shopify om orders en omzet op te halen. Je logt in bij Shopify en geeft
          leestoegang (orders + producten); de app bewaart de toegang zelf — je hoeft geen token te kopiëren.
        </p>
        <div className="ctrls" style={{ marginBottom: 12 }}>
          <span className="dim" style={{ fontSize: 13 }}>Shop:</span>
          <select className="msel" value={connShop} onChange={(e) => setConnShop(e.target.value)}>
            <option value="homivo">Homivo</option>
            <option value="drivemax">Drivemax</option>
          </select>
          {connStatus && (
            <span className="pill" style={{ background: connStatus.connected ? "var(--up-soft)" : "var(--down-soft)", color: connStatus.connected ? "var(--up)" : "var(--down)" }}>
              {connStatus.connected ? "✓ gekoppeld" : "niet gekoppeld"}
            </span>
          )}
        </div>
        {connStatus && !connStatus.oauthConfigured && (
          <div className="banner warn" style={{ marginBottom: 12 }}>
            Zet eerst <b>SHOPIFY_CLIENT_ID</b> en <b>SHOPIFY_CLIENT_SECRET</b> als env-variabelen in Railway (uit je Shopify-app).
          </div>
        )}
        {connStatus && connStatus.connected && (
          <p className="muted" style={{ marginTop: 0 }}>
            {connStatus.hasEnvToken
              ? "Gekoppeld via een token in Railway (env)."
              : <>Gekoppeld via Shopify-login op <b>{connStatus.oauthShop}</b>{connStatus.obtainedAt ? ` · sinds ${ddmmyyyy(String(connStatus.obtainedAt).slice(0, 10))}` : ""}.</>}
          </p>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            className="seg"
            style={{ cursor: "pointer", padding: "8px 14px", background: "var(--accent)", color: "#fff", border: "none", borderRadius: 9, fontWeight: 600 }}
            disabled={connStatus && !connStatus.oauthConfigured}
            onClick={() => { window.location.href = `/api/shopify/connect?shop=${connShop}`; }}
          >
            {connStatus?.connected && !connStatus?.hasEnvToken ? "Opnieuw koppelen" : "Koppel met Shopify"}
          </button>
          {connStatus && connStatus.hasOAuth && (
            <button className="bulkclear" onClick={disconnectShopify}>Koppeling verwijderen</button>
          )}
        </div>
      </Card>

      {false && (<Card title="Bankafschrift importeren" subtitle="bank · creditcard · PayPal">
        <p className="muted" style={{ marginTop: 0 }}>
          Kies de bron en sleep je <b>CSV</b> hierheen. De import komt eerst in de <b>wachtrij</b> hieronder — die telt nog niet mee.
          Pas daar categorie en omschrijving aan en klik op <b>Goedkeuren</b> om ze definitief toe te voegen. Doe je niks, dan blijven ze staan.
        </p>
        <div className="ctrls" style={{ marginBottom: 12 }}>
          <span className="dim" style={{ fontSize: 13 }}>Bron:</span>
          <select className="msel" value={source} onChange={(e) => setSource(e.target.value)}>
            {SOURCE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <label
          className={`dropzone ${drag ? "dragging" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragEnter={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={(e) => { e.preventDefault(); setDrag(false); }}
          onDrop={(e) => {
            e.preventDefault(); setDrag(false);
            const f = e.dataTransfer.files?.[0];
            if (f && /\.csv$/i.test(f.name)) upload(f);
            else if (f) setErr("Alleen .csv-bestanden.");
          }}
        >
          <input type="file" accept=".csv,text/csv" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
          <Upload size={22} />
          <span>{busy ? "Bezig…" : drag ? "Laat los om te importeren" : "Kies of sleep je CSV-bestand"}</span>
        </label>
        {err && <div className="banner err" style={{ marginTop: 12 }}>{err}</div>}
        {msg && <div className="banner ok" style={{ marginTop: 12 }}>{msg}</div>}
        {res?.note && <div className="banner warn" style={{ marginTop: 12 }}>{res.note}</div>}
        {res && (
          <>
            <div className="kpis" style={{ marginTop: 14 }}>
              <Kpi label="Herkend" value={String(res.parsed)} />
              <Kpi label="In wachtrij gezet" value={String(res.staged)} tone="up" />
              <Kpi label="Dubbel (overgeslagen)" value={String(res.duplicates)} />
              <Kpi label="Uitgesloten" value={String(res.stats?.excluded ?? 0)} tone="down" />
              <Kpi label="Transfers" value={String(res.stats?.transfers ?? 0)} />
              <Kpi label="Inkomend" value={String(res.stats?.income ?? 0)} />
              <Kpi label="Overgeslagen" value={String(res.stats?.skipped ?? 0)} tone={(res.stats?.skipped ?? 0) > 0 ? "down" : undefined} />
            </div>
            {(() => {
              const s = res.stats || {};
              const fx = res.fx || { converted: 0, failed: 0, dropped: 0 };
              const accounted = (res.parsed || 0) + (s.income || 0) + (s.excluded || 0) + (s.skipped || 0) + (fx.dropped || 0) + (fx.failed || 0);
              const total = s.total || 0;
              const ok = accounted === total;
              return (
                <div className={`banner ${ok && !fx.failed ? "info" : "warn"}`} style={{ marginTop: 12 }}>
                  <b>{total} regels in je CSV</b> = {res.parsed || 0} uitgaven + {s.income || 0} inkomend + {s.excluded || 0} uitgesloten + {s.skipped || 0} overgeslagen{ok ? " ✓ alles verwerkt" : ` — ${total - accounted} niet verklaard`}.
                  {(s.otherCurrency || 0) > 0 && <> Daarvan <b>{s.otherCurrency} niet-EUR</b> regels: {fx.converted} omgerekend naar EUR (dagkoers){fx.failed ? `, ${fx.failed} koers niet gevonden (overgeslagen)` : ""}.</>}
                  {(s.skipped ?? 0) > 0 && <> De <b>{s.skipped} overgeslagen</b> regels hadden geen herkenbare datum/bedrag.</>}
                </div>
              );
            })()}
            {Array.isArray(res.excluded) && res.excluded.length > 0 && (
              <details style={{ marginTop: 12 }}>
                <summary style={{ cursor: "pointer", fontWeight: 600 }}>Bekijk de {res.excluded.length} uitgesloten regels</summary>
                <p className="muted" style={{ margin: "6px 0" }}>
                  Deze zijn bewust niet als kost geteld omdat ze al elders meetellen (NicheBay = je COGS per order; Google/Meta = je advertentiekosten). Ziet iets er onterecht uit? Stuur me de omschrijving, dan haal ik 'm uit de uitsluitlijst.
                </p>
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Datum</th><th>Omschrijving</th><th>Reden (match)</th><th className="r">Bedrag</th></tr></thead>
                    <tbody>
                      {res.excluded.map((e: any, i: number) => (
                        <tr key={e.id || i}>
                          <td className="nowrap">{e.date ? ddmmyyyy(e.date) : "—"}</td>
                          <td title={e.omschrijving}>{e.omschrijving}</td>
                          <td><span className="pill pill-dim">{e.reason}</span></td>
                          <td className="r mono">{eur(e.bedrag)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </>
        )}
      </Card>)}

      <Card title="Inkoopfactuur (Win-Win PDF)" subtitle="exacte COGS per order · dagelijks">
        <p className="muted" style={{ marginTop: 0 }}>
          Sleep hier je dagelijkse <b>Win-Win "INVOICE LIST" PDF</b>. De app leest per order de
          echte inkoopprijs (incl. duty) en gebruikt die als <b>exacte COGS</b> in je P&L — met
          voorrang op schattingen. Nieuwe facturen vullen aan; bestaande orders worden bijgewerkt.
        </p>
        <div className="ctrls" style={{ marginBottom: 12 }}>
          <span className="dim" style={{ fontSize: 13 }}>Shop:</span>
          <select className="msel" value={invShop} onChange={(e) => setInvShop(e.target.value)}>
            <option value="homivo">Homivo</option>
            <option value="drivemax">Drivemax</option>
          </select>
          {invStatus && (
            <span className="dim" style={{ fontSize: 13 }}>
              {invStatus.orderCount} orders opgeslagen · {eur(invStatus.totalStored || 0)} totaal
            </span>
          )}
          <button className="bulkclear" onClick={runMatch} style={{ marginLeft: "auto" }}>Controleer matching</button>
        </div>
        {matchInfo && (
          <div className="banner info" style={{ marginBottom: 12, fontSize: 12.5 }}>
            {matchInfo.loading ? "Bezig met controleren…" : matchInfo.error ? `Fout: ${matchInfo.error}` : (
              <>
                <b>{matchInfo.matched}/{matchInfo.shopOrders}</b> Shopify-orders (laatste 40 dagen) hebben een COGS-match.
                <div style={{ marginTop: 6 }}><b>Lange keys (order-ids, {matchInfo.longKeysCount}×):</b> <span className="mono">{(matchInfo.longKeysSample || []).join(", ") || "(GEEN lange keys!)"}</span></div>
                <div style={{ marginTop: 4 }}><b>Korte keys (nrs):</b> <span className="mono">{(matchInfo.shortKeysSample || []).join(", ")}</span></div>
                <div style={{ marginTop: 4 }}><b>1e Shopify-numId:</b> <span className="mono">{matchInfo.firstNumId}</span> — opgeslagen? <b className={matchInfo.firstNumIdStored ? "green" : "red"}>{matchInfo.firstNumIdStored ? "JA" : "NEE"}</b></div>
                <div className="table-wrap" style={{ marginTop: 6 }}>
                  <table className="table">
                    <thead><tr><th>Order</th><th>Shopify id (numId)</th><th>Nr</th><th>Match</th><th className="r">COGS</th></tr></thead>
                    <tbody>
                      {(matchInfo.sample || []).map((r: any, i: number) => (
                        <tr key={i}>
                          <td className="nowrap">{r.name}</td>
                          <td className="mono nowrap">{r.numId}</td>
                          <td className="mono">{r.orderNo}</td>
                          <td><span className={r.match === "GEEN" ? "red" : "green"}>{r.match}</span></td>
                          <td className="r mono">{r.cogs != null ? eur(r.cogs) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
        <label
          className={`dropzone ${invDrag ? "dragging" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setInvDrag(true); }}
          onDragEnter={(e) => { e.preventDefault(); setInvDrag(true); }}
          onDragLeave={(e) => { e.preventDefault(); setInvDrag(false); }}
          onDrop={(e) => {
            e.preventDefault(); setInvDrag(false);
            const f = e.dataTransfer.files?.[0];
            if (f && /\.pdf$/i.test(f.name)) uploadInvoice(f);
            else if (f) setInvErr("Alleen .pdf-bestanden.");
          }}
        >
          <input type="file" accept="application/pdf,.pdf" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadInvoice(f); e.target.value = ""; }} />
          <Upload size={22} />
          <span>{invBusy ? "Bezig…" : invDrag ? "Laat los om te lezen" : "Kies of sleep je Win-Win PDF"}</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--soft)", marginTop: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={invDebugMode} onChange={(e) => setInvDebugMode(e.target.checked)} />
          Diagnosemodus (niet opslaan — toon uitgelezen tekst + herkende orders)
        </label>
        {invErr && <div className="banner err" style={{ marginTop: 12 }}>{invErr}</div>}
        {invDebug && (
          <details style={{ marginTop: 10 }} open>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>
              Diagnose{invDebug.orderCount != null ? ` — ${invDebug.orderCount} orders herkend, ${eur(invDebug.total || 0)}` : ` (${invDebug.len} tekens)`}
            </summary>
            {Array.isArray(invDebug.lines) && (
              <div className="table-wrap" style={{ marginTop: 6 }}>
                <table className="table">
                  <thead><tr><th>Order (uit PDF)</th><th>Product</th><th className="r">Aantal</th><th className="r">Prijs</th></tr></thead>
                  <tbody>
                    {invDebug.lines.map((l: any, i: number) => (
                      <tr key={i}><td className="mono nowrap">{l.order}</td><td>{String(l.product).slice(0, 40)}</td><td className="r">{l.qty}</td><td className="r mono">{eur(l.price)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <pre style={{ whiteSpace: "pre-wrap", fontSize: 10.5, background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 8, padding: 10, marginTop: 6, maxHeight: 320, overflow: "auto" }}>{invDebug.text || invDebug.sample || "(leeg)"}</pre>
          </details>
        )}
        {invRes && (
          <>
            <div className="kpis" style={{ marginTop: 14 }}>
              <Kpi label="Orders in factuur" value={String(invRes.orderCount)} />
              <Kpi label="Nieuw toegevoegd" value={String(invRes.added)} tone="up" />
              <Kpi label="Bijgewerkt" value={String(invRes.updated)} />
              <Kpi label="Factuurtotaal" value={eur(invRes.total || 0)} />
              <Kpi label="Totaal orders opgeslagen" value={String(invRes.totalStoredOrders)} />
            </div>
            {invRes.alreadyUploaded && (
              <div className="banner warn" style={{ marginTop: 12 }}>
                Factuur <b>{invRes.invoiceNo}</b> was al eerder geüpload — opnieuw verwerkt (geen dubbele telling, prijzen zijn overschreven).
              </div>
            )}
            {Array.isArray(invRes.preview) && invRes.preview.length > 0 && (
              <details style={{ marginTop: 12 }}>
                <summary style={{ cursor: "pointer", fontWeight: 600 }}>Controle: eerste {invRes.preview.length} regels</summary>
                <div className="table-wrap" style={{ marginTop: 6 }}>
                  <table className="table">
                    <thead><tr><th>Order</th><th>Product</th><th className="r">Aantal</th><th className="r">Inkoop</th></tr></thead>
                    <tbody>
                      {invRes.preview.map((l: any, i: number) => (
                        <tr key={i}>
                          <td className="mono nowrap">{l.order}</td>
                          <td>{l.product}</td>
                          <td className="r">{l.qty}</td>
                          <td className="r mono">{eur(l.price)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </>
        )}
        {invStatus && Array.isArray(invStatus.invoices) && invStatus.invoices.length > 0 && (
          <details style={{ marginTop: 14 }}>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>Geüploade facturen ({invStatus.invoices.length})</summary>
            <div className="table-wrap" style={{ marginTop: 6 }}>
              <table className="table">
                <thead><tr><th>Factuur</th><th>Datum</th><th className="r">Orders</th><th className="r">Totaal</th></tr></thead>
                <tbody>
                  {invStatus.invoices.map((v: any, i: number) => (
                    <tr key={i}>
                      <td className="mono nowrap">{v.invoiceNo || "—"}</td>
                      <td className="nowrap">{v.invoiceDate || "—"}</td>
                      <td className="r">{v.orderCount}</td>
                      <td className="r mono">{eur(v.total || 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button className="bulkclear" style={{ marginTop: 10 }} onClick={resetInvoices} disabled={invBusy}>
              Alle inkoop-COGS voor {invShop} wissen
            </button>
          </details>
        )}
      </Card>

      {false && pending.length > 0 && (() => {
        const allSel = pending.length > 0 && pending.every((e: any) => psel.has(e.id));
        const toggleAll = () => { const n = new Set(psel); allSel ? pending.forEach((e: any) => n.delete(e.id)) : pending.forEach((e: any) => n.add(e.id)); setPsel(n); };
        return (
          <Card title="Wachtrij — nog niet meegeteld" subtitle={`${pending.length} regels · ${eur(pendingTotal)} · vink aan en keur goed`}>
            <div className="bulkbar" style={{ background: "var(--up-soft)", borderColor: "var(--up)", color: "var(--up)" }}>
              <span>{psel.size > 0 ? `${psel.size} geselecteerd` : `${pending.length} in wachtrij`}</span>
              {psel.size > 0 && <button className="bulkdel" style={{ background: "var(--up)" }} onClick={() => approve([...psel])} disabled={busy}>✓ Goedkeuren ({psel.size})</button>}
              {psel.size > 0 && <button className="bulkdel" style={{ background: "var(--down)" }} onClick={() => removeSelected([...psel])} disabled={busy}><Trash2 size={13} /> Verwijder ({psel.size})</button>}
              <button className="bulkclear" onClick={() => approve()} disabled={busy}>Alles goedkeuren</button>
              <button className="bulkclear" onClick={discard} disabled={busy}>Verwerp</button>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead><tr>
                  <th className="selcol"><input type="checkbox" checked={allSel} onChange={toggleAll} /></th>
                  <th>Datum</th><th>Omschrijving</th><th>Categorie</th><th className="r">Bedrag</th><th></th>
                </tr></thead>
                <tbody>
                  {pending.map((e: any, i: number) => (
                    <ExpenseRow key={e.id || i} e={e} cats={cats || []} selectable={true}
                      sel={psel.has(e.id)} onSel={() => togglePsel(e.id)}
                      show={(k: string) => ["date", "omschrijving", "category", "bedrag"].includes(k)}
                      onCat={editCat} onLabel={editLabel} onNote={() => {}} onApprove={(x: any) => approve([x.id])} />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })()}

      {false && income.length > 0 && (() => {
        const real = income.filter((e: any) => e.category !== "Transfer");
        const transf = income.filter((e: any) => e.category === "Transfer");
        const totReal = real.reduce((a, e) => a + (e.bedrag || 0), 0);
        const totTransf = transf.reduce((a, e) => a + (e.bedrag || 0), 0);
        return (
          <Card title="Inkomend — geld dat binnenkwam" subtitle={`${income.length} regels · echt inkomend ${eur(totReal)} · eigen overboekingen ${eur(totTransf)}`}>
            <p className="muted" style={{ marginTop: 0 }}>
              Voor je cashflow (erin/eruit). Je kunt elke regel een categorie geven ("wegboeken"). Dit telt <b>niet</b> mee in je winst — je omzet komt uit Shopify. Markeer geld tussen je eigen rekeningen als <b>Transfer</b>.
            </p>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Datum</th><th>Omschrijving</th><th>Categorie</th><th className="r">Bedrag</th></tr></thead>
                <tbody>
                  {income.map((e: any, i: number) => {
                    const opts = ["Inkomsten", "Transfer", "Privé", ...(cats || []).filter((c: string) => !["Inkomsten", "Transfer", "Privé"].includes(c))];
                    return (
                      <tr key={e.id || i}>
                        <td className="nowrap">{e.date ? ddmmyyyy(e.date) : "—"}</td>
                        <td title={e.omschrijving}>{e.omschrijving}</td>
                        <td>
                          <select className="rowsel" value={e.category} onChange={(ev) => editIncome(e, ev.target.value)}>
                            {opts.map((c: string) => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </td>
                        <td className="r mono strong green">+{eur(e.bedrag)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })()}

      {false && <button className="resetbtn" onClick={reset} disabled={busy} style={{ marginTop: 4 }}><Trash2 size={14} /> Goedgekeurde import wissen</button>}
    </>
  );
}

function ExpenseRow({ e, cats, show, sel, onSel, onCat, onNote, onLabel, onApprove, selectable = true }: any) {
  const [note, setNote] = useState(e.note || "");
  const [label, setLabel] = useState(e.label || "");
  useEffect(() => { setNote(e.note || ""); }, [e.note, e.id]);
  useEffect(() => { setLabel(e.label || ""); }, [e.label, e.id]);
  const options: string[] = cats.includes(e.category) ? cats : [e.category, ...cats];
  const excluded = EXCLUDED_CATS.includes(e.category);
  return (
    <tr className={`${e.edited ? "edited" : ""} ${sel ? "selrow" : ""} ${excluded ? "excl" : ""}`}>
      {selectable && <td className="selcol"><input type="checkbox" checked={!!sel} onChange={onSel} /></td>}
      {show("date") && <td className="nowrap">{e.date ? ddmmyyyy(e.date) : "—"}</td>}
      {show("omschrijving") && (
        <td>
          <input className="rowdesc" value={label} title={e.raw || ""} placeholder={e.raw || "omschrijving"}
            onChange={(ev) => setLabel(ev.target.value)}
            onBlur={() => { if (label !== (e.label || "")) onLabel(e, label); }}
            onKeyDown={(ev) => { if (ev.key === "Enter") (ev.target as HTMLInputElement).blur(); }} />
        </td>
      )}
      {show("category") && (
        <td>
          <select className={`rowsel ${excluded ? "selexcl" : ""}`} value={e.category} onChange={(ev) => onCat(e, ev.target.value)}>
            {options.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          {excluded && <span className="excltag">uitgesloten</span>}
        </td>
      )}
      {show("note") && (
        <td>
          <input className="rownote" value={note} placeholder="notitie…"
            onChange={(ev) => setNote(ev.target.value)}
            onBlur={() => { if (note !== (e.note || "")) onNote(e, note); }}
            onKeyDown={(ev) => { if (ev.key === "Enter") (ev.target as HTMLInputElement).blur(); }} />
        </td>
      )}
      {show("methode") && <td className="dim">{e.methode}</td>}
      {show("bedrag") && <td className="r mono strong">{eur(e.bedrag)}</td>}
      {onApprove && <td className="r"><button className="rowok" title="Goedkeuren" onClick={() => onApprove(e)}>✓</button></td>}
    </tr>
  );
}

function Kpi({ label, value, tone, sub }: any) {
  return (
    <div className={`kpi ${tone || ""}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value mono">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}
function Card({ title, subtitle, children }: any) {
  return (
    <section className="card">
      <div className="card-head"><h3>{title}</h3>{subtitle && <span>{subtitle}</span>}</div>
      <div className="card-body">{children}</div>
    </section>
  );
}
function TipCum({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  return <div className="tip"><div>{ddmmyyyy(payload[0].payload.date)}</div><b>{eur(payload[0].value)}</b></div>;
}
function TipDag({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return <div className="tip"><div>{ddmmyyyy(p.date)}</div><b className={p.dag >= 0 ? "green" : "red"}>{eur(p.dag)}</b></div>;
}
