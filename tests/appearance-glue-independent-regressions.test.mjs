import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
installWorkersHooks('__APPEARANCE_INDEPENDENT__');
const { resolveRootAppearance } = await import('../app/components/appearance-root.ts');
const { resolveAppearance } = await import('../app/components/appearance-resolver.ts');
const { syncAccountAppearance } = await import('../app/components/appearance-account-client.ts');
const cookieValue = 'v1.-.editorial.dark.-';
test('invalid request origin preserves the device first paint instead of failing the root', async () => {
  const result = await resolveRootAppearance({ cookieValue, cookieHeader: '', trustedOrigin: () => 'https://', acquireDb: async () => ({}), resolveRequestAppearance: async () => { throw new Error('must not reach helper'); } });
  assert.equal(result.accountAuthoritative, false);
  assert.deepEqual(result.snapshot, resolveAppearance({ cookieValue }));
});
test('a helper storage failure preserves device resolution', async () => {
  const result = await resolveRootAppearance({ cookieValue, cookieHeader: '', trustedOrigin: () => 'https://pawspace.example', acquireDb: async () => ({}), resolveRequestAppearance: async () => { throw new Error('storage unavailable'); } });
  assert.equal(result.accountAuthoritative, false);
  assert.deepEqual(result.snapshot, resolveAppearance({ cookieValue }));
});
test('ambiguous transport after 409 uses the same second key and payload for one bounded retry', async () => {
  const record = { version: '1', explicit: null, assigned: 'editorial', mode: 'light', legacy: null };
  const posts = []; let calls = 0; let keys = 0;
  const fetchImpl = async (_url, init) => {
    if (init.method === 'GET') return Response.json({ data: { record, snapshot: resolveAppearance({ cookieValue: 'v1.-.editorial.light.-' }), recordVersion: 7, accountAuthoritative: true } });
    posts.push(JSON.parse(init.body)); calls++;
    if (calls === 1) return Response.json({ error: 'stale' }, {status:409});
    if (calls === 2) throw new Error('response lost');
    return Response.json({ data: { record: {...record, mode:'dark'}, snapshot: resolveAppearance({cookieValue}), recordVersion:8, accountAuthoritative:true } });
  };
  const result = await syncAccountAppearance({ explicit:null, mode:'dark' }, 5, fetchImpl, () => 'reviewkey' + (++keys));
  assert.equal(result.result.kind, 'account');
  assert.equal(posts.length, 3);
  assert.deepEqual(posts[1], posts[2]);
  assert.notEqual(posts[0].idempotencyKey, posts[1].idempotencyKey);
});
