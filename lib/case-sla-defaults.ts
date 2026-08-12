/**
 * Default case SLA policies.
 *
 * createUnifiedCase() looks up an ACTIVE policy for the exact (case_type, severity) pair and, when
 * none exists, files the case with null first_response_due_at / resolution_due_at /
 * manager_escalation_due_at. That is honest - it does not invent a deadline - but it means the case
 * sits in the queue with no clock, and runUnifiedCaseEscalations() has nothing to breach. Staging
 * had ZERO policies configured, so every escalation (including the "bot call needs a human" case)
 * landed with no deadline and nobody was ever chased.
 *
 * This seeds a complete matrix so there are no uncovered (type, severity) pairs, derived from a
 * severity baseline scaled by how urgent each case type genuinely is. The numbers are UAT defaults
 * chosen to be defensible, not authoritative - the founder/ops owner is expected to replace them
 * with the real commitments before production, which is why:
 *   - seeding NEVER touches a (type, severity) that already has any policy, so it cannot overwrite
 *     a configured commitment or resurrect one that was deliberately retired, and
 *   - every seeded policy carries an explicit approval reference marking it as a UAT default.
 */

import { activateCasePolicy, saveCasePolicy, type CaseSeverity, type CaseType } from "./unified-case-center";

type Db = D1Database;
type Row = Record<string, unknown>;

export const caseSeverities: CaseSeverity[] = ["critical", "high", "medium", "low"];
export const caseTypes: CaseType[] = [
  "safety_incident", "customer_complaint", "payment", "refund", "provider_issue",
  "lead_escalation", "rebooking", "reconciliation", "operations",
];

// Severity baseline, in minutes: how fast someone must respond, resolve, and how long before a
// manager is pulled in. Manager escalation is deliberately AFTER first response but well BEFORE
// resolution - it is the "this is going to be missed" signal, not the post-mortem.
const severityBaseline: Record<CaseSeverity, { firstResponse: number; resolution: number; managerEscalation: number }> = {
  critical: { firstResponse: 15, resolution: 4 * 60, managerEscalation: 30 },
  high: { firstResponse: 30, resolution: 8 * 60, managerEscalation: 60 },
  medium: { firstResponse: 2 * 60, resolution: 24 * 60, managerEscalation: 4 * 60 },
  low: { firstResponse: 8 * 60, resolution: 72 * 60, managerEscalation: 24 * 60 },
};

// How urgent this case type is relative to the baseline. A pet's welfare outranks everything; money
// questions outrank sales follow-ups; back-office reconciliation is genuinely slower.
const typeUrgency: Record<CaseType, number> = {
  safety_incident: 0.25,
  payment: 0.5,
  customer_complaint: 0.75,
  refund: 0.75,
  rebooking: 0.75,
  provider_issue: 1,
  lead_escalation: 1,
  operations: 1,
  reconciliation: 1.5,
};

/** Never promise a response faster than a real human can pick up a queue item. */
const FIRST_RESPONSE_FLOOR_MINUTES = 5;
const scale = (minutes: number, factor: number, floor = 1) => Math.max(floor, Math.round(minutes * factor));

export type CaseSlaDefault = {
  caseType: CaseType;
  severity: CaseSeverity;
  name: string;
  firstResponseMinutes: number;
  resolutionMinutes: number;
  managerEscalationMinutes: number;
};

/** The full (type x severity) matrix. Pure and inspectable - no gaps by construction. */
export function defaultCaseSlaMatrix(): CaseSlaDefault[] {
  const rows: CaseSlaDefault[] = [];
  for (const caseType of caseTypes) {
    const factor = typeUrgency[caseType];
    for (const severity of caseSeverities) {
      const base = severityBaseline[severity];
      rows.push({
        caseType,
        severity,
        name: `UAT default · ${caseType.replaceAll("_", " ")} · ${severity}`,
        firstResponseMinutes: scale(base.firstResponse, factor, FIRST_RESPONSE_FLOOR_MINUTES),
        resolutionMinutes: scale(base.resolution, factor),
        managerEscalationMinutes: scale(base.managerEscalation, factor),
      });
    }
  }
  return rows;
}

/**
 * Seed and activate any (type, severity) pair that has no policy at all. Idempotent: re-running
 * changes nothing, and a pair the ops owner has already configured (in any status - draft, active
 * or retired) is left completely alone.
 */
export async function seedDefaultCasePolicies(db: Db, input: { actorId: string; approvalReference?: string; effectiveFrom?: number }) {
  const approvalReference = (input.approvalReference || "UAT-DEFAULT-SLA").trim();
  if (approvalReference.length < 4) throw new Error("A seed approval reference of at least 4 characters is required");
  const effectiveFrom = input.effectiveFrom ?? Date.now();
  const existing = await db.prepare("SELECT case_type,severity,status FROM case_policies").all<Row>().catch(() => ({ results: [] as Row[] }));
  const alreadyConfigured = new Set(existing.results.map(row => `${String(row.case_type)}:${String(row.severity)}`));

  const seeded: Array<{ caseType: CaseType; severity: CaseSeverity; policyId: string }> = [];
  const skipped: Array<{ caseType: CaseType; severity: CaseSeverity; reason: string }> = [];
  for (const row of defaultCaseSlaMatrix()) {
    const key = `${row.caseType}:${row.severity}`;
    if (alreadyConfigured.has(key)) { skipped.push({ caseType: row.caseType, severity: row.severity, reason: "policy_already_configured" }); continue; }
    const draft = await saveCasePolicy(db, {
      name: row.name, caseType: row.caseType, severity: row.severity,
      firstResponseMinutes: row.firstResponseMinutes, resolutionMinutes: row.resolutionMinutes,
      managerEscalationMinutes: row.managerEscalationMinutes, effectiveFrom, actorId: input.actorId,
    });
    await activateCasePolicy(db, { policyId: draft.id, approvalReference, actorId: input.actorId });
    seeded.push({ caseType: row.caseType, severity: row.severity, policyId: draft.id });
  }
  return {
    seeded: seeded.length, skipped: skipped.length, details: { seeded, skipped },
    approvalReference,
    truth: {
      source: "uat_defaults_not_a_business_commitment",
      overwritesConfiguredPolicy: false,
      replaceBeforeProduction: true,
    },
  };
}

/** Which (type, severity) pairs currently have NO active policy - i.e. cases that get no deadline. */
export async function caseSlaCoverageGaps(db: Db, asOf = Date.now()) {
  const rows = await db.prepare("SELECT case_type,severity FROM case_policies WHERE status='active_uat' AND effective_from<=? AND (effective_until IS NULL OR effective_until>=?)").bind(asOf, asOf).all<Row>().catch(() => ({ results: [] as Row[] }));
  const covered = new Set(rows.results.map(row => `${String(row.case_type)}:${String(row.severity)}`));
  const gaps: Array<{ caseType: CaseType; severity: CaseSeverity }> = [];
  for (const caseType of caseTypes) for (const severity of caseSeverities) {
    if (!covered.has(`${caseType}:${severity}`)) gaps.push({ caseType, severity });
  }
  return { total: caseTypes.length * caseSeverities.length, covered: covered.size, gaps, fullyCovered: gaps.length === 0 };
}
