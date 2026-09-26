"use client";
import { useCallback, useEffect, useState } from "react";
import { DEFAULT_GST_POLICY, type GstPolicy } from "../../../../lib/gst-method";
import { PAWSPACE_COMMISSION_DEFAULT_PERCENT, PAWSPACE_COMMISSION_MAX_PERCENT, PAWSPACE_COMMISSION_MIN_PERCENT, PROVIDER_ENGAGEMENTS, PROVIDER_ENGAGEMENT_LABELS, commissionPreview, engagementModelFor, providerTermsProblems, type ProviderEngagement } from "../../../../lib/commission-range";

/**
 * Provider commercial terms (owner decision 8, 26 Sept 2026): how a provider is engaged and PawSpace's commission on
 * each service they offer, 10-40% of the amount paid, 30% unless changed. Used on Finance > Partners and at provider
 * onboarding. Saving writes DRAFT provider_commercial_terms (the maker); a different person activates them with an
 * approval reference (the checker). Each service shows the worked example before anything is saved.
 */
export type TermsContext = "finance" | "onboarding";
export type TermsRow = { serviceCode: string; pawspaceCommissionPercent: string };
export type TermsProposal = { providerId: string; applicationId?: string; engagement: ProviderEngagement; services: TermsRow[]; effectiveFrom: string; reason: string };
export type TermsRequest = { url: string; body: Record<string, unknown> };
type TermSummary = { termId: string; serviceCode: string; status: string; engagement: ProviderEngagement | null; pawspaceCommissionPercent: number | null; effectiveFrom: string; createdBy: string; approvedBy: string | null };
type TermsView = { providerId: string; engagement: ProviderEngagement; services: { serviceCode: string; active: TermSummary | null; scheduled?: TermSummary[]; draft: TermSummary | null; serviceDefault: TermSummary | null }[]; awaitingApproval: TermSummary[]; proposedBy: string[]; gstPolicy?: GstPolicy; legacyCommission?: { reason: string; legacyProviderSharePercent: unknown } | null };

const box = { background: "var(--staff-surface)", border: "1px solid var(--staff-line)", borderRadius: 14, padding: 16, marginBottom: 14 } as const;
const muted = { color: "var(--staff-muted)" } as const;
const serviceLabel = (code: string) => code.replaceAll("_", " ");
const today = () => new Date().toISOString().slice(0, 10);

/** Finance proposes through the Partner Finance API; onboarding staff propose through the onboarding API. Both only draft provider_commercial_terms. */
export function providerTermsSaveRequest(context: TermsContext, proposal: TermsProposal): TermsRequest {
  const services = proposal.services.map(row => ({ serviceCode: row.serviceCode, pawspaceCommissionPercent: proposal.engagement === "full_time" || row.pawspaceCommissionPercent.trim() === "" ? null : Number(row.pawspaceCommissionPercent) }));
  const common = { engagement: proposal.engagement, services, effectiveFrom: proposal.effectiveFrom, reason: proposal.reason };
  return context === "onboarding"
    ? { url: "/api/provider-onboarding", body: { action: "save_commercial_terms", applicationId: proposal.applicationId, ...common } }
    : { url: "/api/partner-finance", body: { action: "save_provider_commercial_terms", providerId: proposal.providerId, ...common } };
}
/**
 * Activation always needs Finance and a different person from the one who proposed the terms. `termIds` are the drafts
 * the approver was shown: if the proposal changed since, the server activates nothing and asks them to review it again.
 */
