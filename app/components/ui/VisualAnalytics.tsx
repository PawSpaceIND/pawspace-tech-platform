"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import AnalyticsBookings from "./AnalyticsBookings";
import type { BookingSlice } from "../../../lib/analytics-bookings";
import TrendChart from "./TrendChart";
import { alignDaily, comparisonLabel, previousRange, rangeDays, recentRange, type DateRange } from "../../../lib/analytics-visuals";
import css from "./visual-analytics.module.css";
type Snapshot = { sourceStatus?: Record<string, string>; dataQuality?: Record<string, number>; providers?: { active: number }; cx?: { open: number }; daily?: { date: string; gmv: number }[]; degraded?: { headline: string; entries: { source: string; reason: string }[] } | null; money: { gmv: number; collected: number }; bookings: { total: number; completed: number; cancelled: number }; customers: { unique: number; repeatRate?: number | null }; services: Record<string, { gmv: number; collected: number; bookings: number }> };
const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);
const compact = (value: number) => new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
type Props = { serviceCode?: string; title?: string };
const subscribeToHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;
export default function VisualAnalytics(props: Props) {
  // Date presets are calculated only after hydration, avoiding a midnight server/client mismatch.
  const hydrated = useSyncExternalStore(subscribeToHydration, clientSnapshot, serverSnapshot);
  return hydrated ? <VisualAnalyticsContent {...props} /> : <p role="status">Loading performance controls…</p>;
}
function VisualAnalyticsContent({ serviceCode: lockedService, title = "Business performance" }: Props) {
  const [selectedService, setSelectedService] = useState("");
  const serviceCode = lockedService || selectedService;
  const [drilldown, setDrilldown] = useState<{ key: string; slice: BookingSlice } | null>(null);
  const [range, setRange] = useState<DateRange>(() => recentRange(30));
  const [draft, setDraft] = useState<DateRange>(range);
  const [validation, setValidation] = useState("");
  const [revision, setRevision] = useState(0);
  const requestKey = `${range.from}:${range.to}:${serviceCode ?? ""}:${revision}`;
  const [responseState, setResponseState] = useState<{ key: string; result?: { current: Snapshot; previous: Snapshot; updated: string }; error?: string } | null>(null);
  const loading = responseState?.key !== requestKey;
  const result = loading ? null : responseState?.result ?? null;
  const error = loading ? "" : responseState?.error ?? "";
  useEffect(() => {
    const controller = new AbortController();
    const read = async (window: DateRange): Promise<Snapshot> => {
      const query = new URLSearchParams(window);
      if (serviceCode) query.set("serviceCode", serviceCode);
      const response = await fetch(`/api/company-analytics?${query}`, { cache: "no-store", signal: controller.signal });
      const body = await response.json();
      if (!response.ok || !body.data?.money || !body.data?.bookings || !body.data?.customers || !body.data?.services) throw new Error(body.error || "Performance data unavailable for your account.");
      return body.data;
    };
    Promise.all([read(range), read(previousRange(range))]).then(([current, previous]) => {
      if (!controller.signal.aborted) setResponseState({ key: requestKey, result: { current, previous, updated: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) } });
    }).catch(reason => { if (!controller.signal.aborted) setResponseState({ key: requestKey, error: reason instanceof Error ? reason.message : "Performance data unavailable." }); });
    return () => controller.abort();
  }, [range, serviceCode, requestKey]);
  const apply = () => { try { if (rangeDays(draft) > 366) throw new Error("Choose 366 days or fewer."); setValidation(""); setRange({ ...draft }); } catch (reason) { setValidation((reason as Error).message); } };
  const prior = range ? previousRange(range) : null;
  const current = result?.current, previous = result?.previous;
  const degraded = !!(current?.degraded || previous?.degraded);
  const daily = range && current?.daily && previous?.daily && !degraded ? alignDaily(range, current.daily, previous.daily) : [];
  const services = current && previous ? [...new Set([...Object.keys(current.services), ...Object.keys(previous.services)])].map(code => ({ code, name: code.replaceAll("_", " "), current: current.services[code]?.gmv ?? 0, previous: previous.services[code]?.gmv ?? 0 })) : [];
  const outcomes = current ? [{ name: "Completed", value: current.bookings.completed, color: "var(--staff-primary, var(--paw-primary,#11885b))" }, { name: "Cancelled", value: current.bookings.cancelled, color: "var(--staff-danger, var(--paw-danger,#af3444))" }, { name: "Other statuses", value: Math.max(0, current.bookings.total - current.bookings.completed - current.bookings.cancelled), color: "var(--staff-gold, var(--paw-gold,#eab648))" }] : [];
  const cards = current && previous ? [{ name: "Booking revenue · GMV", value: current.money.gmv, prior: previous.money.gmv, currency: true }, { name: "Collected on these bookings", value: current.money.collected, prior: previous.money.collected, currency: true }, { name: "Bookings", value: current.bookings.total, prior: previous.bookings.total }, { name: "Unique customers", value: current.customers.unique, prior: previous.customers.unique }] : [];
  const openBookings = (slice: BookingSlice) => setDrilldown({ key: requestKey, slice });
  const exportReport = () => {
    if (!current || !previous || degraded) return;
    const rows: (string | number)[][] = [["PawSpace business performance", "INR", serviceCode || "All services"], ["Selected from", range.from, "Selected to", range.to], ["Previous from", prior!.from, "Previous to", prior!.to], ["Metric", "Selected", "Previous"], ...cards.map(card => [card.name, card.value, card.prior]), [], ["Service", "Selected GMV", "Previous GMV", "Selected bookings", "Selected collected"], ...services.map(row => [row.name, row.current, row.previous, current.services[row.code]?.bookings || 0, current.services[row.code]?.collected || 0]), [], ["Selected date", "Selected GMV", "Previous date", "Previous GMV"], ...daily.map(row => [row.date, row.current, row.previousDate, row.previous]), [], ["Definition", "Service-date booking cohorts; GMV excludes cancelled and draft bookings. Collections reflect current payment state, not collection date."]];
    const csv = rows.map(row => row.map(value => { const text = String(value); return '"' + (typeof value === "string" && /^[=+@\-\t\r]/.test(text) ? "'" + text : text).replaceAll('"', '""') + '"'; }).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `pawspace-${serviceCode || "all"}-${range.from}-${range.to}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className={css.panel} aria-label={title}>
    <header className={css.header}><div><span className={css.eyebrow}>PAWSPACE INTELLIGENCE</span><h2>{title}</h2><div className={css.muted}>Service-date cohorts · INR · {serviceCode ? serviceCode.replaceAll("_", " ") : "All services"}</div></div>{result && <small className={css.muted}>Updated {result.updated} IST</small>}</header>
    <div className={css.controls}>
      <label>Quick range<select defaultValue="" onChange={event => { if (!event.target.value) return; const next = recentRange(Number(event.target.value)); setDraft(next); setRange(next); setValidation(""); event.target.value = ""; }}><option value="">Choose complete days</option><option value="7">Last 7 complete days</option><option value="30">Last 30 complete days</option><option value="90">Last 90 complete days</option></select></label>
      {!lockedService && <label>Service<select value={selectedService} onChange={event => { setSelectedService(event.target.value); setDrilldown(null); }}><option value="">All services</option>{[...new Set(["grooming", "boarding", "daycare", "dog_walking", "dog_training", "pet_sitting", "pet_taxi", "vet_consult", ...Object.keys(current?.services || {}), selectedService])].filter(Boolean).map(code => <option key={code} value={code}>{code.replaceAll("_", " ")}</option>)}</select></label>}
      <label>From<input type="date" value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })} /></label><label>To<input type="date" value={draft.to} onChange={event => setDraft({ ...draft, to: event.target.value })} /></label>
      <button onClick={apply}>Apply dates</button><button onClick={() => setRevision(value => value + 1)} disabled={loading}>Refresh</button>
    </div>
    <button className={css.action} disabled={!result || degraded || !!error} onClick={exportReport}>Export this report · CSV</button>
    {validation && <p role="alert">{validation}</p>}
    {range && prior && <p className={css.muted}><b>{range.from} → {range.to}</b> compared with <b>{prior.from} → {prior.to}</b> · {rangeDays(range)} days each. These filters apply to every total, chart, service row and export in this panel.</p>}
    {loading && <p role="status" className={css.empty}>Loading both reporting periods…</p>}
    {error && <p role="alert" className={css.notice}>{error} Use Refresh to try again.</p>}
    {result && degraded && <div role="status" className={css.notice}><b>Comparison unavailable: source data is incomplete.</b>{[current?.degraded, previous?.degraded].filter(Boolean).map((notice, index) => <p key={index}>{index === 0 ? "Current / previous sources" : "Previous sources"}: {notice!.headline} {notice!.entries.map(entry => entry.source).join(", ")}</p>)}</div>}
    {result && !degraded && current && previous && <>
      <div className={css.metrics}>{cards.map(card => <article className={css.metric} key={card.name}><small>{card.name}</small><strong>{card.currency ? money(card.value) : card.value.toLocaleString("en-IN")}</strong><div className={css.muted}>{comparisonLabel(card.value, card.prior)}<br />Previous: {card.currency ? money(card.prior) : card.prior.toLocaleString("en-IN")}</div></article>)}</div>
      <div className={css.controls}><button onClick={() => openBookings({ ...range, serviceCode, status: "all" })}>Explore bookings</button><button onClick={() => openBookings({ ...range, serviceCode, status: "recognized" })}>Explore revenue bookings</button></div>
      {drilldown?.key === requestKey && <AnalyticsBookings key={JSON.stringify(drilldown.slice)} slice={drilldown.slice} onClose={() => setDrilldown(null)} />}
      <div className={css.notice}>{current.bookings.total === 0 ? "No bookings in this period. Choose another date range to explore historical activity." : `Revenue changed by ${money(current.money.gmv - previous.money.gmv)} across ${current.bookings.total} bookings. ${current.bookings.cancelled} bookings were cancelled.`} Collections reflect the current payment state of bookings scheduled in each period, not cash received on those dates.</div>
      <div className={css.grid}>
        <article className={`${css.chart} ${css.wide}`}><h3>Revenue over time</h3><p className={css.muted}>Equal-length periods aligned by day. The data table includes both exact dates. Cancelled and draft bookings are excluded from GMV.</p>{daily.length ? <><TrendChart data={daily} xKey="date" series={[{ key: "current", label: "Selected period" }, { key: "previous", label: "Previous period", dashed: true }]} valueFormatter={money} axisValueFormatter={compact} height={280} onSelect={(row, series) => { const date = String(series === "previous" ? row.previousDate : row.date); openBookings({ from: date, to: date, serviceCode, status: "recognized" }); }} /><details className={css.table}><summary>View daily values and comparison dates</summary><table><thead><tr><th>Selected date</th><th>Revenue</th><th>Comparison date</th><th>Revenue</th></tr></thead><tbody>{daily.map(row => <tr key={row.date}><td>{row.date}</td><td><button className={css.action} onClick={() => openBookings({ from: row.date, to: row.date, serviceCode, status: "recognized" })}>{money(row.current)}</button></td><td>{row.previousDate}</td><td><button className={css.action} onClick={() => openBookings({ from: row.previousDate, to: row.previousDate, serviceCode, status: "recognized" })}>{money(row.previous)}</button></td></tr>)}</tbody></table></details></> : <p className={css.empty}>Daily history is unavailable from this source.</p>}</article>
        <article className={css.chart}><h3>Service revenue comparison</h3><TrendChart data={services} xKey="name" type="bar" series={[{ key: "current", label: "Selected period" }, { key: "previous", label: "Previous period" }]} valueFormatter={money} axisValueFormatter={compact} onSelect={(row, series) => openBookings({ ...(series === "previous" ? prior! : range), serviceCode: String(row.code), status: "recognized" })} /><p className={css.muted}>Select a bar or a value in its data table to explore bookings.</p></article>
        <article className={css.chart}><h3>Booking outcomes</h3><p className={css.muted}>Selected service-date period · current booking statuses</p><div className={css.meter} role="img" aria-label={outcomes.map(row => `${row.name}: ${row.value}`).join(", ")}>{outcomes.map(row => <span key={row.name} style={{ width: `${current.bookings.total ? row.value / current.bookings.total * 100 : 0}%`, background: row.color }} />)}</div><div className={css.legend}>{outcomes.map(row => <button className={css.action} onClick={() => openBookings({ ...range, serviceCode, status: row.name === "Completed" ? "completed" : row.name === "Cancelled" ? "cancelled" : "other" })} key={row.name}><i className={css.dot} style={{ background: row.color }} />{row.name}: <b>{compact(row.value)}</b></button>)}</div><p className={css.muted}>{current.bookings.total ? `${(current.bookings.completed / current.bookings.total * 100).toFixed(1)}% completed` : "No bookings to calculate completion."}</p></article>
      </div>
      <article className={css.chart} style={{ marginTop: 20 }}><h3>Customer and service health</h3><p className={css.muted}>Repeat customers in selected cohort: {current.customers.repeatRate == null ? "Unavailable" : `${(current.customers.repeatRate * 100).toFixed(1)}%`} · Open support cases for these bookings: {current.cx?.open ?? "Unavailable"}</p><details><summary>Source health and coverage</summary><p className={css.muted}>Active providers (current company inventory, independent of reporting dates): {current.providers?.active ?? "Unavailable"}. Orphan support tickets are also a company-wide quality check.</p>{Object.entries(current.sourceStatus || {}).map(([name, status]) => <p key={name}>{name.replaceAll("_", " ")}: {status}</p>)}{Object.entries(current.dataQuality || {}).map(([name, count]) => <p key={name}>{name}: {count}</p>)}</details></article>
      <article className={css.chart} style={{ marginTop: 20 }}><h3>Service performance</h3><p className={css.muted}>Selected dates and service · click a booking count to inspect the matching records.</p><div className={css.table}><table><thead><tr><th>Service</th><th>Bookings</th><th>Revenue</th><th>Previous revenue</th><th>Change</th><th>Collected</th></tr></thead><tbody>{services.map(row => <tr key={row.code}><th>{row.name}</th><td><button className={css.action} onClick={() => openBookings({ ...range, serviceCode: row.code, status: "all" })}>{current.services[row.code]?.bookings || 0}</button></td><td>{money(row.current)}</td><td>{money(row.previous)}</td><td>{comparisonLabel(row.current, row.previous)}</td><td>{money(current.services[row.code]?.collected || 0)}</td></tr>)}</tbody></table></div></article>
    </>}
  </section>;
}
