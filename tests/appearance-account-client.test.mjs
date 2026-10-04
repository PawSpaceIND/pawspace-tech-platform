import test from 'node:test'; import assert from 'node:assert/strict';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
// Executes the real client/root modules (extensionless app imports resolve through the shared hook); no backend, no network.
installWorkersHooks('__APPEARANCE_GLUE__');
const { accountWritesEnabled, createIdempotencyKey, isIdempotencyKey, readAccountAppearance, setBody, syncAccountAppearance, accountDiffersFromDevice, APPEARANCE_API } = await import('../app/components/appearance-account-client.ts');
const record = { version: '1', explicit: 'editorial', assigned: 'editorial', mode: 'dark', legacy: null };
const snapshot = { effective: 'editorial', explicit: 'editorial', assigned: 'editorial', mode: 'dark', legacy: null, conciergeAvailable: false, recordPresent: true, invalidInput: false, legacyMoved: false };
const account = (recordVersion, extra = {}) => ({ data: { record, snapshot, recordVersion, accountAuthoritative: true }, ...extra });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fetchScript(steps) { const calls = []; const impl = async (url, init) => { calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null }); const step = steps.shift(); if (!step) throw new Error('unexpected request'); if (step instanceof Error) throw step; return step; }; return { impl, calls }; }
const keys = (...list) => { const q = [...list]; return () => q.shift(); };

