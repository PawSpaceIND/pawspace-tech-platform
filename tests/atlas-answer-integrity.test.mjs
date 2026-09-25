import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
import { makeD1 } from './helpers/taxi-harness.mjs';
installWorkersHooks('__ATLAS_ANSWER_DB__', '__ATLAS_ANSWER_ENV__');
const atlas = await import('../lib/intelligence/atlas-business-snapshot.ts');
const revenue = await import('../lib/revenue-mission-control.ts');
async function setup(t, { missing = false, provider = 'anthropic', output = '', stop = 'end_turn', noKey = false } = {}) {
  const sqlite = new DatabaseSync(':memory:'), db = makeD1(sqlite), now = 2_000_000_000_000, calls = [];
  t.after(() => sqlite.close());
  globalThis.__ATLAS_ANSWER_DB__ = db;
  globalThis.__ATLAS_ANSWER_ENV__ = noKey ? {} : { PAWSPACE_DEPLOYMENT_ENV: 'staging', PAWSPACE_AI_PROVIDER: provider,
    PAWSPACE_AI_PROVIDER_API_KEY: 'synthetic-test-only', PAWSPACE_OPENAI_API_KEY: 'synthetic-test-only' };
  t.after(() => { globalThis.__ATLAS_ANSWER_ENV__ = {}; });
  sqlite.exec("CREATE TABLE canonical_bookings(id TEXT PRIMARY KEY,service_code TEXT,status TEXT); CREATE TABLE unified_cases(id TEXT PRIMARY KEY,status TEXT,first_responded_at INTEGER,first_response_due_at INTEGER,resolution_due_at INTEGER); INSERT INTO canonical_bookings VALUES ('B1','grooming','completed'); INSERT INTO unified_cases VALUES ('C1','open',NULL,1,1);");
  await revenue.ensureRevenueMissionTables(db);
  if (!missing) {
    sqlite.prepare("INSERT INTO revenue_missions (id,name,target_amount,currency,period_start,period_end,scope_json,revenue_basis,status,approval_reference,config_version,created_by,created_at,updated_by,updated_at) VALUES ('M-ANSWER','Synthetic mission',1000,'INR',?,?,'{\"type\":\"company\"}','net_collected','active_uat','TEST',1,'test',?,'test',?)").run(now-1000,now+1000,now,now);
    sqlite.prepare("INSERT INTO revenue_mission_events (id,mission_id,source_event_key,event_type,customer_id,booking_id,payment_id,refund_id,service_code,city_id,gross_amount,refund_amount,eligible_amount,currency,source_at,source_version,attribution_json,created_at) VALUES ('E1','M-ANSWER','test-collected','collected','C1','B1','P1',NULL,'grooming','blr',400,0,400,'INR',?,'test','{}',?)").run(now,now);
  }
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return Response.json(provider === 'openai' ? { status: stop, output_text: output } : { type: 'message', stop_reason: stop, content: [{ type: 'text', text: output }] });
  });
  const ask = (question = 'State current mission facts and scope.') => atlas.answerAtlasBusinessQuestion(db, { question, asOf: now });
  return { sqlite, db, now, calls, ask };
}
for (const [provider, stop] of [['anthropic','end_turn'],['openai','completed']]) test(`active ${provider} Q&A keeps a complete grounded response and bounded scope`, async t => {
  const output = 'Collected INR 400; achieved 40%; target INR 1,000. Source: revenue_mission_events. No action was executed.';
  const f = await setup(t, { provider, stop, output }), result = await f.ask();
  assert.equal(result.narrativeAvailable, true); assert.equal(result.content, output); assert.equal(result.narrativeReason, null);
  assert.equal(f.calls.length, 1); const request = f.calls[0].body;
  assert.equal(request.max_tokens ?? request.max_output_tokens, 1200);
  const context = JSON.parse(provider === 'openai' ? request.input : request.messages[0].content);
  assert.equal(context.answerScope.internalArtifacts.length, 6); assert.ok(context.answerScope.humanGated.includes('refund'));
  assert.equal(context.outcomeLearning.secondaryContextOnly, true); assert.equal(context.outcomeLearning.authorityMutationAllowed, false);
  assert.equal(result.snapshot.production_ready, false); assert.equal(result.snapshot.mission.value.collected, 400);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM revenue_mission_events').get().n, 1);
  assert.equal(f.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='atlas_proposals'").get(), undefined, 'Q&A never creates an action proposal');
});
for (const [provider, stop] of [['anthropic','max_tokens'],['openai','incomplete'],['anthropic','length'],['anthropic','tool_use'],['anthropic',null]]) test(`active Q&A refuses unfinished ${provider}/${stop} narrative`, async t => {
  const f = await setup(t, { provider, stop, output: 'PARTIAL_SENTENCE_MARKER: first priority is' }), result = await f.ask();
  assert.equal(result.narrativeAvailable, false); assert.equal(result.narrativeReason, 'narrative_incomplete');
  assert.doesNotMatch(result.content, /PARTIAL_SENTENCE_MARKER/); assert.match(result.content, /collected INR 400/);
  assert.match(result.content, /Open cases: 1/); assert.match(result.content, /SLA breaches: 1/); assert.match(result.content, /Source: unified_cases/);
  assert.equal(f.calls.length, 1, 'no unbounded generation retry');
});
for (const output of ['**Collected**: INR 9,000.','Collected INR 400. Collected INR 9,000.','Collected INR 9 lakh.','INR 9 lakh collected.','Achieved 75% of target.','75% achieved.','Target INR 500.','Net: INR 1,000.']) test(`active Q&A rejects unsupported figure: ${output}`, async t => {
  const f = await setup(t, { output }), result = await f.ask();
  assert.equal(result.narrativeAvailable, false); assert.match(result.narrativeReason, /^narrative_/);
  assert.notEqual(result.content, output); assert.match(result.content, /collected INR 400/);
});
for (const output of ['Collected INR 9000000.','100% achieved.','Target INR 1000.','INR 9000000 collected.']) test(`active Q&A refuses invented missing-mission data: ${output}`, async t => {
  const f = await setup(t, { missing: true, output }), result = await f.ask();
  assert.equal(result.narrativeAvailable, false); assert.match(result.narrativeReason, /missing_mission|overstates/);
  assert.equal(result.snapshot.mission.value, null); assert.equal(result.snapshot.mission.reason, 'current_mission_not_found');
  assert.match(result.content, /Mission data is insufficient/); assert.match(result.content, /Open cases: 1/);
});
for (const [output, reason] of [['I activated all campaigns.','narrative_claims_campaign_execution'],['I assigned provider P-123.','narrative_claims_provider_assignment'],['I captured the payment and refunded INR 100.','narrative_claims_money_movement']]) test(`active Q&A retains ${reason}`, async t => {
  const f = await setup(t, { output }), result = await f.ask();
  assert.equal(result.narrativeAvailable, false); assert.equal(result.narrativeReason, reason);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE status='completed'").get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM revenue_mission_events').get().n, 1);
});
test('missing AI key preserves known operations and unknown mission without a network call', async t => {
  const f = await setup(t, { missing: true, noKey: true }), result = await f.ask();
  assert.equal(result.narrativeAvailable, false); assert.equal(result.narrativeReason, 'not_configured'); assert.equal(f.calls.length, 0);
  assert.match(result.content, /current_mission_not_found/); assert.match(result.content, /Open cases: 1/);
  assert.match(result.content, /Completed-job invoice gap: unknown/); assert.match(result.content, /Snapshot as of/);
});
test('missing mission can still produce a complete operational answer without fake revenue', async t => {
  const output = 'Current mission data is unavailable. There is one open case for staff review. This answer does not execute any action.';
  const f = await setup(t, { missing: true, output }), result = await f.ask();
  assert.equal(result.narrativeAvailable, true); assert.equal(result.content, output); assert.equal(result.snapshot.mission.value, null);
});
