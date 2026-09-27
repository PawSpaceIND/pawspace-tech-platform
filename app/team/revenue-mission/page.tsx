"use client";

import { useEffect, useState } from "react";
import { MetricBars, TargetProgress, VisualGrid, reportDate } from "../../components/ui/ReportVisuals";
import TrendChart from "../../components/ui/TrendChart";
import { Badge, StatCard, TeamAlert, TeamSection, TeamShell, TeamStatGrid, TeamTable } from "../../components/ui";

/**
 * Revenue Mission Command Center.
 *
 * This page previously rendered as raw browser-default text — no shell, no cards, no navigation, no
 * loading or empty state — because it used no styling at all. Every number it shows was already
 * real; only the presentation was missing. It now uses the shared Team shell, so it looks and
 * behaves like the rest of the workspace, and the warnings the API returns are ranked by severity
 * instead of listed flat.
 */

type Warning = { severity: string; code: string; message: string };
type Command = {
  status?: string;
  generatedAt?: number;
  breakdowns?: { service: { serviceCode: string; booked: number; collected: number; refunded: number; netCollected: number }[]; city: { cityId: string; booked: number; collected: number; refunded: number; netCollected: number }[] };
  mission?: { name?: string; revenueBasis?: string; periodStart?: number; periodEnd?: number; cityId?: string };
  revenue?: { target?: number; achieved?: number; gap?: number; booked?: number; collected?: number; refunded?: number; netCollected?: number; elapsedPercent?: number; paceTarget?: number; paceVariance?: number };
  pipeline?: { weightedPipeline?: number; unweightedPipeline?: number; ready?: number; suppressed?: number; reviewRequired?: number };
  leadQueue?: { currentAssignments?: number; unassigned?: number; unacknowledged?: number; slaBreached?: number; managerEscalationDue?: number; reassignmentDue?: number };
  warnings?: Warning[];
};

