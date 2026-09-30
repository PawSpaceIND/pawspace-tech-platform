import test from 'node:test';
import assert from 'node:assert/strict';
import {activateMayaKnowledgeStaging, requiredPetCareSources} from '../scripts/activate-maya-knowledge-staging.mjs';
import {importLibModule} from './helpers/ts-module-loader.mjs';

test('activation readback covers the actual production pet-care knowledge pack', async () => {
  const {MAYA_KNOWLEDGE} = await importLibModule('maya-knowledge-base');
  for (const key of requiredPetCareSources) {
    const entries = MAYA_KNOWLEDGE.filter(entry => entry.sourceKey === key);
    assert.equal(entries.length, 1, key);
    assert.ok(entries[0].contentText.trim().length > 0, key);
  }
});

const env = {CONFIRM: 'activate-approved-maya-staging', EXPECTED_SHA: 'a'.repeat(40),
  CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'test-token', STAGING_D1_ID: 'staging', PAWSPACE_UAT_ACCESS_CODE: 'test-code'};
function server(options = {}) {
  const calls = [];
  return {calls, request: async (url, init = {}) => {
    calls.push({url, init});
    if (url.endsWith('/d1/database/staging')) return Response.json({success: true, result: {name: options.dbName || 'pawspace-staging'}});
    if (url.endsWith('/api/staging-login')) return options.loginRefused ? Response.json({}, {status: 403}) : Response.json({}, {headers: {'set-cookie': 'pawspace_uat=test; HttpOnly'}});
    if (url.endsWith('/api/ai-bootstrap')) return Response.json({data: {serviceKnowledge: options.counts || {activated: 4, unchanged: 1, total: 5}}});
    if (url.endsWith('/query')) return Response.json({success: true, result: [{success: true, results: options.rows || requiredPetCareSources.map(source_key => ({source_key, title: source_key, version: 1, immutable_hash: 'b'.repeat(64)}))}]});
    throw Error('Unexpected operation');
  }};
}
test('knowledge activation refuses missing authorization before any network request', async () => {
  const s = server();
  await assert.rejects(activateMayaKnowledgeStaging({...env, CONFIRM: ''}, s.request), /Explicit staging activation/);
  assert.equal(s.calls.length, 0);
});
test('a production or unrelated database cannot receive a knowledge mutation', async () => {
  const s = server({dbName: 'pawspace-production'});
  await assert.rejects(activateMayaKnowledgeStaging(env, s.request), /outside the isolated staging/);
  assert.equal(s.calls.length, 1);
});
test('failed staff authentication stops before bootstrap', async () => {
  const s = server({loginRefused: true});
  await assert.rejects(activateMayaKnowledgeStaging(env, s.request), /staff session required/);
  assert.equal(s.calls.length, 2);
});
test('approved pack uses the real staff lifecycle and verifies all four active sources', async () => {
  const s = server();
  const evidence = await activateMayaKnowledgeStaging(env, s.request);
  assert.equal(evidence.petCareSourcesVerified, 4);
  assert.equal(evidence.dialed, false);
  assert.equal(evidence.productionActivated, false);
  assert.deepEqual(JSON.parse(s.calls[2].init.body), {pack: 'maya'}, 'no invented checker attribution or unrelated configuration pack');
  assert.deepEqual(s.calls.map(call => new URL(call.url).pathname.split('/').pop()), ['staging', 'staging-login', 'ai-bootstrap', 'query']);
});
test('incomplete activation totals cannot certify readiness', async () => {
  const s = server({counts: {activated: 1, unchanged: 1, total: 5}});
  await assert.rejects(activateMayaKnowledgeStaging(env, s.request), /did not complete/);
  assert.equal(s.calls.length, 3);
});
test('a missing or duplicate active medical article cannot certify readiness', async () => {
  for (const rows of [[], requiredPetCareSources.flatMap(source_key => Array.from({length: 2}, () => ({source_key, title: 'title', version: 1, immutable_hash: 'b'.repeat(64)})))]) {
    const s = server({rows});
    await assert.rejects(activateMayaKnowledgeStaging(env, s.request), /not uniquely active/);
  }
});