test('idempotency keys follow the contract grammar (8..128 chars from A-Za-z0-9_-)', () => {
  for (const key of [createIdempotencyKey(), createIdempotencyKey(8), createIdempotencyKey(128), createIdempotencyKey(999)]) assert.ok(isIdempotencyKey(key), key);
  assert.equal(createIdempotencyKey(999).length, 128); assert.equal(createIdempotencyKey(1).length, 8);
  for (const bad of ['short', 'has space 123', 'x'.repeat(129), 'has.dot12', '']) assert.equal(isIdempotencyKey(bad), false, bad);
});
test('account writes are enabled only by accountAuthoritative===true with a positive safe integer version', () => {
  assert.equal(accountWritesEnabled(account(1).data), true);
  for (const bad of [account(0).data, account(-1).data, account(1.5).data, account(Number.MAX_SAFE_INTEGER + 1).data, account('1').data, { ...account(1).data, accountAuthoritative: false }, { ...account(1).data, accountAuthoritative: 'true' }, null, undefined, 'x'])
    assert.equal(accountWritesEnabled(bad), false);
});
test('the POST body is exactly {action,record:{explicit,mode},expectedRecordVersion,idempotencyKey}; subject, assigned and legacy are never sent', () => {
  const body = setBody({ explicit: 'concierge', mode: 'system' }, 7, 'key_ABC-123');
  assert.deepEqual(body, { action: 'set', record: { explicit: 'concierge', mode: 'system' }, expectedRecordVersion: 7, idempotencyKey: 'key_ABC-123' });
  assert.deepEqual(Object.keys(body), ['action', 'record', 'expectedRecordVersion', 'idempotencyKey']); assert.deepEqual(Object.keys(body.record), ['explicit', 'mode']);
  assert.deepEqual(setBody({ explicit: null, mode: 'light' }, 1, 'abcdefgh').record, { explicit: null, mode: 'light' });
  assert.throws(() => setBody({ explicit: 'signature', mode: 'light' }, 1, 'abcdefgh'), /intent/);
  assert.throws(() => setBody({ explicit: 'editorial', mode: 'bright' }, 1, 'abcdefgh'), /intent/);
  assert.throws(() => setBody({ explicit: 'editorial', mode: 'light' }, 0, 'abcdefgh'), /positive/);
  assert.throws(() => setBody({ explicit: 'editorial', mode: 'light' }, 1, 'short'), /8\.\.128/);
});
test('GET first: authoritative, 401 device path, 503 unavailable, refusals and transport errors are plain', async () => {
  let f = fetchScript([json(200, account(3))]); let r = await readAccountAppearance(f.impl);
  assert.equal(r.kind, 'account'); assert.equal(r.data.recordVersion, 3); assert.equal(f.calls[0].url, APPEARANCE_API); assert.equal(f.calls[0].init.method, 'GET'); assert.equal(f.calls[0].init.credentials, 'same-origin');
  f = fetchScript([json(401, { error: 'Signed out' })]); assert.deepEqual(await readAccountAppearance(f.impl), { kind: 'device', status: 401 });
  f = fetchScript([json(503, { error: 'Preferences unavailable' })]); assert.deepEqual(await readAccountAppearance(f.impl), { kind: 'unavailable', status: 503 });
  for (const status of [400, 403, 429]) { f = fetchScript([json(status, { error: 'nope' })]); r = await readAccountAppearance(f.impl); assert.equal(r.kind, 'refused'); assert.equal(r.status, status); assert.equal(r.message, 'nope'); }
  f = fetchScript([json(200, { data: { record, snapshot, recordVersion: 0, accountAuthoritative: true } })]); r = await readAccountAppearance(f.impl); assert.equal(r.kind, 'error');
  f = fetchScript([new TypeError('network down')]); r = await readAccountAppearance(f.impl); assert.equal(r.kind, 'error'); assert.match(r.message, /network down/);
});
test('write success returns the current account; an older successful retry receipt (duplicatePrevented) is applied as the CURRENT account', async () => {
  const f = fetchScript([json(200, account(4, { duplicatePrevented: true }))]);
  const out = await syncAccountAppearance({ explicit: 'editorial', mode: 'dark' }, 3, f.impl, keys('kkkkkkk1'));
  assert.equal(out.result.kind, 'account'); assert.equal(out.result.duplicatePrevented, true); assert.equal(out.result.data.recordVersion, 4);
  assert.deepEqual(f.calls[0].body, { action: 'set', record: { explicit: 'editorial', mode: 'dark' }, expectedRecordVersion: 3, idempotencyKey: 'kkkkkkk1' });
  assert.equal(f.calls[0].init.method, 'POST'); assert.equal(f.calls[0].init.headers['content-type'], 'application/json');
});
test('ambiguous transport failure retries once with the SAME key and payload', async () => {
  const f = fetchScript([new TypeError('reset'), json(200, account(2))]);
  const out = await syncAccountAppearance({ explicit: 'concierge', mode: 'light' }, 1, f.impl, keys('same_key_1', 'unused_key'));
  assert.equal(out.result.kind, 'account'); assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[0].body, f.calls[1].body); assert.equal(f.calls[1].body.idempotencyKey, 'same_key_1');
  const g = fetchScript([new TypeError('reset'), new TypeError('reset again')]);
  const bad = await syncAccountAppearance({ explicit: 'concierge', mode: 'light' }, 1, g.impl, keys('same_key_1')); assert.equal(bad.result.kind, 'error'); assert.equal(g.calls.length, 2);
});
test('409 re-reads the authoritative account and re-applies the explicit user intent once with the NEW version and a NEW key; a second 409 stops', async () => {
  const f = fetchScript([json(409, { error: 'stale' }), json(200, account(9)), json(200, account(10))]);
  const out = await syncAccountAppearance({ explicit: 'concierge', mode: 'dark' }, 5, f.impl, keys('first_key_1', 'second_key2'));
  assert.equal(out.result.kind, 'account'); assert.equal(out.result.data.recordVersion, 10); assert.equal(f.calls.length, 3);
  assert.equal(f.calls[1].init.method, 'GET'); assert.deepEqual(f.calls[2].body, { action: 'set', record: { explicit: 'concierge', mode: 'dark' }, expectedRecordVersion: 9, idempotencyKey: 'second_key2' });
  const g = fetchScript([json(409, {}), json(200, account(9)), json(409, {})]);
  const stop = await syncAccountAppearance({ explicit: 'concierge', mode: 'dark' }, 5, g.impl, keys('first_key_1', 'second_key2', 'third_key_3'));
  assert.equal(stop.result.kind, 'conflict'); assert.equal(g.calls.length, 3, 'no overwrite loop');
  const h = fetchScript([json(409, {}), json(401, {})]); const signedOut = await syncAccountAppearance({ explicit: null, mode: 'light' }, 5, h.impl, keys('first_key_1'));
  assert.deepEqual(signedOut.result, { kind: 'device', status: 401 }); assert.equal(h.calls.length, 2);
  const u = fetchScript([json(409, {}), json(503, {})]); const unavailable = await syncAccountAppearance({ explicit: null, mode: 'light' }, 5, u.impl, keys('first_key_1'));
  assert.deepEqual(unavailable.result, { kind: 'unavailable', status: 503 }); assert.equal(u.calls.length, 2, 'no fallback account write after 503');
});
test('existing account wins across devices: difference detection covers explicit, assigned, mode and legacy', () => {
  const device = { ...record }; assert.equal(accountDiffersFromDevice(record, device), false);
  assert.equal(accountDiffersFromDevice({ ...record, mode: 'light' }, device), true); assert.equal(accountDiffersFromDevice({ ...record, explicit: null }, device), true);
  assert.equal(accountDiffersFromDevice({ ...record, legacy: 'theme~signature~style~cartoon' }, device), true); assert.equal(accountDiffersFromDevice({ ...record, assigned: 'concierge' }, device), true);
});

