"use client";
import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

type Snap = { types?: { code: string; label: string; automatable: boolean }[]; categories?: { category: string; required: string[] }[]; idfyConnected?: boolean };
type Status = { required?: string[]; checks?: { verificationType: string; status: string; automatable: boolean; automated?: boolean; offlineAttested?: boolean; recordedBy?: string | null }[]; canTakeAssignments?: boolean };
const wrap = { minHeight: "100vh", background: "#f7f4fb", padding: 28, fontFamily: "Arial,sans-serif", color: "#24133f" } as const;
const card = { background: "white", border: "1px solid #e5dcef", borderRadius: 14, padding: 16 } as const;
const act = { border: "1px solid #c9b9de", background: "white", borderRadius: 8, padding: "5px 10px", fontSize: 12 } as const;

/**
 * The controls this screen offers for one mandated check. [W2-F]
 *
 * Exported so a test can ask the SCREEN what an operator can do about an outstanding check, and then
 * drive the real route with exactly that - rather than re-deciding it and passing whatever the engine
 * happens to accept.
 */
export function verificationControlsFor(
  check: { verificationType: string; status: string; automatable: boolean },
  options: { idfyConnected?: boolean } = {},
) {
  if (check.status === "verified") return [];
  /*
   * WHERE THERE IS NO AUTOMATION, THERE MUST STILL BE A WAY TO DECIDE. [R3-B2]
   *
   * Every category mandate requires aadhaar, aadhaar is automatable, and "Run via IDfy" was the only
   * control this screen offered for an automatable check. With IDfy unconnected - which is every
   * deployment of this platform - that button answers 'pending' forever and record_manual refuses by
   * design, so category_verification_mandate blocked activation for every provider of every category
   * and nobody could ever go live. The attestation below is offered ONLY when the server has told this
   * screen automation is absent, it carries requiresNote so the operator must state what they actually
   * saw, and the server refuses it outright wherever IDfy is connected. Nothing auto-approves: the
   * operator still chooses verified or failed, and the record says a human decided it.
   */
  if (check.automatable) {
    if (options.idfyConnected === false) return [
      { label: "Record verified offline", requiresNote: true, payload: { action: "record_offline_verification", verificationType: check.verificationType, status: "verified" } as Record<string, unknown> },
      { label: "Record failed offline", requiresNote: true, payload: { action: "record_offline_verification", verificationType: check.verificationType, status: "failed" } as Record<string, unknown> },
    ];
    return [{ label: "Run via IDfy", requiresNote: false, payload: { action: "run", verificationType: check.verificationType, payload: {} } as Record<string, unknown> }];
  }
  return [
    { label: "Record verified", requiresNote: false, payload: { action: "record_manual", verificationType: check.verificationType, status: "verified", note: "Agent-recorded: check completed and passed" } as Record<string, unknown> },
    { label: "Needs review", requiresNote: false, payload: { action: "record_manual", verificationType: check.verificationType, status: "manual_review", note: "Agent-recorded: needs a second look" } as Record<string, unknown> },
    { label: "Record failed", requiresNote: false, payload: { action: "record_manual", verificationType: check.verificationType, status: "failed", note: "Agent-recorded: check did not pass" } as Record<string, unknown> },
  ];
}

/**
 * This screen could look a mandate up and could not move one. [W2-F]
 *
 * `category_verification_mandate` is a HARD activation gate: evaluateProviderActivation refuses to
 * activate a provider until every verification type the approved policy requires for their vertical is
 * recorded 'verified' against their application. The only writers are POST /api/provider-verification
 * with action "run" (IDfy) or "record_manual" (agent-recorded), and no .tsx in this repository posted
 * either. Walking the funnel through the real routes, that is a full stop: application submitted,
 * quiz passed, interview approved, agreement accepted, profile complete - and activation blocked on
 * aadhaar/pan forever, with nowhere in the product to clear them.
 *
 * Both writes are already gated on providers.manage, which admin and manager hold, so nothing here
 * widens a permission. Automatable checks stay automatable: IDfy decides them, this screen only asks.
 */