export function providerTermsActivateRequest(context: TermsContext, providerId: string, approvalReference: string, termIds?: string[]): TermsRequest {
  const reviewed = termIds ? { termIds } : {};
  return context === "onboarding"
    ? { url: "/api/provider-commercial-terms", body: { action: "activate_provider_terms", providerId, approvalReference, ...reviewed } }
    : { url: "/api/partner-finance", body: { action: "activate_provider_commercial_terms", providerId, approvalReference, ...reviewed } };
}
/** Sends one request. A refusal (outside 10-40%, the proposer approving their own terms) comes back in plain words. */
export async function sendTermsRequest(fetcher: typeof fetch, request: TermsRequest): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const response = await fetcher(request.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request.body) });
  const payload = await response.json().catch(() => ({})) as { data?: unknown; error?: string };
  return response.ok ? { ok: true, data: payload.data } : { ok: false, error: payload.error || "The commercial terms could not be saved" };
}
async function fetchTermsView(providerId: string): Promise<{ view: TermsView | null; note: string }> {
  const response = await fetch(`/api/provider-commercial-terms?providerId=${encodeURIComponent(providerId)}`, { cache: "no-store" });
  const payload = await response.json().catch(() => ({})) as { data?: TermsView; error?: string };
  if (response.ok && payload.data) return { view: payload.data, note: "" };
  return { view: null, note: response.status === 403 ? "Only Finance can see the terms in force. You can still propose terms for Finance to approve." : payload.error || "This provider's terms could not be loaded" };
}
function rowsFor(view: TermsView, offered: string[]): TermsRow[] {
  const codes = [...new Set([...offered, ...view.services.map(service => service.serviceCode)])];
  return codes.map(code => {
    const service = view.services.find(item => item.serviceCode === code);
    const percent = service?.draft?.pawspaceCommissionPercent ?? service?.scheduled?.at(-1)?.pawspaceCommissionPercent ?? service?.active?.pawspaceCommissionPercent ?? service?.serviceDefault?.pawspaceCommissionPercent ?? PAWSPACE_COMMISSION_DEFAULT_PERCENT;
    return { serviceCode: code, pawspaceCommissionPercent: String(percent) };
  });
}
function rowPreview(engagement: ProviderEngagement, row: TermsRow, gstPolicy: GstPolicy) {
  const model = engagementModelFor(engagement, row.serviceCode), percent = row.pawspaceCommissionPercent.trim() === "" ? PAWSPACE_COMMISSION_DEFAULT_PERCENT : Number(row.pawspaceCommissionPercent);
  if (model !== "direct_employee" && !Number.isFinite(percent)) return "";
  return commissionPreview({ engagement: model === "funeral_exempt" ? "funeral_vendor" : engagement, pawspaceCommissionPercent: percent, gstPolicy, serviceCode: row.serviceCode }).sentence;
}

