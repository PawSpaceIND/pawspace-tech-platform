"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge, Button, StatCard, TeamAlert, TeamSection, TeamStatGrid, TeamTable } from "../../components/ui";
import type { VoiceSalesOperations } from "../../../lib/voice-sales-operations";

type Coverage = { activeTopics: number; requiredTopics: number; sourceMatchedTopics: number; audioAcceptance: string; liveToolCoverage: string };
type Target = { id: string; target_type: string; service_code: string; daily_goal: number; achieved_count: number; status: string; max_contacts_per_day: number };
type Snapshot = { operations: VoiceSalesOperations | null; coverage: Coverage | null; targets: Target[] | null; errors: string[] };
const display = (value: unknown) => value == null || value === "" ? "Not recorded" : String(value);
async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) throw new Error(response.status === 403 ? "Access requires the existing staff permission" : `Request failed (${response.status})`);
  return (await response.json()).data as T;
}
async function snapshot(signal?: AbortSignal): Promise<Snapshot> {
  const results = await Promise.allSettled([
    get<VoiceSalesOperations>("/api/voice-outbound?scope=sales_operations", signal),
    get<Coverage>("/api/ai-business-configuration?mode=coverage", signal),
    get<Target[]>("/api/admin/sales-targets", signal),
  ]);
  const names = ["Sales operations", "Knowledge coverage", "Sales targets"];
  return {
    operations: results[0].status === "fulfilled" ? results[0].value : null,
    coverage: results[1].status === "fulfilled" ? results[1].value : null,
    targets: results[2].status === "fulfilled" ? results[2].value : null,
    errors: results.flatMap((result, index) => result.status === "rejected" ? [`${names[index]}: ${result.reason instanceof Error ? result.reason.message : "Unavailable"}`] : []),
  };
}