test('review regression: a transport loss on the second POST after the 409 re-read retries once with the same key and payload and ends in a plain outcome', async () => {
  const f = fetchScript([json(409, {}), json(200, account(9)), new TypeError('socket hang up'), json(200, account(10))]);
  const out = await syncAccountAppearance({ explicit: 'editorial', mode: 'dark' }, 5, f.impl, keys('first_key_1', 'second_key2', 'never_used'));
  assert.equal(out.result.kind, 'account'); assert.equal(out.result.data.recordVersion, 10); assert.equal(f.calls.length, 4);
  assert.deepEqual(f.calls[2].body, f.calls[3].body); assert.equal(f.calls[3].body.idempotencyKey, 'second_key2'); assert.equal(f.calls[3].body.expectedRecordVersion, 9);
  const g = fetchScript([json(409, {}), json(200, account(9)), new TypeError('lost'), new TypeError('lost again')]);
  const plain = await syncAccountAppearance({ explicit: 'editorial', mode: 'dark' }, 5, g.impl, keys('first_key_1', 'second_key2'));
  assert.equal(plain.result.kind, 'error'); assert.match(plain.result.message, /lost again/); assert.equal(g.calls.length, 4);
});
test('review regression: nothing escapes syncAccountAppearance (fetch that throws synchronously, re-read that throws, invalid intent)', async () => {
  const sync = () => { throw new Error('boom'); };
  const out = await syncAccountAppearance({ explicit: 'editorial', mode: 'dark' }, 1, sync, keys('first_key_1'));
  assert.equal(out.result.kind, 'error'); assert.match(out.result.message, /boom/);
  const bad = await syncAccountAppearance({ explicit: 'signature', mode: 'dark' }, 1, async () => json(200, account(2)), keys('first_key_1'));
  assert.equal(bad.result.kind, 'error'); assert.match(bad.result.message, /intent/);
});

test('review regression: an identity change during a sync stops every later internal request (retry, 409 re-read, re-apply) and ends in a plain superseded outcome', async () => {
  let current = 1; const guard = { shouldContinue: () => current === 1 };
  // 409 arrives, then the identity changes before the re-read: no re-read, no re-apply.
  let f = fetchScript([json(409, {})]); let out = await syncAccountAppearance({ explicit: null, mode: 'dark' }, 3, (u, i) => { const r = f.impl(u, i); current = 2; return r; }, keys('first_key_1', 'second_key2'), guard);
  assert.equal(out.result.kind, 'error'); assert.match(out.result.message, /superseded/); assert.equal(f.calls.length, 1);
  // transport loss, then the identity changes before the same-key retry: no retry.
  current = 1; f = fetchScript([new TypeError('lost')]); out = await syncAccountAppearance({ explicit: null, mode: 'dark' }, 3, (u, i) => { current = 2; return f.impl(u, i); }, keys('first_key_1'), guard);
  assert.equal(out.result.kind, 'error'); assert.equal(f.calls.length, 1);
  // re-read succeeds for the NEW account, identity changed meanwhile: the old intent is never re-applied.
  current = 1; f = fetchScript([json(409, {}), json(200, account(9))]); out = await syncAccountAppearance({ explicit: null, mode: 'dark' }, 3, (u, i) => { const r = f.impl(u, i); if (f.calls.length === 2) current = 2; return r; }, keys('first_key_1', 'second_key2'), guard);
  assert.equal(out.result.kind, 'error'); assert.match(out.result.message, /superseded/); assert.equal(f.calls.length, 2); assert.equal(f.calls.filter(c => c.init.method === 'POST').length, 1);
  // an aborted signal is honoured before the first request
  const ac = new AbortController(); ac.abort(); const g = fetchScript([json(200, account(2))]);
  out = await syncAccountAppearance({ explicit: null, mode: 'dark' }, 1, g.impl, keys('first_key_1'), { signal: ac.signal }); assert.equal(out.result.kind, 'error'); assert.equal(g.calls.length, 0);
  const read = await readAccountAppearance(g.impl, { signal: ac.signal }); assert.equal(read.kind, 'error'); assert.equal(g.calls.length, 0);
});
