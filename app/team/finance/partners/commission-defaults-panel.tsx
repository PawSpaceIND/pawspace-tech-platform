"use client";
import { useState } from "react";
import { COMMISSION_RESOLUTION_ORDER, PAWSPACE_COMMISSION_DEFAULT_PERCENT, PAWSPACE_COMMISSION_MAX_PERCENT, PAWSPACE_COMMISSION_MIN_PERCENT, pawspaceCommissionProblem, serviceDefaultStartProblem } from "../../../../lib/commission-range";
import { sendTermsRequest, type TermsRequest } from "./commercial-terms-panel";

/**
 * Finance > Partners, "Default commission by service" (owner decision C, 27 Sept 2026): PawSpace's commission is 30% of the
 * amount paid for every commission service unless Finance changes a service's default (10-40%). One person proposes a change,
 * for one service or every service at once, starting today or later (never back-dated); a different person approves exactly
 * what they were shown. It also lists terms in use that the system approved rather than a person (carried over from the older
 * profile, or set automatically at the default): payouts keep using them, and a second person approves them here.
 */
export type DefaultTerm = { termId: string; serviceCode: string; pawspaceCommissionPercent: number | null; effectiveFrom: string; createdBy: string; approvedBy: string | null; needsPersonApproval?: string | null };
export type ServiceDefaultRow = { serviceCode: string; inForce: DefaultTerm | null; scheduled: DefaultTerm[]; waiting: DefaultTerm[] };
export type DefaultsView = { services: ServiceDefaultRow[]; today: string; blocked?: string | null };
export type ApprovalNeeded = { termId: string; providerId: string | null; serviceCode: string; pawspaceCommissionPercent: number | null; effectiveFrom: string; createdBy: string; label: string };
export type DefaultProposal = { serviceCode: string; pawspaceCommissionPercent: string; effectiveFrom: string; reason: string };

const box = { background: "var(--staff-surface)", border: "1px solid var(--staff-line)", borderRadius: 14, padding: 16, marginBottom: 14 } as const;
const muted = { color: "var(--staff-muted)" } as const;
const serviceLabel = (code: string) => code.replaceAll("_", " ");
const percentText = (term: DefaultTerm) => term.pawspaceCommissionPercent == null ? "no share (full-time)" : `PawSpace ${term.pawspaceCommissionPercent}%`;

/** "all" gives every service the same default in one proposal. */
export function serviceDefaultProposeRequest(proposal: DefaultProposal): TermsRequest {
  const percent = proposal.pawspaceCommissionPercent.trim() === "" ? null : Number(proposal.pawspaceCommissionPercent);
  const scope = proposal.serviceCode === "all" ? { allServices: true } : { serviceCode: proposal.serviceCode };
  return { url: "/api/partner-finance", body: { action: "propose_service_default", ...scope, pawspaceCommissionPercent: percent, effectiveFrom: proposal.effectiveFrom, reason: proposal.reason } };
}
/** `termIds` are the changes the approver was shown: if any was replaced since, nothing is approved. */
export function serviceDefaultApproveRequest(termIds: string[], approvalReference: string): TermsRequest {
  return { url: "/api/partner-finance", body: { action: "approve_service_default", termIds, approvalReference } };
}
export function serviceDefaultRejectRequest(termIds: string[], note = ""): TermsRequest {
  return { url: "/api/partner-finance", body: { action: "reject_service_default", termIds, note } };
}
export function reapproveTermRequest(termId: string, approvalReference: string): TermsRequest {
  return { url: "/api/partner-finance", body: { action: "reapprove_commercial_term", termId, approvalReference } };
}
/** Every problem with a proposed default, in the words the server uses (empty when it can be saved). */
export function serviceDefaultProblems(proposal: DefaultProposal, today: string) {
  const label = proposal.serviceCode === "all" ? "every service" : serviceLabel(proposal.serviceCode);
  return [proposal.serviceCode ? null : "Choose the service, or every service.", pawspaceCommissionProblem(proposal.pawspaceCommissionPercent, label), serviceDefaultStartProblem(proposal.effectiveFrom, today), proposal.reason.trim().length >= 8 ? null : "Give a clear reason of at least 8 characters."].filter((problem): problem is string => Boolean(problem));
}

