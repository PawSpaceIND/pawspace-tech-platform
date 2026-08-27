"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, EmptyState } from "../../../components/ui";
import OpsShell from "../../../components/ops-shell/OpsShell";
import teamStyles from "../../team-console.module.css";

type Row = Record<string, unknown>;
type Config = { enabled?: boolean; delaysMinutes?: number[]; templateKeys?: string[]; offerType?: string; offerReference?: string; quietHoursStart?: string; quietHoursEnd?: string; quietHoursTimezone?: string; maxMarketingMessagesPer24h?: number; policyReady?: boolean; updatedBy?: string; updatedAt?: number };
type Data = { config?: Config; sequences?: Row[]; rules?: Row[]; productionDelivery?: boolean; environment?: string; aiArmingPolicy?: string; ruleExecutionBoundary?: string };
type Trigger = "conversation_started" | "inbound_message" | "working_hours_open" | "working_hours_closed" | "customer_no_response";
type ActionType = "send_welcome" | "send_ooo" | "start_chatbot" | "schedule_no_response" | "route" | "webhook" | "tool";

const defaultRecoveryTemplates = ["booking_recovery_10m", "booking_recovery_30m", "booking_recovery_180m"];
const text = (value: unknown, fallback = "—") => String(value ?? "").trim() || fallback;
const pretty = (value: unknown) => text(value).replaceAll("_", " ");
const dateTime = (value: unknown) => value ? new Date(Number(value)).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "—";

