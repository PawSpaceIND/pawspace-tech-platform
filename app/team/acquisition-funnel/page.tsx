"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

type Funnel = { appAcquisitionFunnel?: Record<string, number>; paymentRecovery?: Record<string, number>; inboundSalesFunnel?: { appInbound?: Record<string, number>; paymentRecovery?: Record<string, number> } };
const wrap = { minHeight: "100vh", background: "#f7f4fb", padding: 28, fontFamily: "Arial,sans-serif", color: "#24133f" } as const;
const card = { background: "white", border: "1px solid #e5dcef", borderRadius: 14, padding: 16 } as const;

export default function AcquisitionFunnelPage() {
  const [data, setData] = useState<Funnel>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() { const r = await fetch("/api/acquisition-funnel", { cache: "no-store" }); const b = await r.json() as { data?: Funnel; error?: string }; if (!r.ok) throw new Error(b.error || "Funnel unavailable"); setData(b.data || {}); }
  useEffect(() => { let on = true; void fetch("/api/acquisition-funnel", { cache: "no-store" }).then(async r => { const b = await r.json() as { data?: Funnel; error?: string }; if (!r.ok) throw new Error(b.error || "Funnel unavailable"); if (on) setData(b.data || {}); }).catch(e => { if (on) setError(e instanceof Error ? e.message : "Funnel unavailable"); }); return () => { on = false; }; }, []);
  async function refresh() { setBusy(true); setError(""); try { const r = await fetch("/api/acquisition-funnel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "refresh" }) }); const b = await r.json() as { error?: string }; if (!r.ok) throw new Error(b.error || "Refresh failed"); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Refresh failed"); } finally { setBusy(false); } }
  const f = data.appAcquisitionFunnel || {}, rec = data.paymentRecovery || {}, inb = data.inboundSalesFunnel || {};
  const stat = (label: string, value: number | undefined, hint?: string) => <div style={{ ...card }}><div style={{ fontSize: 12, color: "#746b7d", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em" }}>{label}</div><div style={{ fontSize: 30, fontWeight: 800, margin: "6px 0" }}>{Number(value || 0).toLocaleString("en-IN")}</div>{hint && <div style={{ fontSize: 12, color: "#746b7d" }}>{hint}</div>}</div>;
  return <main style={wrap}><div style={{ maxWidth: 1200, margin: "0 auto" }}>
    <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 18 }}>
      <div><small style={{ fontWeight: 800, color: "#6c39a8" }}>PAWSPACE TEAM · ACQUISITION FUNNEL</small><h1 style={{ margin: "7px 0" }}>App-to-Revenue funnel</h1><p style={{ margin: 0, color: "#746b7d" }}>Download → identify → booked / payment-pending / not-booked → convert. Payment-truthful.</p></div>
      <div style={{ display: "flex", gap: 8 }}><button disabled={busy} onClick={refresh} style={{ padding: 10, background: "#F6920A", color: "white", border: 0, borderRadius: 10, fontWeight: 800 }}>{busy ? "Refreshing…" : "Refresh sweep"}</button><Link href="/team" style={{ padding: 10, background: "#4b168c", color: "white", borderRadius: 10, textDecoration: "none" }}>Team home</Link></div>
    </header>
    {error && <div style={{ padding: 12, background: "#fff1f1", borderRadius: 10, marginBottom: 12 }}>{error}</div>}
    <h3>App Acquisition</h3>
    <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginBottom: 20 }}>
      {stat("Downloads", f.downloads)}{stat("Identified", f.identified)}{stat("Converted", f.converted, "payment captured")}{stat("Payment pending", f.paymentPending, "→ ₹300 + Sales")}{stat("Not booked", f.noBooking, "→ App-Inbound")}{stat("Conversion %", f.conversionRateFromIdentified, "of identified")}
    </section>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <div><h3>Payment recovery (₹300)</h3><section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>{stat("Issued", rec.issued)}{stat("Active", rec.active)}{stat("Redeemed", rec.redeemed)}{stat("Recovered", rec.recoveredBookings, "bookings")}</section></div>
      <div><h3>Inbound to Sales</h3><section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>{stat("App-Inbound active", (inb.appInbound || {}).active)}{stat("Recovery tasks active", (inb.paymentRecovery || {}).active)}</section></div>
    </div>
    <p style={{ fontSize: 12, color: "#746b7d", marginTop: 18 }}>Advisory intelligence — outreach stays human-launched. Refresh recomputes the funnel from the live book of record.</p>
  </div></main>;
}