const money = (value: unknown) => value == null ? "—" : `₹${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 };
const TONE: Record<string, "danger" | "warning" | "info"> = { critical: "danger", warning: "warning", info: "info" };

const NAV = [
  { href: "/team/daily-revenue", label: "Daily revenue" },
  { href: "/team/sales", label: "Sales & CRM" },
  { href: "/team", label: "Team home", primary: true },
];

export default function RevenueMissionPage() {
  const [data, setData] = useState<Command | null>(null);
  const [error, setError] = useState("");
  // Derived rather than set inside the effect — see the note in the AI analytics page: a synchronous
  // setState in an effect causes cascading renders and is rejected by the React compiler.
  const [settled, setSettled] = useState(false);
  const loading = !settled;

  useEffect(() => {
    let live = true;
    void fetch("/api/revenue-mission-command-center", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as Command & { error?: string };
        if (!response.ok) throw new Error(payload.error || `Revenue Mission failed to load (HTTP ${response.status})`);
        if (live) setData(payload);
      })
      .catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : "Unable to load Revenue Mission Command Center"); })
      .finally(() => { if (live) setSettled(true); });
    return () => { live = false; };
  }, []);

  const revenue = data?.revenue, pipeline = data?.pipeline, queue = data?.leadQueue;
  const warnings = [...(data?.warnings || [])].sort((a, b) => (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3));
  const target = Number(revenue?.target || 0), achieved = Number(revenue?.achieved || 0);
  const attained = target > 0 ? (achieved / target) * 100 : null;
  const blockers = warnings.filter((item) => item.severity === "critical").length;

  return (
    <TeamShell
      eyebrow="PAWSPACE TEAM · REVENUE MISSION CONTROL · UAT ONLY"
      title={data?.mission?.name || "Revenue Mission Command Center"}
      description="Target versus what the platform can actually prove was collected, the pipeline that has not converted yet, and the lead-execution queue behind both. UAT only — production readiness is reported, never assumed."
      nav={NAV}
      status={<>{error && <TeamAlert>{error}</TeamAlert>}<TeamAlert tone="info">Production ready: NO — this command centre reports UAT state, and every warning below is a real blocker rather than a placeholder.</TeamAlert></>}
    >
      {data?.mission && <>
        <p>Mission period: <strong>{reportDate(data.mission.periodStart)} – {reportDate(data.mission.periodEnd)}</strong> · IST · Report as of {reportDate(data.generatedAt)}</p>
        <VisualGrid>
          <TargetProgress title="Mission achievement" percent={attained} note={`${money(achieved)} of ${money(target)} · ${data.mission.revenueBasis?.replaceAll("_", " ") || "mission basis"}`} />
          <MetricBars title="Achievement against time elapsed" note="Straight-line pace is a planning reference, not a revenue forecast." format={money} items={[
            { label: "Achieved", value: revenue?.achieved },
            { label: `Pace reference · ${revenue?.elapsedPercent ?? "—"}% of period elapsed`, value: revenue?.paceTarget, tone: "gold" },
            { label: "Mission target", value: revenue?.target, tone: "gold" },
          ]} />
        </VisualGrid>
      </>}
      <TeamStatGrid>
        <StatCard label="Target" value={loading && !data ? "…" : money(revenue?.target)} meta={data?.mission?.cityId ? `city ${data.mission.cityId}` : "mission target"} />
        <StatCard label="Achieved" value={loading && !data ? "…" : money(revenue?.achieved)} meta={attained == null ? `basis ${data?.mission?.revenueBasis || "—"}` : `${attained.toFixed(1)}% of target · basis ${data?.mission?.revenueBasis || "—"}`} trend={attained != null && attained >= 100 ? "up" : "none"} />
        <StatCard label="Gap to target" value={loading && !data ? "…" : money(revenue?.gap)} meta={Number(revenue?.gap || 0) > 0 ? "still to close" : "target met"} trend={Number(revenue?.gap || 0) > 0 ? "down" : "up"} />
        <StatCard label="Critical blockers" value={data ? blockers : "—"} meta={blockers > 0 ? "must be resolved before the mission is trustworthy" : "no critical blockers"} trend={blockers > 0 ? "down" : "up"} />
      </TeamStatGrid>

      {revenue && <MetricBars title="From booked to net collected" note="Booked is sold value; net collected is collections minus refunds. These ledger amounts must not be added together." format={money} items={[
        { label: "Booked", value: revenue.booked, tone: "gold" }, { label: "Collected", value: revenue.collected },
        { label: "Refunded", value: revenue.refunded, tone: "warning" }, { label: "Net collected", value: revenue.netCollected },
      ]} />}
      {data?.breakdowns && <VisualGrid>
        <TeamSection title="Revenue by service" note="Mission totals · INR · collected and net collected may overlap exactly when there are no refunds.">
          <TrendChart type="bar" xKey="service" data={data.breakdowns.service.map(row => ({ ...row, service: row.serviceCode.replaceAll("_", " ") }))} series={[{ key: "booked", label: "Booked" }, { key: "collected", label: "Collected" }, { key: "netCollected", label: "Net collected" }]} valueFormatter={money} />
        </TeamSection>
        <MetricBars title="Net collected by city" note="Revenue attributed to each city in this mission." format={money} items={data.breakdowns.city.map(row => ({ label: row.cityId || "Unattributed", value: row.netCollected }))} />
      </VisualGrid>}

      {pipeline && <VisualGrid>
        <MetricBars title="Pipeline value" note="Potential value only; review-required opportunities are included in this pipeline." format={money} items={[{ label: "Unweighted", value: pipeline.unweightedPipeline, tone: "gold" }, { label: "Probability weighted", value: pipeline.weightedPipeline }]} />
        <MetricBars title="Opportunity status" note="Counts of opportunities, separate from revenue." items={[{ label: "Ready", value: pipeline.ready }, { label: "Review required", value: pipeline.reviewRequired, tone: "gold" }, { label: "Suppressed", value: pipeline.suppressed, tone: "warning" }]} />
      </VisualGrid>}

      {queue && <MetricBars title="Lead execution pressure" note="Current queue snapshot. Status counts can overlap; they are not a conversion funnel." items={[
        { label: "Current assignments", value: queue.currentAssignments }, { label: "Unassigned", value: queue.unassigned, tone: "warning" },
        { label: "Unacknowledged", value: queue.unacknowledged, tone: "gold" }, { label: "SLA breached", value: queue.slaBreached, tone: "warning" },
        { label: "Manager escalation due", value: queue.managerEscalationDue, tone: "warning" }, { label: "Reassignment due", value: queue.reassignmentDue, tone: "gold" },
      ]} />}

      <TeamSection title="Warnings & blockers" note="Ranked by severity. A critical entry means the mission figures above cannot yet be relied on.">
        <TeamTable
          head={["Severity", "What is wrong", "Code"]}
          rows={warnings.map((item) => [<Badge key={item.code} tone={TONE[item.severity] || "neutral"}>{item.severity.toUpperCase()}</Badge>, item.message, <code key={`${item.code}-code`}>{item.code}</code>])}
          empty={loading ? "Loading…" : error ? "Warnings unavailable while the report cannot be loaded." : "No current command-centre warnings — every governing policy the mission depends on is in place."}
        />
      </TeamSection>
    </TeamShell>
  );
}
