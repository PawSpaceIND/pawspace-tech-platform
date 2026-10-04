import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { missingStayCareFields } from '../lib/stay-care-validation.ts';
import { formatIndiaDateTime } from '../lib/india-time.ts';

for (const mode of ['boarding', 'sitting']) {
  test(`${mode} care requirements reject empty and whitespace before review`, () => {
    const expected = mode === 'sitting' ? ['vet', 'emergencyContact', 'homeAccess'] : ['vet', 'emergencyContact'];
    assert.deepEqual(missingStayCareFields(mode, {}), expected);
    assert.deepEqual(missingStayCareFields(mode, {vet:'  ', emergencyContact:'\n', homeAccess:'\t'}), expected);
    assert.deepEqual(missingStayCareFields(mode, {vet:'Test vet', emergencyContact:'Test contact', homeAccess:'Test access'}), []);
    assert.deepEqual(missingStayCareFields(mode, {vet:'Test vet', emergencyContact:'Test contact'}), mode === 'sitting' ? ['homeAccess'] : []);
  });
}

test('Ops schedule displays the same IST day regardless of process timezone', () => {
  const previous = process.env.TZ;
  try {
    for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Kolkata']) {
      process.env.TZ = zone;
      assert.match(formatIndiaDateTime('2026-10-03T03:30:00.000Z'), /3 Oct, 9:00 am IST/);
      assert.equal(formatIndiaDateTime('invalid', {fallback:'Not scheduled'}), 'Not scheduled');
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('stay confirmation keeps payment and required care in their reviewed order', async () => {
  const flow = await readFile(new URL('../app/mobile-app/stay-flow.tsx', import.meta.url), 'utf8');
  assert.match(flow, /onClick=\{reviewCare\}/);
  assert.match(flow, /aria-describedby=\{invalid/);
  assert.match(flow, /setConfirmedCarePlan\(plan\)/);
  assert.match(flow, /setPendingPayment\(\{bookingId:canonicalBookingId/);
  const gate = await readFile(new URL('../app/mobile-app/stay-care-payment-gate.tsx', import.meta.url), 'utf8');
  assert.match(gate, /Complete payment first, then add your Care Card/);
  assert.match(gate, /caregiver cannot check in without them/);
  assert.match(gate, /<BookingPaymentPage returnAfterVerified=\{false\}/);
  const ops = await readFile(new URL('../app/booking-command-center/page.tsx', import.meta.url), 'utf8');
  assert.match(ops, /const when = .*formatIndiaDateTime/);
  assert.doesNotMatch(ops, /date\.toLocaleString/);
});

test('Sitting pre-completion label does not diagnose missing tax configuration', async () => {
  const {sittingReconciliationLabel} = await import('../lib/sitting-reconciliation-display.ts');
  const pending = {status:'attention_required',refund_state:'none',settlement_state:'not_due',tax_state:'configuration_required'};
  assert.match(sittingReconciliationLabel('confirmed', pending), /pending service completion/);
  assert.match(sittingReconciliationLabel('confirmed', pending), /has not been assessed/);
  assert.match(sittingReconciliationLabel('confirmed', {...pending,refund_state:'attention_required'}), /Refund review required/);
  assert.match(sittingReconciliationLabel('completed', pending), /tax configuration required/);
  for(const status of ['cancelled','refunded','unknown']) assert.doesNotMatch(sittingReconciliationLabel(status,pending), /pending service completion/);
  assert.match(sittingReconciliationLabel('confirmed', {...pending,settlement_state:'attention_required'}), /tax configuration required/);
  assert.equal(sittingReconciliationLabel('confirmed', null), 'Not reconciled yet');
});
