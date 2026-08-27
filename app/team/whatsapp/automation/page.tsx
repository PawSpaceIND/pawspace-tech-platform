"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, EmptyState } from "../../../components/ui";
import OpsShell from "../../../components/ops-shell/OpsShell";
import teamStyles from "../../team-console.module.css";

type Row = Record<string, unknown>;
type Config = { enabled?: boolean; delaysMinutes?: number[]; templateKeys?: string[]; offerType?: string; offerReference?: string; quietHoursStart?: string; quietHoursEnd?: string; quietHoursTimezone?: string; maxMarketingMessagesPer24h?: number; policyReady?: boolean; updatedBy?: string; updatedAt?: number };
type Data = { config?: Config; sequences?: Row[]; productionDelivery?: boolean; environment?: string; aiArmingPolicy?: string };
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
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || `Automation action failed (HTTP ${response.status})`);
      await load(); setNotice(action === "process_due_uat" ? "Due recovery steps processed through the governed UAT outbox." : "No-response recovery policy saved.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }

  const sequences = data.sequences || [];
  const policyReady = Boolean(quietHoursStart && quietHoursEnd && quietHoursTimezone && maxMarketingMessagesPer24h >= 1);
  return <OpsShell eyebrow="PawSpace team · WhatsApp" title="Automation Studio" description="WATI-style no-response recovery on PawSpace canonical conversations. The first governed profile follows 10 minutes → 30 minutes → 3 hours and stops immediately when the customer replies, a human takes over, the customer opts out, a booking is linked, or send policy fails." actions={<><Badge tone="info">UAT sandbox</Badge><Badge tone="warning">Production delivery disabled</Badge></>}>
    {error ? <div className={`${teamStyles.panel} ${teamStyles.panelError}`}><b>{error}</b></div> : null}
    {notice ? <div className={teamStyles.panel}><b>{notice}</b></div> : null}
    <section className={teamStyles.panel}>
      <div className={teamStyles.panelHead}><h2>Customer no-response recovery</h2><span>10m → 30m → 3h</span></div>
      <p className={teamStyles.panelNote}>This is a booking-recovery sequence, not a bulk campaign. Every discount send requires WhatsApp consent, marketing consent, an approved Meta marketing template, an approved business offer reference, approved quiet hours and an approved 24-hour marketing frequency cap. PawSpace does not invent any of those business-policy values.</p>
      <div className={teamStyles.fieldRow}>
        <label className={teamStyles.field}>Automation<select value={enabled ? "enabled" : "disabled"} onChange={(event) => setEnabled(event.target.value === "enabled")}><option value="enabled">Enabled when policy-ready</option><option value="disabled">Disabled</option></select></label>
        <label className={teamStyles.field}>Special discount type<input value={offerType} onChange={(event) => setOfferType(event.target.value.toLowerCase())} maxLength={64} /></label>
        <label className={teamStyles.field}>Approved offer / coupon reference<input value={offerReference} onChange={(event) => setOfferReference(event.target.value)} placeholder="Business-approved offer reference" maxLength={120} /></label>
      </div>
      <div className={teamStyles.fieldRow}>
        <label className={teamStyles.field}>Quiet hours start<input type="time" value={quietHoursStart} onChange={(event) => setQuietHoursStart(event.target.value)} /></label>
        <label className={teamStyles.field}>Quiet hours end<input type="time" value={quietHoursEnd} onChange={(event) => setQuietHoursEnd(event.target.value)} /></label>
        <label className={teamStyles.field}>Quiet-hours timezone<input value={quietHoursTimezone} onChange={(event) => setQuietHoursTimezone(event.target.value)} placeholder="e.g. Asia/Kolkata" maxLength={64} /></label>
        <label className={teamStyles.field}>Max marketing messages / 24h<input type="number" min={1} max={100} value={maxMarketingMessagesPer24h || ""} onChange={(event) => setMaxMarketingMessagesPer24h(Number(event.target.value || 0))} /></label>
      </div>
      <div className={teamStyles.fieldRow}>{[10,30,180].map((minutes,index)=><label className={teamStyles.field} key={minutes}>{minutes === 180 ? "3 hour" : `${minutes} minute`} template<input value={templates[index] || ""} onChange={(event)=>setTemplates((current)=>current.map((value,i)=>i===index?event.target.value.toLowerCase():value))} maxLength={64}/></label>)}</div>
      <p className={teamStyles.panelNote}>Create and independently reconcile these templates as <b>marketing</b> templates in WhatsApp Templates first. A template may contain no variable or exactly <code>{"{{1}}"}</code>, which is replaced only by the configured offer reference.</p>
      <div className={teamStyles.actions}><Button type="button" disabled={busy || (enabled && (!offerReference.trim() || !policyReady))} onClick={()=>{void act("save_no_response",{enabled,templateKeys:templates,offerType,offerReference,quietHoursStart,quietHoursEnd,quietHoursTimezone,maxMarketingMessagesPer24h});}}>Save governed sequence</Button><Button type="button" variant="secondary" disabled={busy} onClick={()=>{void act("process_due_uat",{limit:50});}}>Run due sweep in UAT</Button></div>
    </section>
    <section className={teamStyles.panel}>
      <div className={teamStyles.panelHead}><h2>Stop conditions & execution policy</h2><span>Fail closed</span></div>
      <div className={teamStyles.grid}><div><b>Customer activity</b><p>Any newer inbound WhatsApp reply cancels every remaining step. Duplicate webhook delivery does not create a second sequence.</p></div><div><b>Human ownership</b><p>Human-only routing or a routing change cancels recovery before a message can queue.</p></div><div><b>Booking truth</b><p>Once the canonical conversation is linked to a booking, booking-recovery reminders stop.</p></div><div><b>Consent & offer</b><p>Opt-out, missing WhatsApp consent, missing marketing consent, unapproved template or missing offer reference blocks the sequence.</p></div><div><b>Quiet hours</b><p>Due marketing steps are deferred while the configured local quiet-hour window is active.</p></div><div><b>Frequency cap</b><p>Due steps are deferred until an eligible slot exists under the configured rolling 24-hour marketing-message cap.</p></div></div>
      <p className={teamStyles.panelNote}>{text(data.aiArmingPolicy, "AI recovery remains disabled until a governed AI outbound exists.")}</p>
    </section>
    <section className={teamStyles.panel}><div className={teamStyles.panelHead}><h2>Recent recovery sequences</h2><span>{sequences.length} tracked</span></div>{sequences.length===0?<EmptyState title="No recovery sequences yet." body="A sequence is armed only after a governed automated WhatsApp outbound message."/>:<div className={teamStyles.tableWrap}><table className={teamStyles.table}><thead><tr><th>Conversation</th><th>Mode</th><th>Status</th><th>Offer</th><th>Steps</th><th>Updated</th></tr></thead><tbody>{sequences.map((row)=><tr key={text(row.id)}><td><b>{text(row.thread_id)}</b><br/><small>{text(row.customer_id)}</small></td><td>{pretty(row.routing_mode)}</td><td><Badge tone={text(row.status)==="completed"?"success":text(row.status)==="active"?"info":"warning"}>{pretty(row.status)}</Badge><br/><small>{text(row.cancel_reason,"")}</small></td><td>{pretty(row.offer_type)}<br/><small>{text(row.offer_reference)}</small></td><td>{Number(row.queued_steps||0)} sent · {Number(row.pending_steps||0)} pending</td><td>{dateTime(row.updated_at)}</td></tr>)}</tbody></table></div>}</section>
    <p className={teamStyles.footnote}>Environment {text(data.environment,"uat")} · production WhatsApp delivery {data.productionDelivery?"enabled":"disabled"}. Timers are durable database due-times; the sweep is retry-safe and outbound idempotency prevents duplicate reminders.</p>
  </OpsShell>;
}
