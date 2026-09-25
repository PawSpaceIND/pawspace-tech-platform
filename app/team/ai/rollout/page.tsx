"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import StaffModule from "../../../components/staff-workspace/StaffModule";

type Snap = { stage?: string; stages?: string[]; staffEnabled?: boolean; customersEnabled?: boolean; updatedBy?: string | null; customerRolloutUatOnly?: boolean; customerRolloutApprovedHere?: boolean };
const wrap = { minHeight: "100vh", background: "var(--staff-bg)", padding: 28, fontFamily: "inherit", color: "var(--staff-text)" } as const;
const card = { background: "var(--staff-surface)", border: "1px solid var(--staff-line)", borderRadius: 14, padding: 18 } as const;
const LABEL: Record<string, string> = { off: "Off · everyone gets a human", staff_only: "Staff only · internal preview", customers: "Customers · full rollout" };

export default function AiRolloutPage() {
  const [snap, setSnap] = useState<Snap>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  async function load() { const r = await fetch("/api/ai-rollout", { cache: "no-store" }); const b = await r.json() as { data?: Snap; error?: string }; if (!r.ok) throw new Error(b.error || "AI rollout unavailable"); setSnap(b.data || {}); }
  useEffect(() => { let on = true; void fetch("/api/ai-rollout", { cache: "no-store" }).then(async r => { const b = await r.json() as { data?: Snap; error?: string }; if (!r.ok) throw new Error(b.error || "AI rollout unavailable"); if (on) setSnap(b.data || {}); }).catch(e => { if (on) setError(e instanceof Error ? e.message : "AI rollout unavailable"); }); return () => { on = false; }; }, []);
  async function set(stage: string) { setBusy(stage); setError(""); try { const r = await fetch("/api/ai-rollout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage, reason: `Set to ${stage} via admin` }) }); const b = await r.json() as { error?: string }; if (!r.ok) throw new Error(b.error || "Update failed"); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Update failed"); } finally { setBusy(""); } }
  const stage = snap.stage || "off", stages = snap.stages || ["off", "staff_only", "customers"];
  return <StaffModule><main style={wrap}><div style={{ maxWidth: 820, margin: "0 auto" }}>
    <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 18 }}><div><small style={{ fontWeight: 800, color: "var(--staff-primary)" }}>PAWSPACE TEAM · AI ROLLOUT</small><h1 style={{ margin: "7px 0" }}>Who can the AI talk to?</h1><p style={{ margin: 0, color: "var(--staff-muted)" }}>Staff-first rollout on top of the fail-closed provider + kill-switches. Customers get a human until you widen it.</p></div><Link href="/team/ai" style={{ padding: 10, background: "var(--staff-primary)", color: "var(--staff-on-primary)", borderRadius: 10, textDecoration: "none" }}>AI home</Link></header>
    {error && <div style={{ padding: 12, background: "var(--staff-danger-bg)", borderRadius: 10, marginBottom: 12 }}>{error}</div>}
    <div style={card}>
      <div style={{ fontSize: 15, color: "var(--staff-muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em" }}>Current stage</div>
      <div style={{ fontSize: 24, fontWeight: 800, margin: "6px 0 4px" }}>{LABEL[stage] || stage}</div>
      <div style={{ fontSize: 14, color: "var(--staff-muted)" }}>staff {snap.staffEnabled ? "on" : "off"} · customers {snap.customersEnabled ? "on" : "off"}{snap.updatedBy ? ` · by ${snap.updatedBy}` : ""}</div>
      {
        /* Owner decision 2026-09-22: the customer stage is honoured on UAT deployments only. Without
         * this line, setting "customers" here on any other deployment left the status reading
         * "customers off" with nothing to explain why, which reads as a broken button. */
        snap.customerRolloutUatOnly && snap.customerRolloutApprovedHere === false && <p role="note" style={{ fontSize: 14, color: "var(--staff-warning)", background: "var(--staff-warning-bg)", border: "1px solid var(--staff-line)", borderRadius: 10, padding: 10, marginTop: 12 }}>The customer stage is approved for UAT deployments only. On this deployment, selecting it keeps the AI at staff-only and customers continue to reach a human.</p>
      }
      <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>{stages.map(s => <button key={s} disabled={Boolean(busy) || s === stage} onClick={() => set(s)} style={{ flex: "1 1 30%", padding: 14, border: s === stage ? "2px solid var(--staff-line)" : "1px solid var(--staff-line)", background: s === stage ? "var(--staff-warning-bg)" : "var(--staff-surface)", borderRadius: 12, fontWeight: 800, cursor: s === stage ? "default" : "pointer" }}>{busy === s ? "…" : s.replace("_", " ")}</button>)}</div>
    </div>
    <p style={{ fontSize: 14, color: "var(--staff-muted)", marginTop: 14 }}>This never overrides a stricter control — if the AI provider isn&apos;t connected or a kill-switch is thrown, the AI stays off regardless of stage.</p>
  </div></main></StaffModule>;
}