type Props = { defaults?: DefaultsView | null; approvalNeeded?: ApprovalNeeded[]; onChanged?: () => void };
export default function CommissionDefaultsPanel({ defaults, approvalNeeded = [], onChanged }: Props) {
  const [serviceCode, setServiceCode] = useState("all");
  const [percent, setPercent] = useState(String(PAWSPACE_COMMISSION_DEFAULT_PERCENT));
  // Empty until someone picks a date: the default start is the server's today (defaults.today), so the server render and the
  // browser's first render always agree, whatever the clocks say around midnight.
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [reason, setReason] = useState("");
  const [approvalReference, setApprovalReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const services = defaults?.services ?? [];
  const today = defaults?.today ?? "";
  const startsFrom = effectiveFrom || today;
  const waiting = services.flatMap(service => service.waiting);
  const proposal = { serviceCode, pawspaceCommissionPercent: percent, effectiveFrom: startsFrom, reason };
  const problems = serviceDefaultProblems(proposal, today);
  const referenceReady = approvalReference.trim().length >= 4;
  // A refusal (for example, the changes were replaced after loading) reloads the page data, so the approver sees what is waiting now.
  async function run(request: TermsRequest, done: string) {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await sendTermsRequest(fetch, request);
      onChanged?.();
      if (!result.ok) { setError(result.error ?? "The default commission could not be saved"); return false; }
      setMessage(done); return true;
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The default commission could not be saved"); return false; } finally { setBusy(false); }
  }
  const propose = async () => { if (await run(serviceDefaultProposeRequest(proposal), "Saved for approval. A different person must approve this default before it applies.")) setReason(""); };
  const approve = (termIds: string[]) => run(serviceDefaultApproveRequest(termIds, approvalReference), "Approved. The new default applies to bookings from its start date.");
  const reject = (termIds: string[]) => run(serviceDefaultRejectRequest(termIds), "Turned down. The default in force is unchanged.");
  const reapprove = (termId: string) => run(reapproveTermRequest(termId, approvalReference), "Approved. This term now shows the person who approved it.");
  return <section style={box} aria-label="Default commission by service">
    <h2 style={{ margin: "0 0 6px", fontSize: 18 }}>Default commission by service</h2>
    <p style={{ margin: "0 0 6px", ...muted }}>PawSpace&apos;s commission is {PAWSPACE_COMMISSION_DEFAULT_PERCENT}% of the amount the customer paid for every commission service unless you change a service&apos;s default here ({PAWSPACE_COMMISSION_MIN_PERCENT}% to {PAWSPACE_COMMISSION_MAX_PERCENT}%). A change starts today or later, never earlier. One person proposes it and a different person approves it.</p>
    <p style={{ margin: "0 0 10px" }}>{COMMISSION_RESOLUTION_ORDER}</p>
    {defaults?.blocked && <p role="alert" style={{ margin: "0 0 10px", color: "var(--staff-danger)" }}>{defaults.blocked}</p>}
    {services.length === 0 ? <p style={muted}>The service defaults have not loaded yet.</p> :<div role="table" aria-label="Default commission for each service">{services.map(service => <div role="row" key={service.serviceCode} style={{ display: "grid", gridTemplateColumns: "minmax(110px,1fr) 2fr 2fr", gap: 10, alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--staff-line)" }} data-staff-grid="record">
      <b role="cell">{serviceLabel(service.serviceCode)}</b>
      <span role="cell">{service.inForce ? <>{percentText(service.inForce)} since {service.inForce.effectiveFrom}{service.inForce.needsPersonApproval ? <> · <b>{service.inForce.needsPersonApproval}</b></> : <small style={{ display: "block", ...muted }}>Approved by {service.inForce.approvedBy ?? "not recorded"}</small>}</> : <span style={muted}>No default in force</span>}{service.scheduled.map(term => <small key={term.termId} style={{ display: "block" }}>From {term.effectiveFrom}: {percentText(term)}</small>)}</span>
      <span role="cell">{service.waiting.length === 0 ? <span style={muted}>No change waiting</span> : service.waiting.map(term => <span key={term.termId} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>Proposed: {percentText(term)} from {term.effectiveFrom}, by {term.createdBy}<button type="button" disabled={busy || !referenceReady} onClick={() => void approve([term.termId])}>Approve</button><button type="button" disabled={busy} onClick={() => void reject([term.termId])}>Turn down</button></span>)}</span>
    </div>)}</div>}
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end", marginTop: 10 }}>
      <label>Service<br /><select value={serviceCode} onChange={event => setServiceCode(event.target.value)}><option value="all">Every service</option>{services.map(service => <option key={service.serviceCode} value={service.serviceCode}>{serviceLabel(service.serviceCode)}</option>)}</select></label>
      <label>PawSpace %<br /><input type="number" min={PAWSPACE_COMMISSION_MIN_PERCENT} max={PAWSPACE_COMMISSION_MAX_PERCENT} step="0.5" style={{ width: 80 }} aria-label="PawSpace's default commission (%)" value={percent} onChange={event => setPercent(event.target.value)} /></label>
      <label>Starts from<br /><input type="date" min={today || undefined} value={startsFrom} onChange={event => setEffectiveFrom(event.target.value)} /></label>
      <label style={{ flex: "1 1 220px" }}>Reason (at least 8 characters)<br /><input style={{ width: "100%" }} value={reason} onChange={event => setReason(event.target.value)} placeholder="e.g. Owner asked for a lower boarding default" /></label>
      <button type="button" disabled={busy || problems.length > 0} onClick={() => void propose()}>{busy ? "Saving…" : "Save default for approval"}</button>
    </div>
    {problems.length > 0 && (reason || percent !== String(PAWSPACE_COMMISSION_DEFAULT_PERCENT)) && <ul role="alert" style={{ margin: "10px 0 0", paddingLeft: 20, color: "var(--staff-danger)" }}>{problems.map(problem => <li key={problem}>{problem}</li>)}</ul>}
    <div style={{ marginTop: 14, padding: 12, borderRadius: 10, background: "var(--staff-raised)" }}>
      <label>Approval reference<br /><input value={approvalReference} onChange={event => setApprovalReference(event.target.value)} placeholder="e.g. FIN-APR-0142" /></label>
      {waiting.length > 1 && <button type="button" style={{ marginLeft: 8 }} disabled={busy || !referenceReady} onClick={() => void approve(waiting.map(term => term.termId))}>Approve all waiting ({waiting.length})</button>}
      <small style={{ display: "block", marginTop: 6, ...muted }}>You approve exactly the changes listed above. The person who proposed a change cannot approve it. Approving needs Finance access.</small>
      <b style={{ display: "block", marginTop: 12 }}>In use, waiting for a person&apos;s approval</b>
      <small style={{ display: "block", ...muted }}>These were approved by the system, not a person: carried over from the older commission setting, or set automatically at {PAWSPACE_COMMISSION_DEFAULT_PERCENT}%. Payouts keep using them. A person other than the one who set them approves them here.</small>
      {approvalNeeded.length === 0 ? <p style={{ margin: "6px 0 0", ...muted }}>Every term in use was approved by a person.</p> : approvalNeeded.map(term => <div key={term.termId} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--staff-line)" }}><span>{term.providerId ?? "Service default"} · {serviceLabel(term.serviceCode)} · {term.pawspaceCommissionPercent == null ? "no share (full-time)" : `PawSpace ${term.pawspaceCommissionPercent}%`} since {term.effectiveFrom} · <b>{term.label}</b></span><button type="button" disabled={busy || !referenceReady} onClick={() => void reapprove(term.termId)}>Approve</button></div>)}
    </div>
    {error && <p role="alert" style={{ margin: "10px 0 0", color: "var(--staff-danger)" }}>{error}</p>}
    {message && <p role="status" style={{ margin: "10px 0 0" }}>{message}</p>}
  </section>;
}
