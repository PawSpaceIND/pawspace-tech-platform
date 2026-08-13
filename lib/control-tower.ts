/**
 * Control Tower — the real data behind /control.
 *
 * The landing screen previously rendered invented governance numbers: "Audited areas 14",
 * "Verified requirements 84", "P0 release blockers 5", five hand-written "needs attention" rows and
 * six assurance bars at 86–97%. None of it touched the database. An owner reading it was reading a
 * mock-up of their own company, and every number on it was unfalsifiable.
 *
 * Everything here is counted from governance tables that already exist. Two rules:
 *
 *  1. A number is only produced when its table exists and its meaning is exact. Where there is no
 *     source, the field is `null` and `sourceStatus` says `not_connected` — the screen must be able
 *     to show "not connected" rather than a plausible percentage.
 *  2. A posture percentage must be a ratio of two things we actually counted, with both halves
 *     returned alongside it. A bare "88%" that nobody can reproduce is indistinguishable from the
 *     invented one it replaced.
 */

import { caseSlaCoverageGaps } from "./case-sla-defaults";

type Db = D1Database;
type Row = Record<string, unknown>;

const text = (value: unknown) => String(value ?? "").trim();
const count = (row: Row | null | undefined, key = "count") => Number(row?.[key] || 0);

async function tableExists(db: Db, name: string) {
  const row = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>();
  return Boolean(row);
}
/** Runs a scalar count, returning null when the table has not been created yet. */
async function tally(db: Db, table: string, sql: string, binds: unknown[] = []) {
  if (!await tableExists(db, table)) return null;
  const row = await db.prepare(sql).bind(...binds).first<Row>();
  return count(row);
}

export type ControlSignal = {
  code: string;
  severity: "critical" | "attention" | "clear";
  label: string;
  detail: string;
  count: number;
  view: string;
};
export type PostureArea = {
  code: string;
  label: string;
  /** Percentage, or null when the source table does not exist yet. */
  score: number | null;
  /** Both halves of the ratio, so the score can be checked rather than believed. */
  good: number | null;
  total: number | null;
  basis: string;
};

const percent = (good: number | null, total: number | null) =>
  good === null || total === null ? null : total === 0 ? 100 : Math.round((good / total) * 100);

