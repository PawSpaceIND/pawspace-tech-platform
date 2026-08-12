"use client";
import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

type Rule = { id: string; name: string; serviceCode: string; cityId: string; ruleType: string; adjustmentType: string; adjustmentValue: number; effectiveFrom: string; effectiveTo: string | null; status: string };
type Sug = { name: string; serviceCode: string; cityId: string; effectiveFrom: string; effectiveTo: string; adjustmentValue: number; lengthDays: number; holidays: string[] };
const wrap = { minHeight: "100vh", background: "#f7f4fb", padding: 28, fontFamily: "Arial,sans-serif", color: "#24133f" } as const;
const card = { background: "white", border: "1px solid #e5dcef", borderRadius: 14 } as const;
const SERVICES = ["grooming", "dog_training", "boarding", "pet_sitting", "dog_walking", "pet_taxi"];
const YEAR = 2026;

export default function PricingRulesPage() {
  const [rows, setRows] = useState<Rule[]>([]);
  const [sugs, setSugs] = useState<Sug[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() { const r = await fetch("/api/pricing-rules", { cache: "no-store" }); const b = await r.json() as { data?: Rule[]; error?: string }; if (!r.ok) throw new Error(b.error || "Pricing unavailable"); setRows(b.data || []); }
  useEffect(() => { let on = true; void fetch("/api/pricing-rules", { cache: "no-store" }).then(async r => { const b = await r.json() as { data?: Rule[]; error?: string }; if (!r.ok) throw new Error(b.error || "Pricing unavailable"); if (on) setRows(b.data || []); }).catch(e => { if (on) setError(e instanceof Error ? e.message : "Pricing unavailable"); }); return () => { on = false; }; }, []);
  async function post(body: Record<string, unknown>) { const r = await fetch("/api/pricing-rules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const b = await r.json() as { error?: string }; if (!r.ok) throw new Error(b.error || "Action failed"); }
  async function suggest() { setBusy(true); setError(""); try { await post({ action: "seed_holidays", year: YEAR }); const r = await fetch(`/api/pricing-rules?mode=suggest&year=${YEAR}&serviceCode=boarding&cityId=blr&pct=20`, { cache: "no-store" }); const b = await r.json() as { data?: Sug[]; error?: string }; if (!r.ok) throw new Error(b.error || "Suggest failed"); setSugs(b.data || []); } catch (e) { setError(e instanceof Error ? e.message : "Suggest failed"); } finally { setBusy(false); } }
  async function apply(s: Sug) { setBusy(true); setError(""); try { await post({ action: "apply_suggestion", name: s.name, serviceCode: s.serviceCode, cityId: s.cityId, startDate: s.effectiveFrom, endDate: s.effectiveTo, adjustmentPercent: s.adjustmentValue }); setSugs(prev => prev.filter(x => x !== s)); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Apply failed"); } finally { setBusy(false); } }
  async function create(e: FormEvent<HTMLFormElement>) { e.preventDefault(); const fd = new FormData(e.currentTarget); setBusy(true); setError(""); try { await post({ action: "create_rule", name: String(fd.get("name")), serviceCode: String(fd.get("serviceCode")), cityId: String(fd.get("cityId")), ruleType: String(fd.get("ruleType")), effectiveFrom: String(fd.get("effectiveFrom")), adjustmentType: "percent", adjustmentValue: Number(fd.get("adjustmentValue")) }); e.currentTarget.reset(); await load(); } catch (x) { setError(x instanceof Error ? x.message : "Create failed"); } finally { setBusy(false); } }
  return <main style={wrap}><div style={{ maxWidth: 1200, margin: "0 auto" }}>
    <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 18 }}><div><small style={{ fontWeight: 800, color: "#6c39a8" }}>PAWSPACE TEAM · DYNAMIC PRICING</small><h1 style={{ margin: "7px 0" }}>Rules & holiday surcharge</h1><p style={{ margin: 0, color: "#746b7d" }}>City/zone rules (weekend, slot, weekday, season, date-range) + long-weekend auto-suggest for {YEAR}.</p></div><div style={{ display: "flex", gap: 8 }}><button disabled={busy} onClick={suggest} style={{ padding: 10, background: "#E6B34E", color: "#041517", border: 0, borderRadius: 10, fontWeight: 800 }}>{busy ? "…" : `Suggest ${YEAR} long weekends`}</button><Link href="/team" style={{ padding: 10, background: "#4b168c", color: "white", borderRadius: 10, textDecoration: "none" }}>Team home</Link></div></header>
    {error && <div style={{ padding: 12, background: "#fff1f1", borderRadius: 10, marginBottom: 12 }}>{error}</div>}
    {sugs.length > 0 && <div style={{ ...card, padding: 14, marginBottom: 16, background: "#fffaf0" }}><b>Suggested surcharge windows (boarding · blr · +20%)</b>{sugs.map((s, i) => <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: "1px solid #f0ebf4" }}><div><strong>{s.effectiveFrom} → {s.effectiveTo}</strong> <small style={{ color: "#746b7d" }}>· {s.lengthDays} days · {s.holidays.join(", ")}</small></div><button disabled={busy} onClick={() => apply(s)} style={{ background: "#F6920A", color: "white", border: 0, borderRadius: 8, fontWeight: 800, padding: "7px 12px" }}>Apply +{s.adjustmentValue}%</button></div>)}</div>}
    <form onSubmit={create} style={{ ...card, padding: 16, display: "grid", gridTemplateColumns: "2fr 1.2fr 1fr 1.2fr 1.2fr 1fr auto", gap: 8, marginBottom: 16 }}>
      <input name="name" required placeholder="Rule name" />
      <select name="serviceCode" required>{SERVICES.map(s => <option key={s} value={s}>{s}</option>)}</select>
      <input name="cityId" required placeholder="city" />
      <select name="ruleType" required><option value="weekend">weekend</option><option value="time_band">time_band</option><option value="weekday">weekday</option><option value="season">season</option><option value="date_range">date_range</option></select>
      <input name="effectiveFrom" required placeholder="2026-01-01" />
      <input name="adjustmentValue" type="number" required placeholder="% (+/-)" />
      <button disabled={busy} style={{ background: "#F6920A", color: "white", border: 0, borderRadius: 8, fontWeight: 800 }}>{busy ? "…" : "Add rule"}</button>
    </form>
    <div style={{ ...card, overflow: "hidden" }}>
      <div style={{ padding: 14, borderBottom: "1px solid #eee6f5" }}><b>{rows.length} rule{rows.length === 1 ? "" : "s"}</b></div>
      {rows.length === 0 ? <p style={{ padding: 18, color: "#746b7d" }}>No rules yet.</p> : rows.map(p => <article key={p.id} style={{ padding: 14, borderBottom: "1px solid #f0ebf4", display: "flex", justifyContent: "space-between", gap: 12 }}><div><strong>{p.name}</strong> <small style={{ color: "#746b7d" }}>· {p.serviceCode} · {p.cityId} · {p.ruleType}</small><small style={{ display: "block", marginTop: 3, color: "#746b7d" }}>{p.effectiveFrom}{p.effectiveTo ? ` → ${p.effectiveTo}` : ""} · {p.status}</small></div><div style={{ fontWeight: 800, fontSize: 16 }}>{p.adjustmentValue > 0 ? "+" : ""}{p.adjustmentValue}%</div></article>)}
    </div>
  </div></main>;
}
