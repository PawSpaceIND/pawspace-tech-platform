/** Read-only PF/PT draft boundary. No default rates, payroll calculation or portal submission. */
async function checksum(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export type PayrollScope = { entityId: string; establishmentId: string; runId: string; period: string };
export type ReviewedRule = {
  id: string; version: number; entityId: string; establishmentId: string; kind: 'pf' | 'pt';
  jurisdiction: string; applicability: 'unknown' | 'applicable' | 'not_applicable';
  effectiveFrom: string; effectiveUntil: string; sourceUrl: string; sourceReference: string;
  reviewedBy: string; reviewedOn: string; requirementsVerified: boolean;
  employeeApplicabilityReferences: Record<string, string>;
};
export type PayrollEvidence = PayrollScope & {
  version: number; employeeIds: string[]; makerId: string; checkerId: string;
  status: 'draft' | 'approved'; sourceReferences: string[];
  reconciliation: 'unknown' | 'mismatch' | 'clean'; reconciliationReference?: string;
  lines: { employeeId: string; kind: 'pf_employee' | 'pf_employer' | 'pt_employee'; amountPaise: number; sourceReference: string }[];
};
export interface PayrollEvidenceReader {
  /** Owner adapter must read a saved immutable artifact, never invoke calculatePayroll. */
  readSavedPayroll(scope: PayrollScope): Promise<{ payload: PayrollEvidence; sha256: string } | null>;
}
const required = (value: string) => { if (typeof value !== 'string' || !value.trim()) throw new Error('reference_required'); };
const isoDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('invalid_date');
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('invalid_date');
};
const positiveVersion = (value: number) => { if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid_version'); };
export async function preparePayrollStatutoryDraft(reader: PayrollEvidenceReader, scope: PayrollScope, rules: ReviewedRule[]) {
  for (const value of Object.values(scope)) required(value);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(scope.period)) throw new Error('invalid_period');
  const blockers: string[] = [];
  const ids = new Set<string>();
  const periodStart = `${scope.period}-01`;
  const [year, month] = scope.period.split('-').map(Number);
  const periodEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  for (const rule of rules) {
    required(rule.id); positiveVersion(rule.version);
    if (ids.has(rule.id)) throw new Error('duplicate_rule'); ids.add(rule.id);
    if (rule.entityId !== scope.entityId || rule.establishmentId !== scope.establishmentId) throw new Error('rule_scope_mismatch');
    if (!['pf', 'pt'].includes(rule.kind) || !['unknown', 'applicable', 'not_applicable'].includes(rule.applicability)) throw new Error('invalid_rule');
    required(rule.jurisdiction); isoDate(rule.effectiveFrom); isoDate(rule.effectiveUntil);
    if (rule.effectiveUntil < rule.effectiveFrom) throw new Error('invalid_effective_range');
    const prefix = `${rule.kind}:${rule.id}`;
    if (rule.applicability === 'unknown') blockers.push(`${prefix}:applicability_unknown`);
    if (rule.requirementsVerified !== true || !rule.sourceReference?.trim() || !rule.reviewedBy?.trim() || !rule.reviewedOn?.trim()) blockers.push(`${prefix}:requirements_review_missing`);
    else {
      isoDate(rule.reviewedOn);
      const url = new URL(rule.sourceUrl);
      const host = url.hostname;
      const official = rule.kind === 'pf'
        ? ['epfindia.gov.in', 'epfo.gov.in', 'labour.gov.in', 'egazette.gov.in'].some(root => host === root || host.endsWith(`.${root}`))
        : host === 'gov.in' ? false : host.endsWith('.gov.in') || host.endsWith('.nic.in');
      if (url.protocol !== 'https:' || url.username || url.password || !official) throw new Error('official_source_required');
    }
    if (rule.effectiveFrom > periodStart || rule.effectiveUntil < periodEnd) blockers.push(`${prefix}:full_period_rule_missing`);
  }
  for (const kind of ['pf', 'pt'] as const) {
    const matches = rules.filter(rule => rule.kind === kind);
    if (matches.length !== 1) blockers.push(`${kind}:single_reviewed_rule_required`);
  }
  const saved = await reader.readSavedPayroll(structuredClone(scope));
  let snapshot: PayrollEvidence | undefined;
  if (!saved) blockers.push('saved_payroll_missing');
  else {
    snapshot = structuredClone(saved.payload);
    for (const key of ['entityId', 'establishmentId', 'runId', 'period'] as const) if (snapshot[key] !== scope[key]) throw new Error('payroll_scope_mismatch');
    positiveVersion(snapshot.version);
    if (await checksum(JSON.stringify(snapshot)) !== saved.sha256) throw new Error('payroll_checksum_mismatch');
    if (snapshot.status !== 'approved') blockers.push('payroll_approval_missing');
    if (!snapshot.makerId?.trim() || !snapshot.checkerId?.trim() || snapshot.makerId.trim().toLowerCase() === snapshot.checkerId.trim().toLowerCase()) blockers.push('independent_payroll_review_missing');
    if (!snapshot.sourceReferences.length || snapshot.sourceReferences.some(ref => !ref.trim())) blockers.push('payroll_source_missing');
    if (snapshot.reconciliation !== 'clean' || !snapshot.reconciliationReference?.trim()) blockers.push('reconciliation_review_missing');
    const employees = new Set(snapshot.employeeIds);
    if (!employees.size || employees.size !== snapshot.employeeIds.length || snapshot.employeeIds.some(id => !id.trim())) throw new Error('invalid_employee_scope');
    for (const rule of rules) for (const employee of employees) {
      if (!rule.employeeApplicabilityReferences?.[employee]?.trim()) blockers.push(`${employee}:${rule.kind}:applicability_evidence_missing`);
    }
    const lineIds = new Set<string>();
    for (const line of snapshot.lines) {
      if (!employees.has(line.employeeId) || !['pf_employee', 'pf_employer', 'pt_employee'].includes(line.kind)) throw new Error('invalid_payroll_line_scope');
      if (!Number.isSafeInteger(line.amountPaise) || line.amountPaise < 0) throw new Error('invalid_amount');
      required(line.sourceReference);
      const key = `${line.employeeId}:${line.kind}`;
      if (lineIds.has(key)) throw new Error('duplicate_payroll_line'); lineIds.add(key);
    }
    // Explicit zero/exemption records are required too; omission must not imply exemption.
    for (const rule of rules.filter(rule => rule.applicability === 'applicable')) {
      const kinds = rule.kind === 'pf' ? ['pf_employee', 'pf_employer'] : ['pt_employee'];
      for (const employee of employees) for (const kind of kinds) if (!lineIds.has(`${employee}:${kind}`)) blockers.push(`${employee}:${kind}:coverage_missing`);
    }
    for (const rule of rules.filter(rule => rule.applicability === 'not_applicable')) {
      if (snapshot.lines.some(line => line.kind.startsWith(`${rule.kind}_`) && line.amountPaise !== 0)) blockers.push(`${rule.kind}:not_applicable_amount_conflict`);
    }
  }
  return { mode: 'draft_only' as const, readyForReview: blockers.length === 0, blockers: [...new Set(blockers)], scope: structuredClone(scope), rules: structuredClone(rules), snapshot,
    payrollCalculationEnabled: false, portalFormatValidated: false, filingEnabled: false, remittanceEnabled: false };
}