export async function buildControlTower(db: Db, input: { asOf?: number } = {}) {
  const asOf = input.asOf ?? Date.now();
  const today = new Date(asOf).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

  // ---- Signals: things a human has to act on, counted exactly. -------------------------------
  const casesBreaching = await tally(db, "unified_cases",
    "SELECT COUNT(*) count FROM unified_cases WHERE status NOT IN ('resolved','closed') AND resolution_due_at IS NOT NULL AND resolution_due_at<=?", [asOf]);
  const casesOpen = await tally(db, "unified_cases",
    "SELECT COUNT(*) count FROM unified_cases WHERE status NOT IN ('resolved','closed')");
  const queueEscalated = await tally(db, "ops_work_queue_tasks",
    "SELECT COUNT(*) count FROM ops_work_queue_tasks WHERE status='open' AND escalated=1");
  const queueOpen = await tally(db, "ops_work_queue_tasks",
    "SELECT COUNT(*) count FROM ops_work_queue_tasks WHERE status='open'");
  const reconciliationOpen = await tally(db, "payment_reconciliation_exceptions",
    "SELECT COUNT(*) count FROM payment_reconciliation_exceptions WHERE status='open'");
  const reconciliationTotal = await tally(db, "payment_reconciliation_exceptions",
    "SELECT COUNT(*) count FROM payment_reconciliation_exceptions");
  const statutoryOverdue = await tally(db, "statutory_filings",
    "SELECT COUNT(*) count FROM statutory_filings WHERE status!='filed' AND due_date<?", [today]);
  const statutoryDue = await tally(db, "statutory_filings", "SELECT COUNT(*) count FROM statutory_filings");
  const statutoryFiled = await tally(db, "statutory_filings", "SELECT COUNT(*) count FROM statutory_filings WHERE status='filed'");
  const alertsOverdue = await tally(db, "staff_alerts",
    "SELECT COUNT(*) count FROM staff_alerts WHERE status='open' AND due_at<=?", [asOf]);
  const onboardingWaiting = await tally(db, "provider_onboarding_applications",
    "SELECT COUNT(*) count FROM provider_onboarding_applications WHERE human_decision IS NULL AND status NOT IN ('rejected','withdrawn')");
  const onboardingTotal = await tally(db, "provider_onboarding_applications", "SELECT COUNT(*) count FROM provider_onboarding_applications");
  // Bot calls that CLAIMED a conversion or a payment. The bot may never write to a money table, so a
  // human has to confirm each one — an unreconciled claim is revenue nobody has verified.
  const botClaims = await tally(db, "bot_call_dispositions",
    "SELECT COUNT(*) count FROM bot_call_dispositions WHERE reconciliation_status='pending_reconciliation'");

  const coverage = await caseSlaCoverageGaps(db, asOf);
  const gapCount = coverage.gaps.length;
  const policiesCovered = coverage.total - gapCount;

  const signals: ControlSignal[] = [];
  const add = (signal: ControlSignal | null) => { if (signal) signals.push(signal); };
  const signal = (
    code: string, value: number | null, label: string,
    detail: (value: number) => string, view: string, criticalAbove = 0,
  ): ControlSignal | null => value === null ? null : {
    code, count: value, label, detail: detail(value), view,
    severity: value > criticalAbove ? "critical" : "clear",
  };

  add(signal("cases_past_sla", casesBreaching, "Cases past their resolution SLA",
    value => value ? `${value} open case${value === 1 ? "" : "s"} is past the resolution time its policy allows` : "Every open case is inside its SLA", "audit"));
  add(signal("sla_coverage", gapCount, "Case types with no active SLA policy",
    value => value ? `${value} of ${coverage.total} case-type/severity pairs have no active policy, so those cases get no SLA clock` : `All ${coverage.total} case-type/severity pairs are covered`, "approvals"));
  add(signal("queue_escalated", queueEscalated, "Escalated operations tasks",
    value => value ? `${value} open task${value === 1 ? " has" : "s have"} breached its queue SLA and escalated` : "No open task has escalated", "lifecycle"));
  add(signal("payment_exceptions", reconciliationOpen, "Unresolved payment reconciliation exceptions",
    value => value ? `${value} payment${value === 1 ? "" : "s"} could not be matched and remains open` : "Every recorded payment reconciles", "finance"));
  add(signal("statutory_overdue", statutoryOverdue, "Statutory filings past their due date",
    value => value ? `${value} filing${value === 1 ? " is" : "s are"} past the statutory due date` : "No statutory filing is overdue", "finance"));
  add(signal("alerts_overdue", alertsOverdue, "Staff alerts past their due time",
    value => value ? `${value} open alert${value === 1 ? " is" : "s are"} past due and unacknowledged` : "No open alert is past due", "health"));
  add(signal("onboarding_waiting", onboardingWaiting, "Provider applications awaiting a human decision",
    value => value ? `${value} application${value === 1 ? " is" : "s are"} waiting on a named approver` : "No application is waiting on a decision", "approvals"));
  add(signal("bot_claims", botClaims, "Bot-call conversions awaiting reconciliation",
    value => value ? `${value} bot-reported conversion or payment has not been confirmed against a money record` : "Every bot-reported conversion has been reconciled", "audit"));

  const critical = signals.filter(item => item.severity === "critical");

  // ---- Posture: ratios, each returned with the two numbers it was computed from. --------------
  const posture: PostureArea[] = [
    {
      code: "case_sla_coverage", label: "Case SLA coverage", basis: "Active case policies vs the case-type/severity pairs the platform can raise",
      good: policiesCovered, total: coverage.total, score: percent(policiesCovered, coverage.total),
    },
    {
      code: "case_sla_adherence", label: "Open cases inside SLA", basis: "Open cases not past their resolution due time",
      good: casesOpen === null || casesBreaching === null ? null : casesOpen - casesBreaching, total: casesOpen,
      score: percent(casesOpen === null || casesBreaching === null ? null : casesOpen - casesBreaching, casesOpen),
    },
    {
      code: "ops_queue_health", label: "Operations queue inside SLA", basis: "Open work-queue tasks that have not escalated",
      good: queueOpen === null || queueEscalated === null ? null : queueOpen - queueEscalated, total: queueOpen,
      score: percent(queueOpen === null || queueEscalated === null ? null : queueOpen - queueEscalated, queueOpen),
    },
    {
      code: "payment_reconciliation", label: "Payment reconciliation", basis: "Recorded reconciliation exceptions that have been resolved",
      good: reconciliationTotal === null || reconciliationOpen === null ? null : reconciliationTotal - reconciliationOpen, total: reconciliationTotal,
      score: percent(reconciliationTotal === null || reconciliationOpen === null ? null : reconciliationTotal - reconciliationOpen, reconciliationTotal),
    },
    {
      code: "statutory_filing", label: "Statutory filing", basis: "Tracked statutory obligations already filed",
      good: statutoryFiled, total: statutoryDue, score: percent(statutoryFiled, statutoryDue),
    },
    {
      code: "provider_onboarding", label: "Provider onboarding decisions", basis: "Applications that reached a named human decision",
      good: onboardingTotal === null || onboardingWaiting === null ? null : onboardingTotal - onboardingWaiting, total: onboardingTotal,
      score: percent(onboardingTotal === null || onboardingWaiting === null ? null : onboardingTotal - onboardingWaiting, onboardingTotal),
    },
  ];

  // ---- Recent governed changes: the audit trail, not a hand-written changelog. ----------------
  let recentChanges: Array<{ at: number; actor: string; action: string; entity: string; outcome: string }> = [];
  if (await tableExists(db, "security_audit_events")) {
    // Columns are resource_type/resource_id, as declared by lib/server-auth.ts. Guessing entity_*
    // here would have produced a query that only fails on a real database.
    const rows = await db.prepare(
      "SELECT actor_email,action,resource_type,resource_id,outcome,created_at FROM security_audit_events ORDER BY created_at DESC LIMIT 12").all<Row>();
    recentChanges = rows.results.map(row => ({
      at: Number(row.created_at || 0),
      actor: text(row.actor_email) || "system",
      action: text(row.action),
      entity: `${text(row.resource_type)}${row.resource_id ? `:${text(row.resource_id)}` : ""}`,
      outcome: text(row.outcome),
    }));
  }

  return {
    asOf,
    date: today,
    timezone: "Asia/Kolkata",
    headline: {
      // "Signals we can compute" — not "areas we audited". The screen must not imply an audit it
      // did not run.
      signalsTracked: signals.length,
      signalsClear: signals.length - critical.length,
      needsAttention: critical.length,
      openItems: signals.reduce((sum, item) => sum + item.count, 0),
    },
    signals,
    posture,
    recentChanges,
    sourceStatus: {
      cases: casesOpen === null ? "not_connected" : "unified_cases",
      caseSlaPolicies: "case_policies",
      opsQueue: queueOpen === null ? "not_connected" : "ops_work_queue_tasks",
      paymentReconciliation: reconciliationTotal === null ? "not_connected" : "payment_reconciliation_exceptions",
      statutory: statutoryDue === null ? "not_connected" : "statutory_filings",
      alerts: alertsOverdue === null ? "not_connected" : "staff_alerts",
      providerOnboarding: onboardingTotal === null ? "not_connected" : "provider_onboarding_applications",
      botCallClaims: botClaims === null ? "not_connected" : "bot_call_dispositions",
      auditTrail: recentChanges.length ? "security_audit_events" : "not_connected",
      // There is no requirements register in the database, so the screen must never claim a count of
      // "verified requirements" or "P0 release blockers".
      requirementsRegister: "not_connected",
    },
  };
}
