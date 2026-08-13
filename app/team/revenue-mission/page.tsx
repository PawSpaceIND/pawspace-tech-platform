"use client";

import { useEffect, useState } from "react";
import { Badge, StatCard, TeamAlert, TeamFigures, TeamSection, TeamShell, TeamStatGrid, TeamTable } from "../../components/ui";

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
  mission?: { name?: string; revenueBasis?: string; periodStart?: string; periodEnd?: string; cityId?: string };
  revenue?: { target?: number; achieved?: number; gap?: number; booked?: number; collected?: number; refunded?: number; netCollected?: number };
  pipeline?: { weightedPipeline?: number; unweightedPipeline?: number; ready?: number; suppressed?: number; reviewRequired?: number };
  leadQueue?: { currentAssignments?: number; unassigned?: number; unacknowledged?: number; slaBreached?: number; managerEscalationDue?: number; reassignmentDue?: number };
  warnings?: Warning[];
};

const money = (value: unknown) => `₹${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
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
  const attained = target > 0 ? Math.round((achieved / target) * 100) : null;
  const blockers = warnings.filter((item) => item.severity === "critical").length;

  return (
    <TeamShell
      eyebrow="PAWSPACE TEAM · REVENUE MISSION CONTROL · UAT ONLY"
      title={data?.mission?.name || "Revenue Mission Command Center"}
      description="Target versus what the platform can actually prove was collected, the pipeline that has not converted yet, and the lead-execution queue behind both. UAT only — production readiness is reported, never assumed."
      nav={NAV}
      status={<>{error && <TeamAlert>{error}</TeamAlert>}<TeamAlert tone="info">Production ready: NO — this command centre reports UAT state, and every warning below is a real blocker rather than a placeholder.</TeamAlert></>}
    >
      <TeamStatGrid>
        <StatCard label="Target" value={loading && !data ? "…" : money(revenue?.target)} meta={data?.mission?.cityId ? `city ${data.mission.cityId}` : "mission target"} />
        <StatCard label="Achieved" value={loading && !data ? "…" : money(revenue?.achieved)} meta={attained == null ? `basis ${data?.mission?.revenueBasis || "—"}` : `${attained}% of target · basis ${data?.mission?.revenueBasis || "—"}`} trend={attained != null && attained >= 100 ? "up" : "none"} />
        <StatCard label="Gap to target" value={loading && !data ? "…" : money(revenue?.gap)} meta={Number(revenue?.gap || 0) > 0 ? "still to close" : "target met"} trend={Number(revenue?.gap || 0) > 0 ? "down" : "up"} />
        <StatCard label="Critical blockers" value={data ? blockers : "—"} meta={blockers > 0 ? "must be resolved before the mission is trustworthy" : "no critical blockers"} trend={blockers > 0 ? "down" : "up"} />
      </TeamStatGrid>

      <TeamSection title="Revenue truth" note="Achieved counts only what the payment records prove. Booked is what was sold; net collected is booked less refunds.">
        <TeamFigures items={[
          { label: "Booked", value: money(revenue?.booked) },
          { label: "Collected", value: money(revenue?.collected), tone: "good" },
          { label: "Refunded", value: money(revenue?.refunded), tone: Number(revenue?.refunded || 0) > 0 ? "bad" : "default" },
          { label: "Net collected", value: money(revenue?.netCollected), tone: "good" },
        ]} />
      </TeamSection>

      <TeamSection title="Pipeline — not achieved revenue" note="Weighted applies each opportunity's own probability; suppressed and review-required rows are excluded from any target claim.">
        <TeamFigures items={[
          { label: "Weighted", value: money(pipeline?.weightedPipeline) },
          { label: "Unweighted", value: money(pipeline?.unweightedPipeline) },
          { label: "Ready", value: pipeline?.ready ?? 0 },
          { label: "Suppressed", value: pipeline?.suppressed ?? 0 },
          { label: "Review required", value: pipeline?.reviewRequired ?? 0 },
        ]} />
      </TeamSection>

      <TeamSection title="Lead execution" note="The queue behind the pipeline. An SLA breach or an unacknowledged assignment is why revenue stalls before it reaches the pipeline at all.">
        <TeamFigures items={[
          { label: "Current assignments", value: queue?.currentAssignments ?? 0 },
          { label: "Unassigned", value: queue?.unassigned ?? 0, tone: Number(queue?.unassigned || 0) > 0 ? "bad" : "default" },
          { label: "Unacknowledged", value: queue?.unacknowledged ?? 0, tone: Number(queue?.unacknowledged || 0) > 0 ? "bad" : "default" },
          { label: "SLA breached", value: queue?.slaBreached ?? 0, tone: Number(queue?.slaBreached || 0) > 0 ? "bad" : "default" },
          { label: "Manager escalation due", value: queue?.managerEscalationDue ?? 0 },
          { label: "Reassignment due", value: queue?.reassignmentDue ?? 0 },
        ]} />
      </TeamSection>

      <TeamSection title="Warnings & blockers" note="Ranked by severity. A critical entry means the mission figures above cannot yet be relied on.">
        <TeamTable
          head={["Severity", "What is wrong", "Code"]}
          rows={warnings.map((item) => [<Badge key={item.code} tone={TONE[item.severity] || "neutral"}>{item.severity.toUpperCase()}</Badge>, item.message, <code key={`${item.code}-code`}>{item.code}</code>])}
          empty={loading ? "Loading…" : "No current command-centre warnings — every governing policy the mission depends on is in place."}
        />
      </TeamSection>
    </TeamShell>
  );
}