export default function VoiceSalesOperationsPanel() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [reason, setReason] = useState("");
  const [draft, setDraft] = useState({service:"grooming",goal:"1",budget:"5",start:"",end:""});
  useEffect(() => {
    const controller = new AbortController();
    void snapshot(controller.signal).then(next => { if (!controller.signal.aborted) setData(next); });
    return () => controller.abort();
  }, []);
  async function refresh() { setBusy(true); try { setData(await snapshot()); } finally { setBusy(false); } }
  async function changeTarget(action: "pause" | "activate", id: string) {
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/admin/sales-targets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, id, reason }) });
      if (!response.ok) throw new Error(`Target change refused (${response.status})`);
      setNotice(action === "pause" ? "Target paused. Calls already in progress keep their existing cancellation controls below." : "Target activated. Existing environment, consent and dispatch controls still apply.");
      setData(await snapshot());
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to pause target"); }
    finally { setBusy(false); }
  }
  async function createTarget() {
    setBusy(true); setNotice("");
    try {
      const startsAt=Date.parse(`${draft.start}:00+05:30`), endsAt=Date.parse(`${draft.end}:00+05:30`);
      if(!Number.isFinite(startsAt)||!Number.isFinite(endsAt)||endsAt<=startsAt)throw new Error("Choose a valid start and later end in India time.");
      const response=await fetch("/api/admin/sales-targets",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"create",reason,targetType:"booking_conversion",serviceCode:draft.service,cityId:"blr",targetDate:draft.start.slice(0,10),dailyGoal:Number(draft.goal),maxContactsPerDay:Number(draft.budget),authorizedChannels:["voice"],authorizedDiscountMaxBps:0,minimumMarginBps:1000,freeUpgradeCodes:[],startsAt,endsAt})});
      if(!response.ok)throw new Error(`Draft creation refused (${response.status})`);
      setNotice("Draft saved. Review it before activating; no call was requested by this action.");setData(await snapshot());
    }catch(error){setNotice(error instanceof Error?error.message:"Unable to save draft");}finally{setBusy(false);}
  }
  const ops = data?.operations, coverage = data?.coverage;
  return <>
    <TeamSection title="AI sales overview" note="Grooming pilot first. A completed call or a checkout link does not prove a paid booking." actions={<Button variant="secondary" onClick={() => void refresh()} disabled={busy}>{busy ? "Refreshing…" : "Refresh sales overview"}</Button>}>
      {!data && <TeamAlert tone="info">Loading operational evidence…</TeamAlert>}
      {data?.errors.map(error => <TeamAlert key={error}>{error}</TeamAlert>)}
      {ops?.sources.filter(source => !source.available).map(source => <TeamAlert key={source.name}>{source.name} is unavailable. Its records have not been counted as zero.</TeamAlert>)}
      <TeamStatGrid>
        <StatCard label="Approved knowledge" value={coverage ? `${coverage.activeTopics} / ${coverage.requiredTopics}` : "Unknown"} meta={coverage ? `${coverage.sourceMatchedTopics} match the reviewed source` : "Requires knowledge access"} />
        <StatCard label="Post-call updates pending" value={ops?.pendingWebhooks ?? "Unknown"} meta="Provider events not fully reconciled" />
        <StatCard label="CRM writes pending" value={ops?.pendingCrmWrites ?? "Unknown"} meta="Processing or retryable writes" />
        <StatCard label="Launch certification" value="Not certified" meta="Requires attended audio and completed-sales evidence" />
      </TeamStatGrid>
      <p><Link href="/v2/team/voice/ai-test">Test Maya</Link> · <Link href="/v2/team/ai">AI configuration</Link> · <Link href="/v2/team/sales/power-dialler">Human follow-up</Link> · <Link href="/v2/team/finance/reconciliation">Payment reconciliation</Link></p>
      {ops && <small>Updated {new Date(ops.asOf).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST. {ops.certificationReason}</small>}
    </TeamSection>
    <TeamSection title="Voice booking journey" note="Latest 30 offers. Payment status comes from the booking payment record; provider ID indicates assignment, not provider acceptance. Missing values remain unverified.">
      <TeamTable head={["Offer / service", "Checkout", "Booking", "Payment link", "Payment record", "Provider assignment"]} rows={(ops?.offers ?? []).map(row => [
        `${display(row.id)} · ${display(row.service_code)}`, display(row.status), display(row.booking_id), display(row.payment_link_status), display(row.payment_status), display(row.provider_id),
      ])} empty={ops?.offers ? "No voice offers recorded." : "Booking journey evidence is unavailable."} />
    </TeamSection>
    <TeamSection title="Conversation quality" note="Latest 1,000 voice turns in the past 24 hours. AI processing time excludes carrier playback and is not the customer's measured reply-start latency.">
      <TeamStatGrid>
        <StatCard label="Measured AI turns" value={ops?.quality?.measuredTurns ?? "Unknown"} meta={ops?.quality ? `${ops.quality.sampledTurns} sampled turns` : "Measurements unavailable"}/>
        <StatCard label="AI processing p50" value={ops?.quality?.processingP50Ms == null ? "Unknown" : `${ops.quality.processingP50Ms} ms`}/>
        <StatCard label="AI processing p95" value={ops?.quality?.processingP95Ms == null ? "Unknown" : `${ops.quality.processingP95Ms} ms`}/>
        <StatCard label="Human escalations" value={ops?.quality?.handoffs ?? "Unknown"} meta="Handoff outcomes in the sampled turns"/>
      </TeamStatGrid>
      <p>Voice quality and cost per paid booking require complete audio, carrier-cost and payment evidence. {ops?.quality ? `${ops.quality.turnsWithCost} sampled turns have model-cost records.` : "Model-cost coverage is unknown."}</p>
    </TeamSection>
    <TeamSection title="Inbound conversations" note="Latest 30 sessions. Transcript and customer access remain governed by existing staff permissions.">
      <TeamTable head={["Session", "State", "Language", "Customer turns", "Conversation"]} rows={(ops?.inbound ?? []).map(row => [display(row.id), display(row.status), display(row.language), display(row.turn_index), display(row.thread_id)])} empty={ops?.inbound ? "No inbound sessions recorded." : "Inbound evidence is unavailable."} />
    </TeamSection>
    <TeamSection title="Sales targets" note="Existing approved targets and contact budgets. Pausing stops future target dispatch; it does not hang up active calls.">
      <label>Reason for a target change<input value={reason} onChange={event => setReason(event.target.value)} placeholder="Explain the operational reason" maxLength={500} /></label>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(190px,1fr))",gap:12,marginBlock:16}}>
        <label>Service<select value={draft.service} onChange={event=>setDraft({...draft,service:event.target.value})}><option value="grooming">Grooming</option><option value="dog_training">Dog Training</option></select></label>
        <label>Daily booking goal<input type="number" min="1" step="1" value={draft.goal} onChange={event=>setDraft({...draft,goal:event.target.value})}/></label>
        <label>Daily contact limit<input type="number" min="1" step="1" value={draft.budget} onChange={event=>setDraft({...draft,budget:event.target.value})}/></label>
        <label>Start (India time)<input type="datetime-local" value={draft.start} onChange={event=>setDraft({...draft,start:event.target.value})}/></label>
        <label>End (India time)<input type="datetime-local" value={draft.end} onChange={event=>setDraft({...draft,end:event.target.value})}/></label>
      </div>
      <Button variant="secondary" disabled={busy||!data?.targets||reason.trim().length<8||!draft.start||!draft.end||!Number.isInteger(Number(draft.goal))||Number(draft.goal)<1||!Number.isInteger(Number(draft.budget))||Number(draft.budget)<1} onClick={()=>void createTarget()}>Save voice campaign draft</Button>
      <p>Drafts authorize no discounts or free upgrades. Activation uses the existing sales-target approval and calling controls.</p>
      {notice && <TeamAlert tone="info">{notice}</TeamAlert>}
      <TeamTable head={["Target", "Service", "Progress", "Daily contact budget", "Status", "Pause", "Activate"]} rows={(data?.targets ?? []).map(target => [
        target.target_type, target.service_code || "All services", `${target.achieved_count} / ${target.daily_goal}`, target.max_contacts_per_day,
        <Badge key={target.id} tone={target.status === "active" ? "success" : "neutral"}>{target.status}</Badge>,
        <Button key={target.id} variant="secondary" size="sm" disabled={busy || reason.trim().length < 8 || !["active", "approved"].includes(target.status)} onClick={() => void changeTarget("pause", target.id)}>Pause target</Button>,
        <Button key={`activate-${target.id}`} variant="secondary" size="sm" disabled={busy||reason.trim().length<8||!["draft","paused","approved"].includes(target.status)} onClick={()=>void changeTarget("activate",target.id)}>Activate target</Button>,
      ])} empty={data?.targets ? "No sales targets configured." : "Sales targets are unavailable for this session."} />
    </TeamSection>
  </>;
}
