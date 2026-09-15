/**
 * What the background scheduler is ACTUALLY doing in this deployment, read from a table.
 *
 * Two screens used to state scheduler facts they did not measure, and both were wrong at the same
 * time on the same deployment:
 *
 *   /team/operations/work-queue  "Swept automatically by worker.scheduled every five minutes", read from
 *                                WORK_QUEUE_SCHEDULER = {configured:true,...}, a compile-time
 *                                constant. A runtime audit created a relocation enquiry at 09:07:09Z
 *                                and watched 09:10 and 09:15 pass with nothing created; a manual
 *                                sweep at 09:18 created it. Nothing sweeps that deployment -
 *                                wrangler.e2e.toml declares no [triggers] at all.
 *
 *   /team/alerts                 "Background scheduler: not configured yet.", a literal in the page,
 *                                printed directly underneath a /api/staff-alerts response whose own
 *                                truth block said backgroundSchedulerConfigured:true.
 *
 * An earlier fix replaced a hardcoded FALSE claim with a hardcoded TRUE one. Neither measured
 * anything, so neither could be right for longer than a deploy. This module measures.
 *
 * WHY `background_scheduler_runs` IS EVIDENCE. Rows in it are written by exactly one function,
 * runBackgroundScheduler, called from exactly one place, worker/index.ts `scheduled()`. Nothing in
 * the app, no route and no manual sweep writes that table - a manual work-queue sweep calls
 * sweepWorkQueue directly and leaves no row here. So a row is proof that a cron trigger fired
 * against this database, and no row is proof that none ever has.
 */

type Db = D1Database;
type Row = Record<string, unknown>;

export const SCHEDULER_CRON = "*/5 * * * *";
export const SCHEDULER_RUNNER = "worker.scheduled";
export const SCHEDULER_PERIOD_MS = 5 * 60_000;
/** How stale the newest recorded run may be before the schedule is reported as not running. */
export const SCHEDULER_STALE_AFTER_MS = 3 * SCHEDULER_PERIOD_MS;

export type SchedulerObservation = {
  cron: string;
  runner: string;
  /** Kept for existing callers. It is now OBSERVED: true only when a scheduled run was recorded. */
  configured: boolean;
  /** True when this database has ever recorded a scheduled run. */
  everRan: boolean;
  /** True when the newest recorded run is recent enough that the cron is plainly still firing. */
  running: boolean;
  runCount: number;
  lastRunAt: number | null;
  lastRunStatus: string | null;
  lastRun: Row | null;
  pageLoadRequired: boolean;
  /** One sentence for an operator, describing only what was measured. */
  summary: string;
};

const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());

function describe(observation: Omit<SchedulerObservation, "summary">, now: number): string {
  if (!observation.everRan) {
    return `Not swept automatically here: no ${SCHEDULER_RUNNER} run has ever been recorded against this deployment, on ${SCHEDULER_CRON} or any other schedule. Work appears only when someone presses Sweep now. If that is not expected, this Worker has no [triggers] cron deployed.`;
  }
  const ageMinutes = observation.lastRunAt === null ? null : Math.max(0, Math.round((now - observation.lastRunAt) / 60_000));
  if (!observation.running) {
    return `Automatic sweeps have STOPPED. The newest recorded ${SCHEDULER_RUNNER} run is ${iso(observation.lastRunAt)} (${ageMinutes} minutes ago, status ${observation.lastRunStatus ?? "unknown"}) against a ${SCHEDULER_CRON} schedule. ${observation.runCount} run(s) recorded in total. Use Sweep now until the cron is restored.`;
  }
  return `Swept automatically by ${SCHEDULER_RUNNER} on ${SCHEDULER_CRON}. Last observed run ${iso(observation.lastRunAt)} (${ageMinutes} minutes ago, status ${observation.lastRunStatus}); ${observation.runCount} run(s) recorded.`;
}

async function tableExists(db: Db, name: string) {
  try {
    return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>());
  } catch {
    return false;
  }
}

/**
 * Read the scheduler's observed state. Never creates the table: a cold database that has never run
 * the scheduler must report exactly that, not be quietly given somewhere to record it later.
 */
export async function observeBackgroundScheduler(db: Db, input: { now?: number } = {}): Promise<SchedulerObservation> {
  const now = input.now ?? Date.now();
  const base = { cron: SCHEDULER_CRON, runner: SCHEDULER_RUNNER, pageLoadRequired: false };
  if (!(await tableExists(db, "background_scheduler_runs"))) {
    const empty = { ...base, configured: false, everRan: false, running: false, runCount: 0, lastRunAt: null, lastRunStatus: null, lastRun: null };
    return { ...empty, summary: describe(empty, now) };
  }
  const [latest, counted] = await Promise.all([
    db.prepare("SELECT * FROM background_scheduler_runs ORDER BY scheduled_at DESC LIMIT 1").first<Row>(),
    db.prepare("SELECT COUNT(*) count FROM background_scheduler_runs").first<Row>(),
  ]);
  const runCount = Number(counted?.count || 0);
  const lastRunAt = latest ? Number(latest.scheduled_at) : null;
  const everRan = runCount > 0 && lastRunAt !== null && Number.isFinite(lastRunAt);
  const running = everRan && now - (lastRunAt as number) <= SCHEDULER_STALE_AFTER_MS;
  const observation = {
    ...base,
    configured: everRan,
    everRan,
    running,
    runCount,
    lastRunAt: everRan ? (lastRunAt as number) : null,
    lastRunStatus: latest ? String(latest.status || "") || null : null,
    lastRun: latest || null,
  };
  return { ...observation, summary: describe(observation, now) };
}

/** The observation to report when the database is too cold to read - it has certainly never swept. */
export function unobservedScheduler(now = Date.now()): SchedulerObservation {
  const empty = { cron: SCHEDULER_CRON, runner: SCHEDULER_RUNNER, pageLoadRequired: false, configured: false, everRan: false, running: false, runCount: 0, lastRunAt: null, lastRunStatus: null, lastRun: null };
  return { ...empty, summary: describe(empty, now) };
}
