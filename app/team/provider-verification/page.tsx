"use client";
import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import StaffModule from "../../components/staff-workspace/StaffModule";

type Snap = { types?: { code: string; label: string; automatable: boolean }[]; categories?: { category: string; required: string[] }[] };
type Status = { required?: string[]; checks?: { verificationType: string; status: string; automatable: boolean }[]; canTakeAssignments?: boolean };
const wrap = { minHeight: "100vh", background: "var(--staff-bg)", padding: 28, fontFamily: "inherit", color: "var(--staff-text)" } as const;
const card = { background: "var(--staff-surface)", border: "1px solid var(--staff-line)", borderRadius: 14, padding: 16 } as const;

export default function ProviderVerificationPage() {
  const [snap, setSnap] = useState<Snap>({});
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { let on = true; void fetch("/api/provider-verification", { cache: "no-store" }).then(async r => { const b = await r.json() as { data?: Snap; error?: string }; if (!r.ok) throw new Error(b.error || "Unavailable"); if (on) setSnap(b.data || {}); }).catch(e => { if (on) setError(e instanceof Error ? e.message : "Unavailable"); }); return () => { on = false; }; }, []);
  async function checkApp(e: FormEvent<HTMLFormElement>) { e.preventDefault(); const fd = new FormData(e.currentTarget); setBusy(true); setError(""); try { const r = await fetch(`/api/provider-verification?applicationId=${encodeURIComponent(String(fd.get("app")))}&category=${encodeURIComponent(String(fd.get("cat")))}`, { cache: "no-store" }); const b = await r.json() as { data?: Status; error?: string }; if (!r.ok) throw new Error(b.error || "Lookup failed"); setStatus(b.data || null); } catch (x) { setError(x instanceof Error ? x.message : "Lookup failed"); } finally { setBusy(false); } }
  return <StaffModule><main style={wrap}><div style={{ maxWidth: 1100, margin: "0 auto" }}>
    <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 18 }}><div><small style={{ fontWeight: 800, color: "var(--staff-primary)" }}>PAWSPACE TEAM · PROVIDER VERIFICATION</small><h1 style={{ margin: "7px 0" }}>KYC mandate (IDfy)</h1><p style={{ margin: 0, color: "var(--staff-muted)" }}>Per-category checks. A provider takes assignments only when every mandated check is verified. IDfy fail-closed.</p></div><Link href="/team" style={{ padding: 10, background: "var(--staff-primary)", color: "var(--staff-on-primary)", borderRadius: 10, textDecoration: "none" }}>Team home</Link></header>
    {error && <div style={{ padding: 12, background: "var(--staff-danger-bg)", borderRadius: 10, marginBottom: 12 }}>{error}</div>}
    <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12, marginBottom: 18 }} data-staff-grid="stats">
      {(snap.categories || []).map(c => <div key={c.category} style={card}><div style={{ fontWeight: 800, textTransform: "capitalize", marginBottom: 6 }}>{c.category.replace("_", " ")}</div>{c.required.map(t => <div key={t} style={{ fontSize: 15, color: "var(--staff-muted)", padding: "2px 0" }}>• {t.replace(/_/g, " ")}</div>)}</div>)}
    </section>
    <div style={{ ...card, marginBottom: 14 }}>
      <b>Check an application</b>
      <form onSubmit={checkApp} style={{ display: "flex", gap: 8, marginTop: 10 }}><input name="app" required placeholder="application id" style={{ flex: 1 }} /><input name="cat" required placeholder="category (groomer/host…)" style={{ flex: 1 }} /><button disabled={busy} style={{ background: "var(--staff-gold)", color: "var(--staff-on-gold)", border: 0, borderRadius: 8, fontWeight: 800, padding: "0 16px" }}>Check</button></form>
      {status && <div style={{ marginTop: 12 }}><span style={{ fontWeight: 800, color: status.canTakeAssignments ? "var(--staff-success)" : "var(--staff-warning)" }}>{status.canTakeAssignments ? "✓ Eligible to take assignments" : "⏳ Not yet eligible"}</span>{(status.checks || []).map(c => <div key={c.verificationType} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--staff-line)" }}><span>{c.verificationType.replace(/_/g, " ")} <small style={{ color: "var(--staff-muted)" }}>· {c.automatable ? "IDfy" : "manual"}</small></span><span style={{ fontWeight: 700 }}>{c.status}</span></div>)}</div>}
    </div>
    <p style={{ fontSize: 14, color: "var(--staff-muted)" }}>Automatable checks (Aadhaar/PAN/address) run via IDfy once its keys are set; house/police/pet-proofing are agent-recorded. Nothing auto-approves.</p>
  </div></main></StaffModule>;
}