export default function WhatsAppAutomationPage() {
  const [data, setData] = useState<Data>({});
  const [enabled, setEnabled] = useState(false);
  const [templates, setTemplates] = useState([...defaultRecoveryTemplates]);
  const [offerType, setOfferType] = useState("special_booking_recovery");
  const [offerReference, setOfferReference] = useState("");
  const [quietHoursStart, setQuietHoursStart] = useState("");
  const [quietHoursEnd, setQuietHoursEnd] = useState("");
  const [quietHoursTimezone, setQuietHoursTimezone] = useState("");
  const [maxMarketingMessagesPer24h, setMaxMarketingMessagesPer24h] = useState(0);
  const [ruleId, setRuleId] = useState("welcome-hours");
  const [ruleName, setRuleName] = useState("Welcome during working hours");
  const [ruleEnabled, setRuleEnabled] = useState(true);
  const [trigger, setTrigger] = useState<Trigger>("working_hours_open");
  const [messageClass, setMessageClass] = useState<"any" | "template" | "non_template">("any");
  const [keywords, setKeywords] = useState("");
  const [defaultAction, setDefaultAction] = useState(false);
  const [workStart, setWorkStart] = useState("09:00");
  const [workEnd, setWorkEnd] = useState("18:00");
  const [workTimezone, setWorkTimezone] = useState("Asia/Kolkata");
  const [actionType, setActionType] = useState<ActionType>("send_welcome");
  const [actionValue, setActionValue] = useState("Welcome to PawSpace.");
  const [routeStrategy, setRouteStrategy] = useState<"last_assignee" | "team" | "round_robin">("last_assignee");
  const [teamCode, setTeamCode] = useState("sales_blr");
  const [evalThreadId, setEvalThreadId] = useState("");
  const [evalEventId, setEvalEventId] = useState("");
  const [evalMessage, setEvalMessage] = useState("");
  const [evaluation, setEvaluation] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/whatsapp/automation", { cache: "no-store" });
    const payload = await response.json().catch(() => ({})) as { data?: Data; error?: string };
    if (!response.ok) throw new Error(payload.error || `Unable to load automation (HTTP ${response.status})`);
    const next = payload.data || {};
    setData(next);
    if (next.config) {
      setEnabled(next.config.enabled === true);
      setTemplates(next.config.templateKeys?.length === 3 ? next.config.templateKeys : [...defaultRecoveryTemplates]);
      setOfferType(next.config.offerType || "special_booking_recovery");
      setOfferReference(next.config.offerReference || "");
      setQuietHoursStart(next.config.quietHoursStart || "");
      setQuietHoursEnd(next.config.quietHoursEnd || "");
      setQuietHoursTimezone(next.config.quietHoursTimezone || "");
      setMaxMarketingMessagesPer24h(Number(next.config.maxMarketingMessagesPer24h || 0));
    }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }, 0); return () => window.clearTimeout(timer); }, [load]);

  async function act(action: string, payload: Row = {}) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/whatsapp/automation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
      const body = await response.json().catch(() => ({})) as { data?: Row; error?: string };
      if (!response.ok) throw new Error(body.error || `Automation action failed (HTTP ${response.status})`);
      if (action === "evaluate_rule_uat") setEvaluation(body.data || null);
      else await load();
      setNotice(action === "process_due_uat" ? "Due recovery steps processed through the governed UAT outbox." : action === "save_rule_contract" ? "Governed UAT rule contract saved and audited." : action === "evaluate_rule_uat" ? "Rule evaluated in UAT. External mutation remains disabled." : "No-response recovery policy saved.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }

  function ruleAction(): Row {
    if (actionType === "send_welcome" || actionType === "send_ooo") return { type: actionType, text: actionValue };
    if (actionType === "start_chatbot") return { type: actionType, entryPoint: keywords.trim() ? "keyword" : "default" };
    if (actionType === "schedule_no_response") return { type: actionType, profile: "10m_30m_3h" };
    if (actionType === "route") return { type: actionType, strategy: routeStrategy, ...(routeStrategy === "last_assignee" ? {} : { teamCode }) };
    if (actionType === "webhook") return { type: actionType, targetKey: actionValue || "crm_event", authMode: "hmac_sha256" };
    return { type: "tool", toolKey: actionValue || "booking_lookup", authMode: "service_token" };
  }

  function ruleContract() {
    const filters: Row = { messageClass, keywords: keywords.split(",").map((item) => item.trim()).filter(Boolean), defaultAction };
    if (trigger === "working_hours_open" || trigger === "working_hours_closed") filters.workingHours = { start: workStart, end: workEnd, timeZone: workTimezone };
    return { id: ruleId.trim().toLowerCase(), name: ruleName.trim(), enabled: ruleEnabled, trigger, filters, actions: [ruleAction()] };
  }

  const sequences = data.sequences || [];
  const savedRules = data.rules || [];
  const policyReady = Boolean(quietHoursStart && quietHoursEnd && quietHoursTimezone && maxMarketingMessagesPer24h >= 1);

  return <OpsShell eyebrow="PawSpace team · WhatsApp" title="Automation Studio" description="Governed WATI-style rules and no-response recovery on PawSpace canonical conversations. Rule evaluation is UAT-only; external webhook/tool mutation and production WhatsApp delivery remain disabled." actions={<><Badge tone="info">UAT sandbox</Badge><Badge tone="warning">Production delivery disabled</Badge></>}>
    {error ? <div className={`${teamStyles.panel} ${teamStyles.panelError}`}><b>{error}</b></div> : null}
    {notice ? <div className={teamStyles.panel}><b>{notice}</b></div> : null}

    <section className={teamStyles.panel}>
      <div className={teamStyles.panelHead}><h2>Governed rule builder</h2><span>trigger → filters → actions</span></div>
      <p className={teamStyles.panelNote}>Rules are versioned and audited. Routing must use canonical assignment policy. Webhook/tool actions are allow-listed and authenticated, but this UAT evaluator returns a governed plan only and cannot mutate an external system.</p>
      <div className={teamStyles.fieldRow}>
        <label className={teamStyles.field}>Rule ID<input value={ruleId} onChange={(event) => setRuleId(event.target.value.toLowerCase())} maxLength={64} /></label>
        <label className={teamStyles.field}>Name<input value={ruleName} onChange={(event) => setRuleName(event.target.value)} maxLength={120} /></label>
        <label className={teamStyles.field}>Status<select value={ruleEnabled ? "enabled" : "disabled"} onChange={(event) => setRuleEnabled(event.target.value === "enabled")}><option value="enabled">Enabled in UAT</option><option value="disabled">Disabled</option></select></label>
        <label className={teamStyles.field}>Trigger<select value={trigger} onChange={(event) => setTrigger(event.target.value as Trigger)}><option value="conversation_started">Conversation started</option><option value="inbound_message">Inbound message</option><option value="working_hours_open">Working hours open</option><option value="working_hours_closed">Out of office</option><option value="customer_no_response">Customer no response</option></select></label>
      </div>
      <div className={teamStyles.fieldRow}>
        <label className={teamStyles.field}>Message class<select value={messageClass} onChange={(event) => setMessageClass(event.target.value as typeof messageClass)}><option value="any">Any</option><option value="template">Template</option><option value="non_template">Non-template</option></select></label>
        <label className={teamStyles.field}>Keywords<input value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder="grooming, training" /></label>
        <label className={teamStyles.field}>Fallback<select value={defaultAction ? "default" : "match"} onChange={(event) => setDefaultAction(event.target.value === "default")}><option value="match">Keyword match only</option><option value="default">Default action</option></select></label>
        <label className={teamStyles.field}>Action<select value={actionType} onChange={(event) => setActionType(event.target.value as ActionType)}><option value="send_welcome">Welcome message</option><option value="send_ooo">Out-of-office message</option><option value="start_chatbot">Start chatbot</option><option value="schedule_no_response">Schedule 10m/30m/3h</option><option value="route">Route</option><option value="webhook">Webhook plan</option><option value="tool">Tool plan</option></select></label>
      </div>
      {(trigger === "working_hours_open" || trigger === "working_hours_closed") ? <div className={teamStyles.fieldRow}><label className={teamStyles.field}>Start<input type="time" value={workStart} onChange={(event) => setWorkStart(event.target.value)} /></label><label className={teamStyles.field}>End<input type="time" value={workEnd} onChange={(event) => setWorkEnd(event.target.value)} /></label><label className={teamStyles.field}>Timezone<input value={workTimezone} onChange={(event) => setWorkTimezone(event.target.value)} /></label></div> : null}
      {actionType === "send_welcome" || actionType === "send_ooo" ? <label className={teamStyles.field}>Message<input value={actionValue} onChange={(event) => setActionValue(event.target.value)} maxLength={1024} /></label> : null}
      {actionType === "webhook" ? <label className={teamStyles.field}>Allow-listed target<select value={actionValue || "crm_event"} onChange={(event) => setActionValue(event.target.value)}><option value="crm_event">CRM event</option><option value="booking_event">Booking event</option><option value="case_event">Case event</option></select></label> : null}
      {actionType === "tool" ? <label className={teamStyles.field}>Allow-listed tool<select value={actionValue || "booking_lookup"} onChange={(event) => setActionValue(event.target.value)}><option value="lead_update">Lead update</option><option value="booking_lookup">Booking lookup</option><option value="booking_quote">Booking quote</option></select></label> : null}
      {actionType === "route" ? <div className={teamStyles.fieldRow}><label className={teamStyles.field}>Routing strategy<select value={routeStrategy} onChange={(event) => setRouteStrategy(event.target.value as typeof routeStrategy)}><option value="last_assignee">Last assignee</option><option value="team">Explicit team</option><option value="round_robin">Round robin</option></select></label>{routeStrategy !== "last_assignee" ? <label className={teamStyles.field}>Canonical team code<input value={teamCode} onChange={(event) => setTeamCode(event.target.value.toLowerCase())} /></label> : null}</div> : null}
      <div className={teamStyles.actions}><Button type="button" disabled={busy || !ruleId.trim() || !ruleName.trim()} onClick={() => { void act("save_rule_contract", { rule: ruleContract() }); }}>Save rule contract</Button></div>
    </section>

    <section className={teamStyles.panel}>
      <div className={teamStyles.panelHead}><h2>UAT rule evaluator</h2><span>no external mutation</span></div>
      <div className={teamStyles.fieldRow}><label className={teamStyles.field}>Canonical thread<input value={evalThreadId} onChange={(event) => setEvalThreadId(event.target.value)} placeholder="THREAD-..." /></label><label className={teamStyles.field}>Event ID<input value={evalEventId} onChange={(event) => setEvalEventId(event.target.value)} placeholder="EV-..." /></label><label className={teamStyles.field}>Message text<input value={evalMessage} onChange={(event) => setEvalMessage(event.target.value)} /></label></div>
      <div className={teamStyles.actions}><Button type="button" variant="secondary" disabled={busy || !ruleId.trim() || !evalThreadId.trim() || !evalEventId.trim()} onClick={() => { void act("evaluate_rule_uat", { ruleId: ruleId.trim().toLowerCase(), threadId: evalThreadId.trim(), eventId: evalEventId.trim(), trigger, messageText: evalMessage, messageClass: messageClass === "any" ? undefined : messageClass }); }}>Evaluate rule in UAT</Button></div>
      {evaluation ? <pre>{JSON.stringify(evaluation, null, 2)}</pre> : null}
      <p className={teamStyles.panelNote}>{text(data.ruleExecutionBoundary, "Governed UAT evaluation only; external mutation disabled")}</p>
    </section>

    <section className={teamStyles.panel}><div className={teamStyles.panelHead}><h2>Saved governed rules</h2><span>{savedRules.length} rules</span></div>{savedRules.length === 0 ? <EmptyState title="No governed rules saved." body="Create a UAT rule contract above." /> : <div className={teamStyles.tableWrap}><table className={teamStyles.table}><thead><tr><th>Rule</th><th>Trigger</th><th>Status</th><th>Version</th><th>Updated by</th></tr></thead><tbody>{savedRules.map((row) => <tr key={text(row.id)}><td><b>{text(row.name)}</b><br/><small>{text(row.id)}</small></td><td>{pretty(row.trigger)}</td><td>{pretty(row.status)}</td><td>{Number(row.version || 0)}</td><td>{text(row.updated_by)}</td></tr>)}</tbody></table></div>}</section>

    <section className={teamStyles.panel}>
      <div className={teamStyles.panelHead}><h2>Customer no-response recovery</h2><span>10m → 30m → 3h</span></div>
      <p className={teamStyles.panelNote}>This is booking recovery, not bulk marketing. Every discount send requires WhatsApp consent, marketing consent, an approved Meta marketing template, an approved business offer reference, approved quiet hours and a rolling 24-hour marketing frequency cap.</p>
      <div className={teamStyles.fieldRow}><label className={teamStyles.field}>Automation<select value={enabled ? "enabled" : "disabled"} onChange={(event) => setEnabled(event.target.value === "enabled")}><option value="enabled">Enabled when policy-ready</option><option value="disabled">Disabled</option></select></label><label className={teamStyles.field}>Special discount type<input value={offerType} onChange={(event) => setOfferType(event.target.value.toLowerCase())} maxLength={64} /></label><label className={teamStyles.field}>Approved offer / coupon reference<input value={offerReference} onChange={(event) => setOfferReference(event.target.value)} maxLength={120} /></label></div>
      <div className={teamStyles.fieldRow}><label className={teamStyles.field}>Quiet hours start<input type="time" value={quietHoursStart} onChange={(event) => setQuietHoursStart(event.target.value)} /></label><label className={teamStyles.field}>Quiet hours end<input type="time" value={quietHoursEnd} onChange={(event) => setQuietHoursEnd(event.target.value)} /></label><label className={teamStyles.field}>Timezone<input value={quietHoursTimezone} onChange={(event) => setQuietHoursTimezone(event.target.value)} placeholder="Asia/Kolkata" /></label><label className={teamStyles.field}>Max marketing / 24h<input type="number" min={1} max={100} value={maxMarketingMessagesPer24h || ""} onChange={(event) => setMaxMarketingMessagesPer24h(Number(event.target.value || 0))} /></label></div>
      <div className={teamStyles.fieldRow}>{[10, 30, 180].map((minutes, index) => <label className={teamStyles.field} key={minutes}>{minutes === 180 ? "3 hour" : `${minutes} minute`} template<input value={templates[index] || ""} onChange={(event) => setTemplates((current) => current.map((value, i) => i === index ? event.target.value.toLowerCase() : value))} maxLength={64} /></label>)}</div>
      <div className={teamStyles.actions}><Button type="button" disabled={busy || (enabled && (!offerReference.trim() || !policyReady))} onClick={() => { void act("save_no_response", { enabled, templateKeys: templates, offerType, offerReference, quietHoursStart, quietHoursEnd, quietHoursTimezone, maxMarketingMessagesPer24h }); }}>Save governed sequence</Button><Button type="button" variant="secondary" disabled={busy} onClick={() => { void act("process_due_uat", { limit: 50 }); }}>Run due sweep in UAT</Button></div>
    </section>

    <section className={teamStyles.panel}><div className={teamStyles.panelHead}><h2>Stop conditions & execution policy</h2><span>Fail closed</span></div><div className={teamStyles.grid}><div><b>Customer activity</b><p>Any newer inbound WhatsApp reply cancels every remaining step.</p></div><div><b>Human ownership</b><p>Human-only routing or routing change cancels recovery.</p></div><div><b>Booking truth</b><p>A linked canonical booking stops booking recovery.</p></div><div><b>Consent & offer</b><p>Opt-out, missing consent, unapproved template or missing offer blocks the sequence.</p></div><div><b>Quiet hours</b><p>Due marketing steps are deferred during quiet hours.</p></div><div><b>Frequency cap</b><p>Due steps defer until an eligible rolling-24h slot exists.</p></div></div><p className={teamStyles.panelNote}>{text(data.aiArmingPolicy, "AI recovery remains disabled until a governed AI outbound exists.")}</p></section>

    <section className={teamStyles.panel}><div className={teamStyles.panelHead}><h2>Recent recovery sequences</h2><span>{sequences.length} tracked</span></div>{sequences.length === 0 ? <EmptyState title="No recovery sequences yet." body="A sequence is armed only after a governed automated WhatsApp outbound message." /> : <div className={teamStyles.tableWrap}><table className={teamStyles.table}><thead><tr><th>Conversation</th><th>Mode</th><th>Status</th><th>Offer</th><th>Steps</th><th>Updated</th></tr></thead><tbody>{sequences.map((row) => <tr key={text(row.id)}><td><b>{text(row.thread_id)}</b><br/><small>{text(row.customer_id)}</small></td><td>{pretty(row.routing_mode)}</td><td><Badge tone={text(row.status) === "completed" ? "success" : text(row.status) === "active" ? "info" : "warning"}>{pretty(row.status)}</Badge><br/><small>{text(row.cancel_reason, "")}</small></td><td>{pretty(row.offer_type)}<br/><small>{text(row.offer_reference)}</small></td><td>{Number(row.queued_steps || 0)} sent · {Number(row.pending_steps || 0)} pending</td><td>{dateTime(row.updated_at)}</td></tr>)}</tbody></table></div>}</section>
    <p className={teamStyles.footnote}>Environment {text(data.environment, "uat")} · production WhatsApp delivery {data.productionDelivery ? "enabled" : "disabled"}. Timers are durable database due-times; sweeps are retry-safe and outbound idempotency prevents duplicate reminders.</p>
  </OpsShell>;
}
