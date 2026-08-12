"use client";
import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

type Plan = { id: string; serviceCode: string; planCode: string; cityId: string; name: string; price: number; sessionCount: number; validityValue: number; validityUnit: string; active: boolean };
const wrap = { minHeight: "100vh", background: "#f7f4fb", padding: 28, fontFamily: "Arial,sans-serif", color: "#24133f" } as const;
const card = { background: "white", border: "1px solid #e5dcef", borderRadius: 14 } as const;
const SERVICES = ["grooming", "dog_training", "boarding", "pet_sitting", "dog_walking", "pet_taxi"];

export default function SubscriptionPlansPage() {
  const [rows, setRows] = useState<Plan[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() { const r = await fetch("/api/subscription-plans", { cache: "no-store" }); const b = await r.json() as { data?: Plan[]; error?: string }; if (!r.ok) throw new Error(b.error || "Plans unavailable"); setRows(b.data || []); }
  useEffect(() => { let on = true; void fetch("/api/subscription-plans", { cache: "no-store" }).then(async r => { const b = await r.json() as { data?: Plan[]; error?: string }; if (!r.ok) throw new Error(b.error || "Plans unavailable"); if (on) setRows(b.data || []); }).catch(e => { if (on) setError(e instanceof Error ? e.message : "Plans unavailable"); }); return () => { on = false; }; }, []);
  async function create(e: FormEvent<HTMLFormElement>) { e.preventDefault(); const fd = new FormData(e.currentTarget); setBusy(true); setError(""); try { const r = await fetch("/api/subscription-plans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ serviceCode: String(fd.get("serviceCode")), planCode: String(fd.get("planCode")), cityId: String(fd.get("cityId")), name: String(fd.get("name")), price: Number(fd.get("price")), sessionCount: Number(fd.get("sessionCount")), validityValue: Number(fd.get("validityValue")), validityUnit: String(fd.get("validityUnit")), servicePackageCode: String(fd.get("servicePackageCode")), reason: "New plan via admin" }) }); const b = await r.json() as { error?: string }; if (!r.ok) throw new Error(b.error || "Create failed"); e.currentTarget.reset(); await load(); } catch (x) { setError(x instanceof Error ? x.message : "Create failed"); } finally { setBusy(false); } }
  return <main style={wrap}><div style={{ maxWidth: 1200, margin: "0 auto" }}>
    <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 18 }}><div><small style={{ fontWeight: 800, color: "#6c39a8" }}>PAWSPACE TEAM · SUBSCRIPTION PLANS</small><h1 style={{ margin: "7px 0" }}>Plans for every service</h1><p style={{ margin: 0, color: "#746b7d" }}>Per city, with a validity window (days/months) that sets each customer&apos;s expiry from the booked date.</p></div><Link href="/team" style={{ padding: 10, background: "#4b168c", color: "white", borderRadius: 10, textDecoration: "none" }}>Team home</Link></header>
    {error && <div style={{ padding: 12, background: "#fff1f1", borderRadius: 10, marginBottom: 12 }}>{error}</div>}
    <form onSubmit={create} style={{ ...card, padding: 16, display: "grid", gridTemplateColumns: "1.2fr 1.2fr 2fr 1fr 1fr 1fr 1fr 1fr 1.3fr auto", gap: 8, marginBottom: 16 }}>
      <select name="serviceCode" required>{SERVICES.map(s => <option key={s} value={s}>{s}</option>)}</select>
      <input name="planCode" required placeholder="plan-code" />
      <input name="name" required placeholder="Plan name" />
      <input name="cityId" required placeholder="city" />
      <input name="price" type="number" min="0" required placeholder="₹ price" />
      <input name="sessionCount" type="number" min="1" required placeholder="sessions" />
      <input name="validityValue" type="number" min="1" required placeholder="validity" />
      <select name="validityUnit" required><option value="months">months</option><option value="days">days</option></select>
      <input name="servicePackageCode" required placeholder="package-code" />
      <button disabled={busy} style={{ background: "#F6920A", color: "white", border: 0, borderRadius: 8, fontWeight: 800 }}>{busy ? "…" : "Add"}</button>
    </form>
    <div style={{ ...card, overflow: "hidden" }}>
      <div style={{ padding: 14, borderBottom: "1px solid #eee6f5" }}><b>{rows.length} plan{rows.length === 1 ? "" : "s"}</b></div>
      {rows.length === 0 ? <p style={{ padding: 18, color: "#746b7d" }}>No plans yet — add one above.</p> : rows.map(p => <article key={p.id} style={{ padding: 14, borderBottom: "1px solid #f0ebf4", display: "flex", justifyContent: "space-between", gap: 12 }}><div><strong>{p.name}</strong> <small style={{ color: "#746b7d" }}>· {p.serviceCode} · {p.cityId}</small><small style={{ display: "block", marginTop: 3, color: "#746b7d" }}>{p.sessionCount} sessions · valid {p.validityValue} {p.validityUnit} · {p.active ? "active" : "inactive"}</small></div><div style={{ fontWeight: 800, fontSize: 17 }}>₹{Number(p.price).toLocaleString("en-IN")}</div></article>)}
    </div>
  </div></main>;
}