export default function ProviderVerificationPage() {
  const [snap, setSnap] = useState<Snap>({});
  const [status, setStatus] = useState<Status | null>(null);
  const [subject, setSubject] = useState<{ applicationId: string; category: string } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { let on = true; void fetch("/api/provider-verification", { cache: "no-store" }).then(async r => { const b = await r.json() as { data?: Snap; error?: string }; if (!r.ok) throw new Error(b.error || "Unavailable"); if (on) setSnap(b.data || {}); }).catch(e => { if (on) setError(e instanceof Error ? e.message : "Unavailable"); }); return () => { on = false; }; }, []);

  async function lookup(applicationId: string, category: string) {
    const r = await fetch(`/api/provider-verification?applicationId=${encodeURIComponent(applicationId)}&category=${encodeURIComponent(category)}`, { cache: "no-store" });
    const b = await r.json() as { data?: Status; error?: string };
    if (!r.ok) throw new Error(b.error || "Lookup failed");
    setSubject({ applicationId, category });
    setStatus(b.data || null);
  }

  async function checkApp(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true); setError(""); setNotice("");
    try { await lookup(String(fd.get("app")), String(fd.get("cat"))); }
    catch (x) { setError(x instanceof Error ? x.message : "Lookup failed"); }
    finally { setBusy(false); }
  }

  /** Ask IDfy to decide an automatable check, or record the outcome an agent actually observed. */
  async function record(payload: Record<string, unknown>, describe: string, requiresNote = false) {
    if (!subject) return;
    /* An offline attestation without a written statement of the evidence is refused by the server, so
     * the screen asks for it rather than sending a canned sentence on the operator's behalf. */
    if (requiresNote) {
      const note = typeof window === "undefined" ? "" : String(window.prompt("What evidence did you see? (recorded against your name)") || "").trim();
      if (note.length < 12) { setError("Describe the evidence you saw - at least 12 characters. Nothing was recorded."); return; }
      payload = { ...payload, note };
    }
    setBusy(true); setError(""); setNotice("");
    try {
      const r = await fetch("/api/provider-verification", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, applicationId: subject.applicationId, category: subject.category }) });
      const b = await r.json() as { data?: { status?: string }; error?: string };
      /* The route answers a business rule with a 4xx carrying its reason, so show that rather than a
       * generic line. "IDfy not connected" is not an error here: it is a 201 whose status is
       * 'pending', which is exactly what the operator needs to see. */
      if (!r.ok) throw new Error(b.error || "Unable to record this verification");
      setNotice(`${describe}: ${String(b.data?.status || "recorded")}`);
      await lookup(subject.applicationId, subject.category);
    } catch (x) { setError(x instanceof Error ? x.message : "Unable to record this verification"); }
    finally { setBusy(false); }
  }

  return <main style={wrap}><div style={{ maxWidth: 1100, margin: "0 auto" }}>
    <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 18 }}><div><small style={{ fontWeight: 800, color: "#6c39a8" }}>PAWSPACE TEAM · PROVIDER VERIFICATION</small><h1 style={{ margin: "7px 0" }}>KYC mandate (IDfy)</h1><p style={{ margin: 0, color: "#746b7d" }}>Per-category checks. A provider takes assignments only when every mandated check is verified. IDfy fail-closed.</p></div><Link href="/team" style={{ padding: 10, background: "#4b168c", color: "white", borderRadius: 10, textDecoration: "none" }}>Team home</Link></header>
    {snap.idfyConnected === false && <div role="status" style={{ padding: 12, background: "#fff8e8", border: "1px solid #f0dcae", borderRadius: 10, marginBottom: 12 }}>IDfy is not connected on this deployment, so an automatable check will sit at <b>pending</b> forever. Record what you verified yourself instead: the outcome is stored against your name, marked as not automated, and it is refused as soon as IDfy is switched on.</div>}
    {error && <div role="alert" style={{ padding: 12, background: "#fff1f1", borderRadius: 10, marginBottom: 12 }}>{error}</div>}
    {notice && <div role="status" style={{ padding: 12, background: "#eef9f4", borderRadius: 10, marginBottom: 12 }}>{notice}</div>}
    <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12, marginBottom: 18 }}>
      {(snap.categories || []).map(c => <div key={c.category} style={card}><div style={{ fontWeight: 800, textTransform: "capitalize", marginBottom: 6 }}>{c.category.replace("_", " ")}</div>{c.required.map(t => <div key={t} style={{ fontSize: 13, color: "#4a3d5c", padding: "2px 0" }}>• {t.replace(/_/g, " ")}</div>)}</div>)}
    </section>
    <div style={{ ...card, marginBottom: 14 }}>
      <b>Check an application</b>
      <form onSubmit={checkApp} style={{ display: "flex", gap: 8, marginTop: 10 }}><input name="app" required placeholder="application id" style={{ flex: 1 }} /><input name="cat" required placeholder="category (groomer/host…)" style={{ flex: 1 }} /><button disabled={busy} style={{ background: "#F6920A", color: "white", border: 0, borderRadius: 8, fontWeight: 800, padding: "0 16px" }}>Check</button></form>
      {status && <div style={{ marginTop: 12 }}>
        <span style={{ fontWeight: 800, color: status.canTakeAssignments ? "#1f8a5b" : "#c47a00" }}>{status.canTakeAssignments ? "✓ Eligible to take assignments" : "⏳ Not yet eligible"}</span>
        {(status.checks || []).map(c => <div key={c.verificationType} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid #f0ebf4", flexWrap: "wrap" }}>
          <span>{c.verificationType.replace(/_/g, " ")} <small style={{ color: "#746b7d" }}>· {c.automatable ? "IDfy" : "manual"}{c.offlineAttested ? ` · attested offline by ${c.recordedBy || "staff"}` : c.automated ? " · decided by IDfy" : ""}</small></span>
          <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <b>{c.status}</b>
            {verificationControlsFor(c, { idfyConnected: snap.idfyConnected }).map(control => <button key={control.label} style={act} disabled={busy} onClick={() => void record(control.payload, `${c.verificationType} · ${control.label}`, control.requiresNote === true)}>{control.label}</button>)}
          </span>
        </div>)}
        <p style={{ fontSize: 12, color: "#746b7d", marginTop: 10 }}>Nothing here auto-approves: IDfy returns its own outcome, and a manual check records the outcome a person actually observed. Until every mandated check reads &ldquo;verified&rdquo;, provider activation stays blocked on <code>category_verification_mandate</code>.</p>
      </div>}
    </div>
    <p style={{ fontSize: 12, color: "#746b7d" }}>Automatable checks (Aadhaar/PAN/address) run via IDfy once its keys are set; house/police/pet-proofing are agent-recorded. Nothing auto-approves.</p>
  </div></main>;
}
