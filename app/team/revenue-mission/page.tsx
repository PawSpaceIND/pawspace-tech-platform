"use client";

import { useEffect, useState } from "react";
import { Badge, StatCard } from "../../components/ui";
import OpsShell from "../../components/ops-shell/OpsShell";
import styles from "../team-console.module.css";

/**
 * Revenue Mission Command Center.
 *
 * This page used to render as raw browser-default text — no shell, no cards, no navigation, no
 * loading or empty state — because it used no styling at all. Every number it shows was already real;
 * only the presentation was missing.
 *
 * It renders inside OpsShell on team-console.module.css: the same chrome and content vocabulary as
 * every other internal console, so a staff member moving between screens stays in one product. An
 * earlier version of this fix shipped its own shell, which was consolidated away once OpsShell — with
 * a persistent sidebar marking the active route, which the other never had — became the established
 * pattern across nine consoles.
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

export default function RevenueMissionPage() {
  const [data, setData] = useState<Command | null>(null);
  const [error, setError] = useState("");
  // Derived rather than set inside the effect: a synchronous setState in an effect causes cascading
  // renders and is rejected by the React compiler.
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
  const show = (value: unknown) => loading && !data ? "…" : money(value);

  /** A labelled row of figures, in the console's own tile vocabulary. */
  const figures = (items: Array<[string, string | number, string?]>) => (
    <section className={styles.tiles}>
      {items.map(([label, value, meta]) => <StatCard key={label} label={label} value={value} meta={meta} />)}
    </section>
  );

  return (
    <OpsShell
      eyebrow="PAWSPACE · REVENUE MISSION CONTROL · UAT ONLY"
      title={data?.mission?.name || "Revenue Mission Command Center"}
      description="Target versus what the platform can actually prove was collected, the pipeline that has not converted yet, and the lead-execution queue behind both. UAT only — production readiness is reported, never assumed."
      actions={<Badge tone={blockers ? "danger" : "success"} dot>{blockers} critical blocker{blockers === 1 ? "" : "s"}</Badge>}
    >
      {error ? <div className={`${styles.panel} ${styles.panelError}`}><b>{error}</b></div> : null}

      <section className={styles.tiles}>
        <StatCard label="Target" value={show(revenue?.target)} meta={data?.mission?.cityId ? `city ${data.mission.cityId}` : "mission target"} />
        <StatCard label="Achieved" value={show(revenue?.achieved)} meta={attained == null ? `basis ${data?.mission?.revenueBasis || "—"}` : `${attained}% of target · basis ${data?.mission?.revenueBasis || "—"}`} trend={attained != null && attained >= 100 ? "up" : "none"} />
        <StatCard label="Gap to target" value={show(revenue?.gap)} meta={Number(revenue?.gap || 0) > 0 ? "still to close" : "target met"} trend={Number(revenue?.gap || 0) > 0 ? "down" : "up"} />
        <StatCard label="Critical blockers" value={data ? blockers : "—"} meta={blockers > 0 ? "resolve before relying on the figures" : "no critical blockers"} trend={blockers > 0 ? "down" : "up"} />
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHead}><h2>Revenue truth</h2></div>
        <p className={styles.panelNote}>Achieved counts only what the payment records prove. Booked is what was sold; net collected is booked less refunds.</p>
        {figures([["Booked", show(revenue?.booked)], ["Collected", show(revenue?.collected)], ["Refunded", show(revenue?.refunded)], ["Net collected", show(revenue?.netCollected)]])}
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHead}><h2>Pipeline — not achieved revenue</h2></div>
        <p className={styles.panelNote}>Weighted applies each opportunity&apos;s own probability; suppressed and review-required rows are excluded from any target claim.</p>
        {figures([["Weighted", show(pipeline?.weightedPipeline)], ["Unweighted", show(pipeline?.unweightedPipeline)], ["Ready", pipeline?.ready ?? 0], ["Suppressed", pipeline?.suppressed ?? 0], ["Review required", pipeline?.reviewRequired ?? 0]])}
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHead}><h2>Lead execution</h2></div>
        <p className={styles.panelNote}>The queue behind the pipeline. An SLA breach or an unacknowledged assignment is why revenue stalls before it reaches the pipeline at all.</p>
        {figures([
          ["Current assignments", queue?.currentAssignments ?? 0],
          ["Unassigned", queue?.unassigned ?? 0],
          ["Unacknowledged", queue?.unacknowledged ?? 0],
          ["SLA breached", queue?.slaBreached ?? 0],
          ["Manager escalation due", queue?.managerEscalationDue ?? 0],
          ["Reassignment due", queue?.reassignmentDue ?? 0],
        ])}
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHead}><h2>Warnings &amp; blockers</h2></div>
        <p className={styles.panelNote}>Ranked by severity. A critical entry means the figures above cannot yet be relied on.</p>
        {warnings.length === 0
          ? <p className={styles.muted}>{loading ? "Loading…" : "No current command-centre warnings — every governing policy the mission depends on is in place."}</p>
          : <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead><tr><th>Severity</th><th>What is wrong</th><th>Code</th></tr></thead>
                <tbody>{warnings.map((item) => <tr key={item.code}><td><Badge tone={TONE[item.severity] || "neutral"}>{item.severity.toUpperCase()}</Badge></td><td>{item.message}</td><td><code>{item.code}</code></td></tr>)}</tbody>
              </table>
            </div>}
      </section>

      <p className={styles.footnote}>Production ready: NO — this command centre reports UAT state, and every warning above is a real blocker rather than a placeholder.</p>
    </OpsShell>
  );
}
