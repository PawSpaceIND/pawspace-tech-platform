"use client";
/**
 * Staff operator console for automated outbound voice.
 *
 * The governance layer, the state machine, the policy gate, the provider adapter and the callback
 * receiver all shipped without an operator surface, so the only way to run a UAT scenario was to hand-
 * craft HTTP requests. That is not a workable way to run the 18-scenario checklist, and it is a bad way
 * to run anything a customer's phone rings for.
 *
 * Three properties this page is built around, because each of them is a way an operator console can
 * cause the harm the governance layer exists to prevent:
 *
 *   Nothing here can enable voice. Whether calling is possible at all is decided by the environment
 *   (lib/voice-call-gate.ts). This page READS that decision and disables its own controls to match; it
 *   sends no field that the gate consults, so a modified client cannot turn calling on. When the gate
 *   is closed the reason is shown rather than the controls silently doing nothing.
 *
 *   A dial is never the first click. "Check policy" runs the real ten-check gate as a dry run with
 *   nothing created and nothing dialled, and the dial button stays disabled until a preview for the
 *   CURRENT form has come back allowed. Editing any field clears that preview, so an operator cannot
 *   preview one number and dial another.
 *
 *   One composed request dials at most once. The idempotency key is minted when the preview passes and
 *   reused for every attempt at that same request, so a double-click, a slow network or an impatient
 *   retry returns the existing call instead of ringing a customer twice.
 *
 * Only phoneLast4 is ever rendered from the ledger - the API does not return a full number, and the
 * dial form's number is never echoed back into any list.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, StatCard, TeamAlert, TeamSection, TeamShell, TeamStatGrid, TeamTable } from "../../components/ui";
import { maskedNumber, operatorDialDecision, previewMatchesForm, type OperatorForm, type OperatorPreview } from "../../../lib/voice-operator-console";

type UseCase = { code: string; label: string; purpose: string; requiresBooking: boolean; requiresSalesApproval: boolean; maxAttempts: number; availableNow: boolean };
type Gate = { mode: string; enabled: boolean; blockedReason: string | null; uatApproved: boolean; liveApproved: boolean; telephonyCredentialsConfigured: boolean; statusCallbackConfigured: boolean; missingSecretNames: string[]; allowlistSize: number; recordingApproved: boolean; salesOutboundApproved: boolean; truth: Record<string, boolean> };
type Readiness = { gate: Gate; transport: { provider: string; configured: boolean; mode?: string }; useCases: UseCase[]; scripts: Array<{ useCase: string; active: boolean; claimsApproved: boolean; version: number }>; productionCallsPlaced: number; unappliedProviderEvents: number; callsOpenOverAnHour: number };
type LedgerRow = { callId: string; state: string; useCase: string; purpose: string; provider: string; providerCallId: string | null; productionCall: boolean; mode: string; consentDecision: string; optOutDecision: string; quietHoursDecision: string; failureReasonClass: string | null; retryOf: string | null; retryAttempt: number; handoffCaseId: string | null; transcriptRef: string | null; phoneLast4: string; dialed: boolean };
type PolicyCheck = { code: string; passed: boolean; detail: string };
type Preview = { allowed: boolean; blockedBy: string | null; blockedDetail: string | null; checks: PolicyCheck[] };
type Audit = { call: LedgerRow; transitions: Array<Record<string, unknown>>; policyDecisions: Array<{ checkCode: string; passed: boolean; detail: string; at: number }>; providerEvents: Array<Record<string, unknown>>; truth: Record<string, boolean> };

const IST = (value: unknown) => (Number(value) > 0 ? new Date(Number(value)).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "—");
const stateTone = (state: string): "success" | "warning" | "danger" | "info" | "neutral" =>
  state === "completed" ? "success" : state.startsWith("blocked_") ? "danger" : state.startsWith("provider_") || state === "failed" ? "warning" : state === "handed_off" ? "info" : "neutral";

async function api<T>(init?: RequestInit & { query?: string }): Promise<T> {
  const response = await fetch(`/api/voice-outbound${init?.query ?? ""}`, init?.method ? init : { cache: "no-store" });
  const payload = await response.json() as { data?: T; error?: string };
  if (!response.ok) throw new Error(payload.error || `Voice request failed (${response.status})`);
  return payload.data as T;
}
const post = <T,>(body: Record<string, unknown>) => api<T>({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function snapshot(stateFilter: string): Promise<{ readiness: Readiness; ledger: LedgerRow[] }> {
  const [readiness, ledger] = await Promise.all([
    api<Readiness>(),
    api<LedgerRow[]>({ query: `?scope=ledger&limit=100${stateFilter ? `&state=${encodeURIComponent(stateFilter)}` : ""}` }),
  ]);
  return { readiness, ledger };
}

type Form = OperatorForm;
const EMPTY_FORM: Form = { useCase: "", phone: "", cityId: "blr", customerId: "", leadId: "", bookingId: "" };

export default function VoiceOperatorPage() {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [stateFilter, setStateFilter] = useState("");
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  // The preview is held together with the exact form it was run against. Comparing the two is what
  // stops a preview for one recipient authorising a dial to another.
  const [preview, setPreview] = useState<(OperatorPreview & { result: Preview }) | null>(null);
  const [audit, setAudit] = useState<Audit | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  // `snapshot` is module-level and returns data rather than setting it, so the effect below assigns
  // state exactly once from a resolved value instead of calling into a setter chain.
  const load = useCallback(async () => {
    const next = await snapshot(stateFilter);
    setReadiness(next.readiness);
    setLedger(next.ledger);
  }, [stateFilter]);

  useEffect(() => {
    let active = true;
    void snapshot(stateFilter).then(
      next => { if (active) { setReadiness(next.readiness); setLedger(next.ledger); } },
      caught => { if (active) setError(caught instanceof Error ? caught.message : String(caught)); },
    );
    return () => { active = false; };
  }, [stateFilter]);

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label); setError(""); setNotice("");
    try { await action(); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); } finally { setBusy(""); }
  };

  const gate = readiness?.gate;
  const dialAllowedByGate = Boolean(gate?.enabled);
  // Every reason a dial may or may not be offered comes from lib/voice-operator-console, so the
  // decision is executed by tests rather than inferred from this markup.
  const decision = operatorDialDecision({ gate: gate ?? null, useCases: readiness?.useCases ?? [], form, preview });
  // Whether the held preview belongs to the request now on screen - the same predicate the decision
  // uses, so the check table below can never show a decision for a request the operator has edited.
  const previewIsCurrent = previewMatchesForm(preview, form);

  const setField = (key: keyof Form) => (event: { target: { value: string } }) => {
    setForm(current => ({ ...current, [key]: event.target.value }));
    setPreview(null); // any edit invalidates the previewed decision
  };

  const checkPolicy = () => run("preview", async () => {
    const result = await post<Preview>({ action: "policy_preview", useCase: form.useCase, phone: form.phone, cityId: form.cityId, customerId: form.customerId || null, leadId: form.leadId || null, bookingId: form.bookingId || null });
    setPreview({ for: form, result, idempotencyKey: `op-${crypto.randomUUID()}` });
    setNotice(result.allowed ? "Policy allows this call. Nothing has been dialled." : `Blocked by ${result.blockedBy}. Nothing has been dialled.`);
  });

  const placeCall = () => run("dial", async () => {
    if (!decision.canDial || !decision.idempotencyKey) throw new Error(decision.reasons[0] || "Run a policy check for this exact request first");
    const result = await post<LedgerRow & { state: string }>({ action: "request_call", idempotencyKey: decision.idempotencyKey, useCase: form.useCase, phone: form.phone, cityId: form.cityId, customerId: form.customerId || null, leadId: form.leadId || null, bookingId: form.bookingId || null });
    setNotice(`Call ${result.callId} is in state ${result.state}.`);
    await load();
  });

  const callAction = (callId: string, action: string, extra: Record<string, unknown> = {}) => run(`${action}:${callId}`, async () => {
    const result = await post<{ callId?: string; state?: string }>({ action, callId, ...extra });
    setNotice(`${action} on ${callId}: ${result.state ?? "recorded"}.`);
    await load();
    if (audit?.call.callId === callId) setAudit(await api<Audit>({ query: `?scope=audit&callId=${encodeURIComponent(callId)}` }));
  });

  const openAudit = (callId: string) => run(`audit:${callId}`, async () => {
    setAudit(await api<Audit>({ query: `?scope=audit&callId=${encodeURIComponent(callId)}` }));
  });

  const states = useMemo(() => [...new Set(ledger.map(row => row.state))].sort(), [ledger]);
  const selectedUseCase = readiness?.useCases.find(item => item.code === form.useCase) ?? null;

  return (
    <TeamShell
      eyebrow="PAWSPACE TEAM · VOICE OPERATIONS"
      title="Automated outbound calling"
      description="Every call is gated by the environment, the consent and opt-out record, quiet hours, the recipient allow-list and a per-recipient cap. Nothing on this page can switch calling on; it reports what the environment already allows."
      nav={[{ href: "/team/ai", label: "AI governance" }, { href: "/team/cases", label: "Cases" }, { href: "/team", label: "Team home", primary: true }]}
      status={<>
        <TeamAlert tone="error">{error}</TeamAlert>
        <TeamAlert tone="info">{notice}</TeamAlert>
      </>}
    >
      <TeamStatGrid>
        <StatCard label="Calling" value={gate ? (gate.enabled ? "ENABLED" : "DISABLED") : "…"} meta={gate?.blockedReason ?? `mode ${gate?.mode ?? "—"}`} />
        <StatCard label="Allow-listed numbers" value={gate?.allowlistSize ?? "…"} meta="a number outside this list is refused" />
        <StatCard label="Production calls placed" value={readiness?.productionCallsPlaced ?? "…"} meta="from the ledger, not from configuration" />
        <StatCard label="Needs attention" value={`${readiness?.unappliedProviderEvents ?? 0} / ${readiness?.callsOpenOverAnHour ?? 0}`} meta="unapplied provider events / calls open over an hour" />
      </TeamStatGrid>

      <TeamSection title="Environment" note="Read-only. Secret NAMES are shown so a missing one can be identified; no value is ever returned to this page.">
        <TeamTable
          head={["Setting", "State", "Detail"]}
          rows={gate ? [
            ["Mode", <Badge key="m" tone={gate.mode === "live" ? "danger" : "info"}>{gate.mode}</Badge>, gate.mode === "live" ? "Live mode: real customers can be called" : "Non-live mode"],
            ["UAT approved", <Badge key="u" tone={gate.uatApproved ? "success" : "neutral"}>{gate.uatApproved ? "yes" : "no"}</Badge>, "Approval to run the UAT scenarios"],
            ["Live approved", <Badge key="l" tone={gate.liveApproved ? "warning" : "neutral"}>{gate.liveApproved ? "yes" : "no"}</Badge>, "Separate approval; not implied by UAT"],
            ["Telephony credentials", <Badge key="c" tone={gate.telephonyCredentialsConfigured ? "success" : "danger"}>{gate.telephonyCredentialsConfigured ? "configured" : "incomplete"}</Badge>, gate.missingSecretNames.length ? `missing: ${gate.missingSecretNames.join(", ")}` : "all six present"],
            ["Status callback", <Badge key="s" tone={gate.statusCallbackConfigured ? "success" : "danger"}>{gate.statusCallbackConfigured ? "configured" : "missing"}</Badge>, "Where the carrier reports call state"],
            ["Transport", <Badge key="t" tone={readiness?.transport.configured ? "success" : "neutral"}>{readiness?.transport.provider ?? "—"}</Badge>, "The adapter that would place the dial"],
            ["Recording", <Badge key="r" tone={gate.recordingApproved ? "warning" : "neutral"}>{gate.recordingApproved ? "approved" : "not approved"}</Badge>, "Recording requires its own explicit approval"],
            ["Outbound sales", <Badge key="o" tone={gate.salesOutboundApproved ? "warning" : "neutral"}>{gate.salesOutboundApproved ? "approved" : "not approved"}</Badge>, "Sales and qualification use cases stay unavailable without it"],
          ] : []}
          empty="Loading environment state…"
        />
      </TeamSection>

      <TeamSection title="Place a call" note="Check policy first. The dial button stays disabled until a policy check for this exact request comes back allowed.">
        {!dialAllowedByGate && <TeamAlert tone="error">{gate?.blockedReason || "Calling is disabled by the environment."} No control on this page can change that.</TeamAlert>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", gap: 12, marginBottom: 12 }}>
          <label>Use case
            <select value={form.useCase} onChange={setField("useCase")} disabled={!dialAllowedByGate}>
              <option value="">Select a use case…</option>
              {(readiness?.useCases ?? []).map(item => (
                <option key={item.code} value={item.code} disabled={!item.availableNow}>
                  {item.label}{item.availableNow ? "" : " — needs outbound sales approval"}
                </option>
              ))}
            </select>
          </label>
          <label>Recipient number<input value={form.phone} onChange={setField("phone")} placeholder="allow-listed number only" disabled={!dialAllowedByGate} /></label>
          <label>City<input value={form.cityId} onChange={setField("cityId")} disabled={!dialAllowedByGate} /></label>
          <label>Customer ID<input value={form.customerId} onChange={setField("customerId")} disabled={!dialAllowedByGate} /></label>
          <label>Lead ID<input value={form.leadId} onChange={setField("leadId")} disabled={!dialAllowedByGate} /></label>
          <label>Booking ID<input value={form.bookingId} onChange={setField("bookingId")} placeholder={selectedUseCase?.requiresBooking ? "required for this use case" : "optional"} disabled={!dialAllowedByGate} /></label>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <Button variant="secondary" onClick={checkPolicy} disabled={!decision.canPreview || busy === "preview"}>{busy === "preview" ? "Checking…" : "Check policy (no dial)"}</Button>
          <Button variant="danger" onClick={placeCall} disabled={!decision.canDial || busy === "dial"}>{busy === "dial" ? "Placing…" : "Place call"}</Button>
          {decision.reasons.length > 0 && <small>{decision.reasons[0]}</small>}
        </div>
        {previewIsCurrent && preview && (
          <div style={{ marginTop: 14 }}>
            <TeamTable
              head={["Policy check", "Result", "Detail"]}
              rows={preview.result.checks.map(check => [check.code, <Badge key={check.code} tone={check.passed ? "success" : "danger"}>{check.passed ? "pass" : "blocked"}</Badge>, check.detail])}
            />
          </div>
        )}
      </TeamSection>

      <TeamSection
        title="Call ledger"
        note="Every refusal is recorded here with the reason. Only the last four digits of a number are ever returned by the API."
        actions={
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <select value={stateFilter} onChange={event => setStateFilter(event.target.value)}>
              <option value="">All states</option>
              {states.map(state => <option key={state} value={state}>{state}</option>)}
            </select>
            <Button variant="ghost" onClick={() => void run("refresh", load)} disabled={Boolean(busy)}>Refresh</Button>
          </div>
        }
      >
        <TeamTable
          head={["Call", "State", "Use case", "Number", "Consent / opt-out / quiet hours", "Provider", "Operator actions"]}
          rows={ledger.map(row => [
            <span key="id">{row.callId}{row.retryOf ? <small> · retry {row.retryAttempt} of {row.retryOf}</small> : null}</span>,
            <span key="st"><Badge tone={stateTone(row.state)}>{row.state}</Badge>{row.failureReasonClass ? <small> {row.failureReasonClass}</small> : null}</span>,
            <span key="uc">{row.useCase}<small> · {row.purpose}</small></span>,
            maskedNumber(row.phoneLast4),
            `${row.consentDecision} / ${row.optOutDecision} / ${row.quietHoursDecision}`,
            <span key="pr">{row.provider}{row.productionCall ? <Badge tone="warning"> production</Badge> : <Badge tone="neutral"> non-production</Badge>}</span>,
            <span key="ac" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Button size="sm" variant="ghost" onClick={() => void openAudit(row.callId)}>Audit</Button>
              <Button size="sm" variant="secondary" onClick={() => void callAction(row.callId, "handoff", { reason: "Operator escalated to a human" })} disabled={Boolean(busy)}>Hand off</Button>
              <Button size="sm" variant="secondary" onClick={() => void callAction(row.callId, "opt_out", { reason: "Recipient asked not to be called" })} disabled={Boolean(busy)}>Opt out</Button>
              <Button size="sm" variant="secondary" onClick={() => void callAction(row.callId, "retry")} disabled={Boolean(busy) || !dialAllowedByGate}>Retry</Button>
              <Button size="sm" variant="danger" onClick={() => void callAction(row.callId, "cancel", { reason: "Cancelled by operator" })} disabled={Boolean(busy)}>Cancel</Button>
            </span>,
          ])}
          empty="No calls have been requested. A refused call is still recorded, so an empty ledger means nothing has been attempted."
        />
      </TeamSection>

      {audit && (
        <TeamSection title={`Audit · ${audit.call.callId}`} note={audit.truth.productionCallExecuted ? "A production call was executed for this record." : "No production call was executed for this record."} actions={<Button variant="ghost" onClick={() => setAudit(null)}>Close</Button>}>
          <TeamTable head={["Policy check", "Result", "Detail", "At"]} rows={audit.policyDecisions.map(decision => [decision.checkCode, <Badge key={decision.checkCode} tone={decision.passed ? "success" : "danger"}>{decision.passed ? "pass" : "blocked"}</Badge>, decision.detail, IST(decision.at)])} empty="No policy decisions recorded." />
          <TeamTable head={["#", "From", "To", "Reason", "Actor", "At"]} rows={audit.transitions.map(transition => [String(transition.sequence), String(transition.from_state ?? "—"), String(transition.to_state), String(transition.reason ?? ""), String(transition.actor ?? ""), IST(transition.created_at)])} empty="No state transitions recorded." />
          <TeamTable head={["Provider event", "Status", "Signature", "Applied", "At"]} rows={audit.providerEvents.map(event => [String(event.event_kind), String(event.provider_status ?? "—"), String(event.signature_mechanism ?? "—"), Number(event.applied) === 1 ? "yes" : "no", IST(event.created_at)])} empty="No provider callbacks received." />
        </TeamSection>
      )}

      <TeamSection title="Scripts" note="A script containing a claim word cannot be activated until a human has approved that script's claims.">
        <TeamTable
          head={["Use case", "Active", "Claims approved", "Version"]}
          rows={(readiness?.scripts ?? []).map(script => [script.useCase, <Badge key={`a${script.useCase}`} tone={script.active ? "success" : "neutral"}>{script.active ? "active" : "inactive"}</Badge>, <Badge key={`c${script.useCase}`} tone={script.claimsApproved ? "warning" : "neutral"}>{script.claimsApproved ? "approved" : "not approved"}</Badge>, script.version])}
          empty="No scripts seeded."
        />
      </TeamSection>
    </TeamShell>
  );
}
