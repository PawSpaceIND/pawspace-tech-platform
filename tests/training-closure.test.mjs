import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Training keeps one canonical programme/session commercial boundary', async () => {
  const [commercialRoute, commercialGovernance, programmeRoute, programmeGovernance, sessions] = await Promise.all([
    read('app/api/training-commercial/route.ts'),
    read('lib/training-commercial-governance.ts'),
    read('app/api/training-programmes/route.ts'),
    read('lib/training-programme.ts'),
    read('lib/training-session-lifecycle.ts'),
  ]);
  assert.match(commercialRoute, /createTrainingQuote/);
  assert.match(commercialRoute, /listTrainingPackages/);
  assert.match(commercialRoute, /canonical_training_commercial/);
  assert.match(commercialGovernance, /training_commercial_quotes/);
  assert.match(commercialGovernance, /training_booking_quote_links/);
  assert.match(commercialGovernance, /consumeTrainingQuote/);
  assert.match(programmeRoute, /materializeTrainingProgramme/);
  assert.match(programmeRoute, /readTrainingProgramme/);
  assert.match(programmeGovernance, /training_programmes/);
  assert.match(programmeGovernance, /training_sessions/);
  assert.match(programmeGovernance, /programme_materialized/);
  assert.match(sessions, /training_sessions/);
  assert.match(sessions, /training_session_recovery_cases/);
});

test('Training operations and finance project canonical records', async () => {
  const [ops, reconciliation, finance] = await Promise.all([
    read('app/api/training-ops/route.ts'),
    read('app/api/training-reconciliation/route.ts'),
    read('lib/training-finance.ts'),
  ]);
  assert.match(ops, /canonical_training_ops/);
  assert.match(ops, /provider_capacity_profiles/);
  assert.match(reconciliation, /canonical_training_reconciliation/);
  assert.match(reconciliation, /training_booking_quote_links/);
  assert.match(reconciliation, /training_session_earnings/);
  assert.match(finance, /training_finance_invoices/);
});

test('Training evidence remains private and external-storage gated', async () => {
  const media = await read('app/api/training-session-media/route.ts');
  assert.match(media, /requireProviderOwnership/);
  assert.match(media, /SHA-256/);
  assert.match(media, /storageBackend:\"not_connected\"/);
  assert.match(media, /proofReady:false/);
});

test('Training API permissions are explicit in the gateway', async () => {
  const gateway = await read('lib/api-gateway.ts');
  for (const route of [
    '/api/training-commercial',
    '/api/training-programmes',
    '/api/training-sessions',
    '/api/training-session-media',
    '/api/training-cancellation',
    '/api/training-customer-session-change',
    '/api/training-ops',
    '/api/training-finance',
    '/api/training-provider-earnings',
    '/api/training-reconciliation',
  ]) assert.ok(gateway.includes(route), `${route} must be permission mapped`);
});

test('Training closure remains UAT-only', async () => {
  const plan = await read('docs/TRAINING_CLOSURE_PLAN.md');
  assert.match(plan, /PRODUCTION READY = FALSE/);
  assert.match(plan, /Production object storage/);
  assert.match(plan, /Production payment\/refund\/payout/);
  assert.match(plan, /GST\/tax\/invoice\/accounting/);
});
