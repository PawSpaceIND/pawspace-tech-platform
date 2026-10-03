import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePayrollStatutoryDraft } from '../lib/company-compliance/payroll-statutory.ts';
import { checksum } from '../lib/company-compliance/workflow.ts';

const scope = { entityId: 'fixture-company', establishmentId: 'fixture-establishment', runId: 'fixture-run', period: '2026-09' };
const payload = () => ({ ...scope, version: 1, employeeIds: ['fixture-employee'], makerId: 'fixture-maker', checkerId: 'fixture-checker', status: 'approved', sourceReferences: ['fixture/payroll'], reconciliation: 'clean', reconciliationReference: 'fixture/reconciliation', lines: ['pf_employee', 'pf_employer', 'pt_employee'].map(kind => ({ employeeId: 'fixture-employee', kind, amountPaise: 0, sourceReference: 'fixture/explicit-zero' })) });
const rules = () => ['pf', 'pt'].map(kind => ({ ...scope, id: `fixture-${kind}`, version: 1, kind, jurisdiction: 'fixture-jurisdiction', applicability: 'applicable', effectiveFrom: '2026-09-01', effectiveUntil: '2026-09-30', sourceUrl: kind === 'pf' ? 'https://www.epfo.gov.in/' : 'https://ptax.karnataka.gov.in/', sourceReference: 'SYNTHETIC-NOT-A-LEGAL-RULE', reviewedBy: 'fixture-reviewer', reviewedOn: '2026-10-03', requirementsVerified: true, employeeApplicabilityReferences: { 'fixture-employee': 'fixture/work-state-membership-review' } }));
const reader = data => ({ readSavedPayroll: async () => ({ payload: data, sha256: await checksum(JSON.stringify(data)) }) });
test('reviewed synthetic evidence is only ready for draft review; immutable copy and all live boundaries remain closed', async () => {
  const data = payload(), configuration = rules();
  const result = await preparePayrollStatutoryDraft(reader(data), scope, configuration);
  assert.equal(result.readyForReview, true);
  for (const key of ['payrollCalculationEnabled', 'portalFormatValidated', 'filingEnabled', 'remittanceEnabled']) assert.equal(result[key], false);
  data.lines[0].amountPaise = 123; configuration[0].sourceReference = 'changed';
  assert.equal(result.snapshot.lines[0].amountPaise, 0); assert.equal(result.rules[0].sourceReference, 'SYNTHETIC-NOT-A-LEGAL-RULE');
});
test('missing or unknown rules and missing saved payroll fail closed without default rates', async () => {
  const result = await preparePayrollStatutoryDraft({ readSavedPayroll: async () => null }, scope, []);
  assert.equal(result.readyForReview, false); assert.ok(result.blockers.includes('saved_payroll_missing'));
  const configuration = rules(); configuration[0].applicability = 'unknown'; configuration[1].requirementsVerified = false;
  const blocked = await preparePayrollStatutoryDraft(reader(payload()), scope, configuration);
  assert.ok(blocked.blockers.includes('pf:fixture-pf:applicability_unknown')); assert.ok(blocked.blockers.includes('pt:fixture-pt:requirements_review_missing'));
});
test('scope and checksum tampering rejected', async () => {
  const data = payload();
  await assert.rejects(preparePayrollStatutoryDraft({ readSavedPayroll: async () => ({ payload: data, sha256: 'forged' }) }, scope, rules()), /checksum/);
  data.establishmentId = 'other'; await assert.rejects(preparePayrollStatutoryDraft(reader(data), scope, rules()), /scope/);
  const configuration = rules(); configuration[0].entityId = 'other'; await assert.rejects(preparePayrollStatutoryDraft(reader(payload()), scope, configuration), /scope/);
});
test('review, reconciliation, complete coverage and period evidence independently required', async () => {
  const data = payload(); data.checkerId = ' FIXTURE-MAKER '; data.reconciliation = 'unknown'; data.lines.pop();
  const configuration = rules(); configuration[0].effectiveFrom = '2026-09-17';
  const result = await preparePayrollStatutoryDraft(reader(data), scope, configuration);
  for (const blocker of ['independent_payroll_review_missing', 'reconciliation_review_missing', 'fixture-employee:pt_employee:coverage_missing', 'pf:fixture-pf:full_period_rule_missing']) assert.ok(result.blockers.includes(blocker));
});
test('malformed amount, duplicate employee/line and invalid official reference rejected', async () => {
  for (const mutate of [data => data.lines[0].amountPaise = NaN, data => data.lines.push(data.lines[0]), data => data.employeeIds.push(data.employeeIds[0])]) {
    const data = payload(); mutate(data); await assert.rejects(preparePayrollStatutoryDraft(reader(data), scope, rules()));
  }
  const configuration = rules(); configuration[0].sourceUrl = 'https://epfo.gov.in.example.com/';
  await assert.rejects(preparePayrollStatutoryDraft(reader(payload()), scope, configuration), /official_source/);
});
test('not applicable needs reviewed evidence and cannot hide deducted amounts', async () => {
  const data = payload(), configuration = rules(); configuration[1].applicability = 'not_applicable'; data.lines[2].amountPaise = 1;
  const result = await preparePayrollStatutoryDraft(reader(data), scope, configuration);
  assert.ok(result.blockers.includes('pt:not_applicable_amount_conflict')); assert.equal(result.readyForReview, false);
});
test('employee applicability cannot be inferred from payroll lines or establishment review', async () => {
  const configuration = rules();
  delete configuration[0].employeeApplicabilityReferences;
  const result = await preparePayrollStatutoryDraft(reader(payload()), scope, configuration);
  assert.equal(result.readyForReview, false);
  assert.ok(result.blockers.includes('fixture-employee:pf:applicability_evidence_missing'));
});