type Props = { context: TermsContext; providerId?: string; applicationId?: string; services?: string[]; onChanged?: () => void };
export default function ProviderCommercialTermsPanel({ context, providerId: fixedProviderId, applicationId, services: offered, onChanged }: Props) {
  const offeredKey = (offered ?? []).join(",");
  const [providerInput, setProviderInput] = useState(fixedProviderId ?? "");
  const providerId = (fixedProviderId ?? providerInput).trim();
  const [engagement, setEngagement] = useState<ProviderEngagement>("commission");
  const [rows, setRows] = useState<TermsRow[]>(() => (offered ?? []).map(serviceCode => ({ serviceCode, pawspaceCommissionPercent: String(PAWSPACE_COMMISSION_DEFAULT_PERCENT) })));
  const [newService, setNewService] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [reason, setReason] = useState("");
  const [approvalReference, setApprovalReference] = useState("");
  const [view, setView] = useState<TermsView | null>(null);
  const [gstPolicy, setGstPolicy] = useState<GstPolicy>(DEFAULT_GST_POLICY);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const apply = useCallback((loaded: { view: TermsView | null; note: string }, known: string[]) => {
    setNote(loaded.note); setView(loaded.view);
    if (!loaded.view) return;
    setGstPolicy(loaded.view.gstPolicy ?? DEFAULT_GST_POLICY); setEngagement(loaded.view.engagement); setRows(rowsFor(loaded.view, known));
  }, []);
  async function load(id: string) { if (!id) return; setError(""); apply(await fetchTermsView(id), offered ?? []); }
  useEffect(() => {
    if (!fixedProviderId) return;
    let active = true;
    const known = offeredKey ? offeredKey.split(",") : [];
    const timer = setTimeout(() => { void fetchTermsView(fixedProviderId).then(loaded => { if (active) apply(loaded, known); }).catch(() => { if (active) setNote("This provider's terms could not be loaded"); }); }, 0);
    return () => { active = false; clearTimeout(timer); };
  }, [fixedProviderId, offeredKey, apply]);
  async function run(request: TermsRequest, done: (data: unknown) => string, reloadOnRefusal = false) {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await sendTermsRequest(fetch, request);
      // A refused approval (for example, the proposal changed) reloads what is waiting, so the approver sees the new proposal.
      if (!result.ok) { setError(result.error ?? "The commercial terms could not be saved"); if (reloadOnRefusal && providerId) apply(await fetchTermsView(providerId), offered ?? []); return; }
      setMessage(done(result.data)); await load(providerId); onChanged?.();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The commercial terms could not be saved"); } finally { setBusy(false); }
  }
  const save = () => run(providerTermsSaveRequest(context, { providerId, applicationId, engagement, services: rows, effectiveFrom, reason }), () => { setReason(""); return "Saved for approval. A different person must now approve these terms with an approval reference before they apply."; });
  const activate = () => run(providerTermsActivateRequest(context, providerId, approvalReference, (view?.awaitingApproval ?? []).map(term => term.termId)), () => { setApprovalReference(""); return "Approved. These terms now apply to this provider's bookings from their effective date."; }, true);
  const addService = () => { const code = newService.trim().toLowerCase().replaceAll(" ", "_"); if (code && !rows.some(row => row.serviceCode === code)) setRows([...rows, { serviceCode: code, pawspaceCommissionPercent: String(PAWSPACE_COMMISSION_DEFAULT_PERCENT) }]); setNewService(""); };
  const setPercent = (code: string, value: string) => setRows(rows.map(row => row.serviceCode === code ? { ...row, pawspaceCommissionPercent: value } : row));
  const problems = providerTermsProblems({ engagement, services: rows });
  const canSave = !busy && Boolean(context === "onboarding" ? applicationId : providerId) && problems.length === 0 && reason.trim().length >= 8;
  const example = commissionPreview({ engagement, pawspaceCommissionPercent: PAWSPACE_COMMISSION_DEFAULT_PERCENT, gstPolicy }).sentence;
  const waiting = view?.awaitingApproval ?? [];
  const inForce = (view?.services ?? []).filter(service => service.active || service.scheduled?.length);
  const termText = (term: TermSummary) => term.pawspaceCommissionPercent == null ? "full-time" : `PawSpace ${term.pawspaceCommissionPercent}%`;
  return <section style={box} aria-label="Provider commercial terms">
    <h2 style={{ margin: "0 0 6px", fontSize: 18 }}>Provider commercial terms</h2>
    <p style={{ margin: "0 0 6px", ...muted }}>PawSpace&apos;s commission is {PAWSPACE_COMMISSION_MIN_PERCENT}% to {PAWSPACE_COMMISSION_MAX_PERCENT}% of the amount the customer paid, {PAWSPACE_COMMISSION_DEFAULT_PERCENT}% unless you change it. The provider gets the rest. One person proposes the terms and a different person approves them.</p>
    <p style={{ margin: "0 0 10px" }}><b>Example:</b> {example}.</p>
    {!fixedProviderId && <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end", marginBottom: 10 }}>
      <label>Provider ID<br /><input value={providerInput} onChange={event => setProviderInput(event.target.value)} placeholder="PROV-…" /></label>
      <button type="button" disabled={busy || !providerInput.trim()} onClick={() => void load(providerInput.trim()).catch(() => setError("This provider's terms could not be loaded"))}>Load terms</button>
    </div>}
    <label style={{ display: "block", marginBottom: 10 }}>How the provider is engaged<br /><select value={engagement} onChange={event => setEngagement(event.target.value as ProviderEngagement)}>{PROVIDER_ENGAGEMENTS.map(value => <option key={value} value={value}>{PROVIDER_ENGAGEMENT_LABELS[value]}</option>)}</select></label>
    {rows.length === 0 ? <p style={muted}>No services yet. Add each service this provider offers.</p> : <div role="table" aria-label="Commission for each service">{rows.map(row => <div role="row" key={row.serviceCode} style={{ display: "grid", gridTemplateColumns: "minmax(120px,1fr) 150px 3fr auto", gap: 10, alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--staff-line)" }} data-staff-grid="record">
      <b role="cell">{serviceLabel(row.serviceCode)}</b>
      <label role="cell">{engagement === "full_time" ? <span style={muted}>No share</span> : <><input type="number" min={engagementModelFor(engagement, row.serviceCode) === "funeral_exempt" ? 0 : PAWSPACE_COMMISSION_MIN_PERCENT} max={engagementModelFor(engagement, row.serviceCode) === "funeral_exempt" ? 99 : PAWSPACE_COMMISSION_MAX_PERCENT} step="0.5" style={{ width: 80 }} aria-label={`PawSpace's commission for ${serviceLabel(row.serviceCode)} (%)`} value={row.pawspaceCommissionPercent} onChange={event => setPercent(row.serviceCode, event.target.value)} /> %</>}</label>
      <span role="cell">{rowPreview(engagement, row, gstPolicy)}</span>
      <button type="button" disabled={busy} onClick={() => setRows(rows.filter(item => item.serviceCode !== row.serviceCode))}>Remove</button>
    </div>)}</div>}
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end", marginTop: 10 }}>
      <label>Add a service<br /><input value={newService} onChange={event => setNewService(event.target.value)} placeholder="e.g. boarding" /></label>
      <button type="button" disabled={busy || !newService.trim()} onClick={addService}>Add service</button>
      <label>Effective from<br /><input type="date" value={effectiveFrom} onChange={event => setEffectiveFrom(event.target.value)} /></label>
      <label style={{ flex: "1 1 240px" }}>Reason (at least 8 characters)<br /><input style={{ width: "100%" }} value={reason} onChange={event => setReason(event.target.value)} placeholder="e.g. Agreed at onboarding interview" /></label>
      <button type="button" disabled={!canSave} onClick={() => void save()}>{busy ? "Saving…" : "Save for approval"}</button>
    </div>
    {problems.length > 0 && <ul role="alert" style={{ margin: "10px 0 0", paddingLeft: 20, color: "var(--staff-danger)" }}>{problems.map(problem => <li key={problem}>{problem}</li>)}</ul>}
    <div style={{ marginTop: 14, padding: 12, borderRadius: 10, background: "var(--staff-raised)" }}>
      <b>Waiting for approval</b>
      {waiting.length === 0 ? <p style={{ margin: "6px 0", ...muted }}>{view ? "Nothing is waiting for approval for this provider." : "Load a provider to see terms waiting for approval."}</p> : <ul style={{ margin: "6px 0", paddingLeft: 20 }}>{waiting.map(term => <li key={term.termId}>{serviceLabel(term.serviceCode)}: {term.pawspaceCommissionPercent == null ? "full-time, no share" : `PawSpace ${term.pawspaceCommissionPercent}%`} from {term.effectiveFrom}, proposed by {term.createdBy}</li>)}</ul>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
        <label>Approval reference<br /><input value={approvalReference} onChange={event => setApprovalReference(event.target.value)} placeholder="e.g. FIN-APR-0142" /></label>
        <button type="button" disabled={busy || !providerId || waiting.length === 0 || approvalReference.trim().length < 4} onClick={() => void activate()}>Approve and activate</button>
      </div>
      <small style={{ display: "block", marginTop: 6, ...muted }}>You approve exactly the terms listed above. The person who proposed them cannot approve them. Approving needs Finance access.</small>
    </div>
    {inForce.length > 0 && <p style={{ margin: "10px 0 0" }}><b>In force:</b> {inForce.map(service => [service.active ? `${serviceLabel(service.serviceCode)} ${termText(service.active)} (approved by ${service.active.approvedBy ?? "unknown"})` : `${serviceLabel(service.serviceCode)} ${service.serviceDefault ? `service default (${termText(service.serviceDefault)})` : "not set"} until then`, ...(service.scheduled ?? []).map(term => `from ${term.effectiveFrom} ${termText(term)}`)].join(", ")).join(" · ")}</p>}
    {view?.legacyCommission && <p style={{ margin: "10px 0 0" }}>Older commission setting not carried over: {view.legacyCommission.reason}</p>}
    {note && <p style={{ margin: "10px 0 0", ...muted }}>{note}</p>}
    {error && <p role="alert" style={{ margin: "10px 0 0", color: "var(--staff-danger)" }}>{error}</p>}
    {message && <p role="status" style={{ margin: "10px 0 0" }}>{message}</p>}
  </section>;
}
