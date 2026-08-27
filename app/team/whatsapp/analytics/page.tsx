"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, EmptyState } from "../../../components/ui";
import OpsShell from "../../../components/ops-shell/OpsShell";
import teamStyles from "../../team-console.module.css";

type Row = Record<string, unknown>;
type Report = {
  from?: number;
  to?: number;
  liveAdMutation?: boolean;
  whatsapp?: { funnel?: Record<string, number>; firstResponse?: { averageMs?: number | null }; resolutionSla?: { averageMs?: number | null }; templateFunnel?: { messageStatus?: Row[]; deliveryEvents?: Row[] } };
  automation?: { aiTurns?: number; aiHandoffs?: number; aiContainmentRate?: number | null; chatbotTurns?: number; chatbotHandoffs?: number; chatbotQualifiedThreads?: number; humanHandoffs?: number };
  people?: { byAssignee?: Row[]; byQueueTeam?: Row[] };
  consent?: { optOuts?: number; whatsappSuppressed?: number; marketingSuppressed?: number };
  conversion?: { leadAttributedBookings?: number; leadAttributedRevenue?: number };
  feedback?: { byPlatformStatus?: Row[] };
  sources?: Row[];
};

const day = 24 * 60 * 60_000;
const dateInput = (value: number) => new Date(value).toISOString().slice(0, 10);
const number = (value: unknown) => Number(value || 0).toLocaleString("en-IN");
const duration = (value: unknown) => value == null ? "—" : `${Math.round(Number(value) / 1000)} sec`;
const percent = (value: unknown) => value == null ? "—" : `${(Number(value) * 100).toFixed(1)}%`;
const money = (value: unknown) => `₹${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export default function WhatsAppAnalyticsPage() {
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const now = Date.now();
      setFromDate(dateInput(now - 30 * day));
      setToDate(dateInput(now));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const range = useMemo(() => {
    if (!fromDate || !toDate) return null;
    const from = Date.parse(`${fromDate}T00:00:00.000Z`);
    const to = Date.parse(`${toDate}T23:59:59.999Z`);
    return { from, to };
  }, [fromDate, toDate]);

  const load = useCallback(async () => {
    if (!range) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/whatsapp/analytics?from=${range.from}&to=${range.to}`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({})) as { data?: Report; error?: string };
      if (!response.ok) throw new Error(payload.error || `Unable to load WhatsApp analytics (HTTP ${response.status})`);
      setReport(payload.data || null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }, [range]);

  useEffect(() => { if (!range) return; const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load, range]);

  const funnel = report?.whatsapp?.funnel || {};
  const assignees = report?.people?.byAssignee || [];
  const queues = report?.people?.byQueueTeam || [];
  const feedback = report?.feedback?.byPlatformStatus || [];
  const sources = report?.sources || [];
  const exportUrl = range ? `/api/whatsapp/analytics?from=${range.from}&to=${range.to}&export=csv` : "";

  return <OpsShell eyebrow="PawSpace team · WhatsApp" title="WhatsApp / Marketing Analytics" description="Canonical WhatsApp funnel, automation containment, SLA, consent suppression, source attribution and simulator conversion-feedback reconciliation. No live ad-account mutation is enabled." actions={<><Badge tone="info">Canonical metrics</Badge><Badge tone="warning">Live ad mutation disabled</Badge></>}>
    {error ? <div className={`${teamStyles.panel} ${teamStyles.panelError}`}><b>{error}</b></div> : null}
    <section className={teamStyles.panel}>
      <div className={teamStyles.panelHead}><h2>Date range & governed export</h2><span>reports.view</span></div>
      <div className={teamStyles.fieldRow}>
        <label className={teamStyles.field}>From<input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label>
        <label className={teamStyles.field}>To<input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /></label>
      </div>
      <div className={teamStyles.actions}><Button type="button" disabled={busy || !range} onClick={() => { void load(); }}>{busy ? "Refreshing…" : "Refresh report"}</Button><Button type="button" variant="secondary" disabled={busy || !range} onClick={() => { if (exportUrl) window.location.assign(exportUrl); }}>Export CSV</Button></div>
    </section>
    {!report ? <EmptyState title="No analytics loaded." body="Choose a date range and refresh the report." /> : <>
      <section className={teamStyles.panel}><div className={teamStyles.panelHead}><h2>WhatsApp funnel & SLA</h2><span>canonical messages</span></div><div className={teamStyles.grid}>
        <div><b>Inbound</b><p>{number(funnel.inboundMessages)}</p></div><div><b>Outbound</b><p>{number(funnel.outboundMessages)}</p></div><div><b>Delivered events</b><p>{number(funnel.deliveredEvents)}</p></div><div><b>Read events</b><p>{number(funnel.readEvents)}</p></div><div><b>First response</b><p>{duration(report.whatsapp?.firstResponse?.averageMs)}</p></div><div><b>Resolution SLA</b><p>{duration(report.whatsapp?.resolutionSla?.averageMs)}</p></div>
      </div></section>
      <section className={teamStyles.panel}><div className={teamStyles.panelHead}><h2>Bot, AI & human handoff</h2><span>governed automation</span></div><div className={teamStyles.grid}>
        <div><b>AI turns</b><p>{number(report.automation?.aiTurns)}</p></div><div><b>AI containment</b><p>{percent(report.automation?.aiContainmentRate)}</p></div><div><b>AI handoffs</b><p>{number(report.automation?.aiHandoffs)}</p></div><div><b>Chatbot turns</b><p>{number(report.automation?.chatbotTurns)}</p></div><div><b>Qualified by chatbot</b><p>{number(report.automation?.chatbotQualifiedThreads)}</p></div><div><b>Total governed handoffs</b><p>{number(report.automation?.humanHandoffs)}</p></div>
      </div></section>
      <section className={teamStyles.panel}><div className={teamStyles.panelHead}><h2>Consent & conversion</h2><span>canonical attribution</span></div><div className={teamStyles.grid}>
        <div><b>Opt-outs</b><p>{number(report.consent?.optOuts)}</p></div><div><b>WhatsApp suppressed</b><p>{number(report.consent?.whatsappSuppressed)}</p></div><div><b>Marketing suppressed</b><p>{number(report.consent?.marketingSuppressed)}</p></div><div><b>Attributed bookings</b><p>{number(report.conversion?.leadAttributedBookings)}</p></div><div><b>Attributed revenue</b><p>{money(report.conversion?.leadAttributedRevenue)}</p></div>
      </div></section>
      <section className={teamStyles.panel}><div className={teamStyles.panelHead}><h2>Queue / agent performance</h2><span>{assignees.length} agents · {queues.length} queue/team rows</span></div><div className={teamStyles.tableWrap}><table className={teamStyles.table}><thead><tr><th>Agent</th><th>Assignments</th><th>Average ownership</th></tr></thead><tbody>{assignees.map((row, index) => <tr key={`${String(row.assignee)}-${index}`}><td>{String(row.assignee || "Unassigned")}</td><td>{number(row.assignments)}</td><td>{duration(row.averageOwnershipMs)}</td></tr>)}</tbody></table></div></section>
      <section className={teamStyles.panel}><div className={teamStyles.panelHead}><h2>Source & feedback reconciliation</h2><span>simulator only</span></div><div className={teamStyles.tableWrap}><table className={teamStyles.table}><thead><tr><th>Source / platform</th><th>Campaign / status</th><th>Leads / rows</th><th>Attempts</th></tr></thead><tbody>{sources.map((row, index) => <tr key={`source-${index}`}><td>{String(row.source_platform || "—")}</td><td>{String(row.campaign_id || row.utm_campaign || "—")}</td><td>{number(row.leads)}</td><td>—</td></tr>)}{feedback.map((row, index) => <tr key={`feedback-${index}`}><td>{String(row.platform || "—")}</td><td>{String(row.status || "—")}</td><td>{number(row.count)}</td><td>{number(row.attempts)}</td></tr>)}</tbody></table></div></section>
    </>}
    <p className={teamStyles.footnote}>Template delivery status is reconciled from canonical WhatsApp message and delivery-event rows. CSV export uses the same date range and the same <code>reports.view</code> authorization gate as this screen.</p>
  </OpsShell>;
}
