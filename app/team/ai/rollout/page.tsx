"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

type Snap = { stage?: string; stages?: string[]; staffEnabled?: boolean; customersEnabled?: boolean; updatedBy?: string | null };
const wrap = { minHeight: "100vh", background: "#f2f7f5", padding: 28, fontFamily: "Arial,sans-serif", color: "#06231c" } as const;
const card = { background: "white", border: "1px solid #dcece5", borderRadius: 14, padding: 18 } as const;
const LABEL: Record<string, string> = { off: "Off · everyone gets a human", staff_only: "Staff only · internal preview", customers: "Customers · full rollout" };

export default function AiRolloutPage() {
  const [snap, setSnap] = useState<Snap>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  async function load() { const r = await fetch("/api/ai-rollout", { cache: "no-store" }); const b = await r.json() as { data?: Snap; error?: string }; if (!r.ok) throw new Error(b.error || "AI rollout unavailable"); setSnap(b.data || {}); }
  useEffect(() => { let on = true; void fetch("/api/ai-rollout", { cache: "no-store" }).then(async r => { const b = await r.json() as { data?: Snap; error?: string }; if (!r.ok) throw new Error(b.error || "AI rollout unavailable"); if (on) setSnap(b.data || {}); }).catch(e => { if (on) setError(e instanceof Error ? e.message : "AI rollout unavailable"); }); return () => { on = false; }; }, []);
  async function set(stage: string) { setBusy(stage); setError(""); try { const r = await fetch("/api/ai-rollout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage, reason: `Set to ${stage} via admin` }) }); const b = await r.json() as { error?: string }; if (!r.ok) throw new Error(b.error || "Update failed"); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Update failed"); } finally { setBusy(""); } }
  const stage = snap.stage || "off", stages = snap.stages || ["off", "staff_only", "customers"];
  return <main style={wrap}><div style={{ maxWidth: 820, margin: "0 auto" }}>
    <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 18 }}><div><small style={{ fontWeight: 800, color: "#1f6b57" }}>PAWSPACE TEAM · AI ROLLOUT</small><h1 style={{ margin: "7px 0" }}>Who can the AI talk to?</h1><p style={{ margin: 0, color: "#6c7c78" }}>Staff-first rollout on top of the fail-closed provider + kill-switches. Customers get a human until you widen it.</p></div><Link href="/team/ai" style={{ padding: 10, background: "#01261F", color: "white", borderRadius: 10, textDecoration: "none" }}>AI home</Link></header>
    {error && <div style={{ padding: 12, background: "#fff1f1", borderRadius: 10, marginBottom: 12 }}>{error}</div>}
    <div style={card}>
      <div style={{ fontSize: 13, color: "#6c7c78", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em" }}>Current stage</div>
      <div style={{ fontSize: 24, fontWeight: 800, margin: "6px 0 4px" }}>{LABEL[stage] || stage}</div>
      <div style={{ fontSize: 12, color: "#6c7c78" }}>staff {snap.staffEnabled ? "on" : "off"} · customers {snap.customersEnabled ? "on" : "off"}{snap.updatedBy ? ` · by ${snap.updatedBy}` : ""}</div>
      <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>{stages.map(s => <button key={s} disabled={Boolean(busy) || s === stage} onClick={() => set(s)} style={{ flex: "1 1 30%", padding: 14, border: s === stage ? "2px solid #F6920A" : "1px solid #dcece5", background: s === stage ? "#fff6ec" : "white", borderRadius: 12, fontWeight: 800, cursor: s === stage ? "default" : "pointer" }}>{busy === s ? "…" : s.replace("_", " ")}</button>)}</div>
    </div>
    <p style={{ fontSize: 12, color: "#6c7c78", marginTop: 14 }}>This never overrides a stricter control — if the AI provider isn&apos;t connected or a kill-switch is thrown, the AI stays off regardless of stage.</p>
  </div></main>;
}
