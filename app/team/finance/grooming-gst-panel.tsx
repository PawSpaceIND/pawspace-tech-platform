"use client";
import { useEffect, useState } from "react";

type Policy = { city_id: string; tax_mode: string; tax_rate: number; status: string; version: number; effective_from: string; updated_by: string; reason: string } | null;
const box = { background: "var(--staff-surface)", border: "1px solid var(--staff-line)", borderRadius: 14, padding: 18, marginBottom: 22 } as const;

/**
 * One place for Finance to publish the Bengaluru grooming GST policy that assisted-booking quotes and grooming
 * invoices read (owner decision: 18% included in the price). Publishing is audited server-side and needs
 * finance.manage; without a published policy assisted bookings are refused with a clear message.
 */
export default function GroomingGstPanel() {
  const [policy, setPolicy] = useState<Policy>(null);
  const [loaded, setLoaded] = useState(false);
  const [rate, setRate] = useState("18");
  const [effectiveFrom, setEffectiveFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    const response = await fetch("/api/grooming-finance?scope=tax_policy&cityId=blr", { cache: "no-store" });
    const body = await response.json().catch(() => ({})) as { data?: { policy: Policy }; error?: string };
    if (response.ok) setPolicy(body.data?.policy ?? null); else setMessage(body.error || "The GST policy could not be loaded");
    setLoaded(true);
  }
  useEffect(() => { const timer = setTimeout(() => { void load(); }, 0); return () => clearTimeout(timer); }, []);
  async function publish() {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/grooming-finance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "save_tax_policy", cityId: "blr", taxMode: "inclusive", taxRate: Number(rate), effectiveFrom, reason }) });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) { setMessage(body.error || "The GST policy was not published"); return; }
      setMessage("Published. Assisted-booking quotes and grooming invoices now use this policy."); setReason(""); await load();
    } finally { setBusy(false); }
  }
  const published = policy && policy.status === "published";
  return <section style={box} aria-label="Grooming GST">
    <h2 style={{ margin: "0 0 6px", fontSize: 18 }}>Grooming GST · Bengaluru</h2>
    <p style={{ margin: "0 0 12px", color: "var(--staff-muted)" }}>{!loaded ? "Loading the current policy…" : published ? `Published: ${policy.tax_rate}% GST ${policy.tax_mode === "inclusive" ? "included in the price" : "added to the price"}, from ${policy.effective_from} (version ${policy.version}).` : "No GST policy is published, so assisted bookings are refused until one is."}</p>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "end" }}>
      <label>GST rate (%)<br /><input type="number" min="0" max="40" step="0.01" value={rate} onChange={event => setRate(event.target.value)} style={{ width: 90 }} /></label>
      <label>Effective from<br /><input type="date" value={effectiveFrom} onChange={event => setEffectiveFrom(event.target.value)} /></label>
      <label style={{ flex: "1 1 260px" }}>Reason (at least 8 characters)<br /><input value={reason} onChange={event => setReason(event.target.value)} placeholder="e.g. Approved by CA for FY 26-27" style={{ width: "100%" }} /></label>
      <button type="button" disabled={busy || reason.trim().length < 8} onClick={() => void publish()}>{busy ? "Publishing…" : "Publish · GST included in price"}</button>
    </div>
    {message && <p role="status" style={{ margin: "10px 0 0" }}>{message}</p>}
  </section>;
}
