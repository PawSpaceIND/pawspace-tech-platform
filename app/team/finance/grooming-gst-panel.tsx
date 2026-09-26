"use client";
import { useEffect, useState } from "react";
import { gstOn, type GstMethod } from "../../../lib/gst-method";

type Setting = { settingId: string | null; cityId: string; scope: "city" | "all_cities" | "built_in_default"; ratePercent: number; method: GstMethod; effectiveFrom: string | null; version: number };
type Version = { id: string; city_id: string; rate_percent: number; method: GstMethod; effective_from: string; version: number; reason: string; created_by: string };
type Directory = { platform: Setting; cities: Setting[]; knownCities?: { cityId: string; name: string }[]; history: Version[] };
const box = { background: "var(--staff-surface)", border: "1px solid var(--staff-line)", borderRadius: 14, padding: 18, marginBottom: 22 } as const;
const rupees = (value: number) => `Rs ${value.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const cityLabel = (cityId: string, known?: { cityId: string; name: string }[]) => cityId === "*" ? "All cities" : known?.find(item => item.cityId === cityId)?.name ?? (cityId === "blr" ? "Bengaluru" : cityId.toUpperCase());
const methodName = (method: GstMethod, rate: number) => method === "extract_inclusive" ? `taken out of an amount that already includes ${rate}% GST` : `${rate}% of the amount`;

/**
 * The ONE GST setting for every PawSpace service (owner decision 1, 26 Sept 2026): a rate and a method, per city with an
 * all-cities default, effective from a date. Commission jobs pay it on PawSpace's commission, own supply on the whole amount
 * paid, funeral and memorial pay none. Publishing needs finance.manage and a reason, and is audited server-side.
 * Grooming quotes keep showing GST as included in the price (owner decision 9: not decided yet) at the rate published here.
 */
export default function GstSettingPanel() {
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [cityId, setCityId] = useState("*");
  const [rate, setRate] = useState("18");
  const [method, setMethod] = useState<GstMethod>("percent_of_base");
  const [effectiveFrom, setEffectiveFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const cityName = (id: string) => cityLabel(id, directory?.knownCities);
  async function load() {
    const response = await fetch("/api/grooming-finance?scope=gst_setting", { cache: "no-store" });
    const body = await response.json().catch(() => ({})) as { data?: Directory; error?: string };
    if (response.ok && body.data) setDirectory(body.data); else setMessage(body.error || "The GST setting could not be loaded");
    setLoaded(true);
  }
  useEffect(() => { const timer = setTimeout(() => { void load(); }, 0); return () => clearTimeout(timer); }, []);
  async function publish() {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/grooming-finance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "save_gst_setting", cityId, ratePercent: Number(rate), method, effectiveFrom, reason }) });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) { setMessage(body.error || "The GST setting was not published"); return; }
      setMessage(`Published for ${cityName(cityId)} from ${effectiveFrom}. PawSpace's GST on every service uses it for bookings from that date.`); setReason(""); await load();
    } finally { setBusy(false); }
  }
  const policy = { ratePercent: Number(rate) || 0, method };
  const commissionGst = gstOn(300, policy), ownSupplyGst = gstOn(1000, policy);
  const current = directory?.platform;
  const cities = [...new Set(["*", "blr", ...(directory?.knownCities ?? []).map(item => item.cityId), ...(directory?.cities ?? []).map(item => item.cityId)])];
  return <section style={box} aria-label="GST setting">
    <h2 style={{ margin: "0 0 6px", fontSize: 18 }}>GST setting · all services</h2>
    <p style={{ margin: "0 0 6px", color: "var(--staff-muted)" }}>{!loaded ? "Loading the current setting…" : current ? `All cities: GST is ${methodName(current.method, current.ratePercent)}${current.scope === "built_in_default" ? " (the owner's default; nothing has been published yet)" : `, from ${current.effectiveFrom} (version ${current.version})`}.` : "The current setting could not be read."}</p>
    {directory && directory.cities.length > 0 && <p style={{ margin: "0 0 6px", color: "var(--staff-muted)" }}>{directory.cities.map(item => `${cityName(item.cityId)}: ${methodName(item.method, item.ratePercent)} from ${item.effectiveFrom}`).join(" · ")}</p>}
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "end", marginTop: 12 }}>
      <label>Applies to<br /><select value={cityId} onChange={event => setCityId(event.target.value)}>{cities.map(city => <option key={city} value={city}>{cityName(city)}</option>)}</select></label>
      <label>GST rate (%)<br /><input type="number" min="0" max="40" step="0.01" value={rate} onChange={event => setRate(event.target.value)} style={{ width: 90 }} /></label>
      <fieldset style={{ border: "1px solid var(--staff-line)", borderRadius: 10, padding: "6px 10px" }}><legend>How GST is worked out</legend>
        <label style={{ display: "block" }}><input type="radio" name="gst-method" value="percent_of_base" checked={method === "percent_of_base"} onChange={() => setMethod("percent_of_base")} /> The rate applied to the amount (owner&apos;s choice)</label>
        <label style={{ display: "block" }}><input type="radio" name="gst-method" value="extract_inclusive" checked={method === "extract_inclusive"} onChange={() => setMethod("extract_inclusive")} /> Taken out of an amount that already includes GST (only if the CA says so)</label>
      </fieldset>
      <label>Effective from<br /><input type="date" value={effectiveFrom} onChange={event => setEffectiveFrom(event.target.value)} /></label>
      <label style={{ flex: "1 1 260px" }}>Reason (at least 8 characters)<br /><input value={reason} onChange={event => setReason(event.target.value)} placeholder="e.g. Confirmed by our CA for FY 26-27" style={{ width: "100%" }} /></label>
      <button type="button" disabled={busy || reason.trim().length < 8} onClick={() => void publish()}>{busy ? "Publishing…" : "Publish GST setting"}</button>
    </div>
    <div style={{ marginTop: 14, padding: 12, borderRadius: 10, background: "var(--staff-raised)" }} aria-label="Worked example">
      <b>Worked example: a customer pays Rs 1,000</b>
      <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
        <li>Commission job at 70/30 (every service except funeral): provider gets Rs 700, PawSpace&apos;s commission is Rs 300, GST {rupees(commissionGst)}, PawSpace keeps {rupees(300 - commissionGst)}.</li>
        <li>Own supply (full-time provider or company vehicle): GST {rupees(ownSupplyGst)} on the whole Rs 1,000, PawSpace keeps {rupees(1000 - ownSupplyGst)}.</li>
        <li>Funeral and memorial: no GST (exempt).</li>
        <li>TCS of 0.5% (Rs 5) is held back from the provider only if they have given us a GSTIN.</li>
      </ul>
      <small style={{ display: "block", marginTop: 6, color: "var(--staff-muted)" }}>Grooming quotes still show GST as included in the price, at this rate, until the owner decides how GST is shown to customers.</small>
    </div>
    {directory && directory.history.length > 0 && <details style={{ marginTop: 12 }}><summary>Earlier versions</summary><ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>{directory.history.slice(0, 10).map(row => <li key={row.id}>{cityName(row.city_id)} v{row.version}: {methodName(row.method, row.rate_percent)} from {row.effective_from}, by {row.created_by} ({row.reason})</li>)}</ul></details>}
    {message && <p role="status" style={{ margin: "10px 0 0" }}>{message}</p>}
  </section>;
}
