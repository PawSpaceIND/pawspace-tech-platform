import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { installWorkersHooks, runWithWorkersDb } from './helpers/module-hooks.mjs';
import { d1 } from './helpers/execution-harness.mjs';
installWorkersHooks('__APPEARANCE_DB__');
const { readAccountAppearance, mutateAccountAppearance, resolveRequestAppearance, appearanceCookieValue } = await import('../lib/appearance-preferences.ts');
const { GET, POST } = await import('../app/api/appearance/route.ts');
const { issuePlatformSession, platformSessionCookie, revokePlatformSession } = await import('../lib/platform-session.ts');
const { upsertIdentityBinding } = await import('../lib/identity-binding.ts');
const { parseAppearanceRecord } = await import('../app/components/appearance-resolver.ts');
const { requiredPermission } = await import('../lib/api-gateway.ts');
const origin = 'https://pawspace.test';
const subject = { subjectType: 'customer', subjectId: 'owner-one' };
const input = (version = 1, key = 'request-key-0001', explicit = 'concierge', mode = 'dark') => ({ action: 'set', record: { explicit, mode }, expectedRecordVersion: version, idempotencyKey: key });
function fresh() { const sqlite = new DatabaseSync(':memory:'); return { sqlite, db: d1(sqlite) }; }
async function session(db, subjectType = 'customer', subjectId = 'owner-one') {
  const identitySource = subjectType === 'customer' ? 'customer_otp' : 'partner_otp';
  const binding = await upsertIdentityBinding(db, { identitySource, principalType: 'identity_subject', principalKey: subjectId, subjectType, subjectId, actorId: 'test', reason: 'synthetic fixture' });
  const issued = await issuePlatformSession(db, { bindingId: binding.id, identitySource, principalType: 'identity_subject', principalKey: subjectId, subjectType, subjectId });
  return platformSessionCookie(issued.token, issued.ttlSeconds).split(';')[0];
}
function request(cookie, body, method = 'POST', headers = {}) { return new Request(origin + '/api/appearance', { method, headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) }); }
test('migration preserves valid explicit/mode/legacy; server assigns eligible default once and account wins on another device', async () => {
  const { db } = fresh();
  const first = await readAccountAppearance(db, subject, { cookieValue: 'v1.concierge.concierge.dark.theme~signature~style~cartoon', adminDefault: 'concierge', conciergeAvailable: false });
  assert.deepEqual(first.record, { version: '1', explicit: 'concierge', assigned: 'editorial', mode: 'dark', legacy: 'theme~signature~style~cartoon' });
  assert.equal(first.snapshot.effective, 'editorial');
  const later = await readAccountAppearance(db, subject, { cookieValue: 'v1.editorial.editorial.light.-', adminDefault: 'concierge', conciergeAvailable: true });
  assert.deepEqual(later.record, first.record);
  assert.equal(later.snapshot.effective, 'concierge');
  const changed = await mutateAccountAppearance(db, subject, input(1, 'mode-only-request', 'concierge', 'system'), { conciergeAvailable: false });
  assert.equal(changed.data.record.explicit, 'concierge');
  assert.equal(changed.data.snapshot.effective, 'editorial');
});
test('concurrent initial resolutions assign exactly once', async () => {
  const { db, sqlite } = fresh();
  const results = await Promise.all([readAccountAppearance(db, subject, { adminDefault: 'editorial', conciergeAvailable: true }), readAccountAppearance(db, subject, { adminDefault: 'concierge', conciergeAvailable: true })]);
  assert.deepEqual(results[0].record, results[1].record);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM appearance_preferences').get().n, 1);
});
test('two concurrent CAS updates have one winner and one 409 without a lost update or orphan audit', async () => {
  const { db, sqlite } = fresh();
  await readAccountAppearance(db, subject);
  const results = await Promise.allSettled([mutateAccountAppearance(db, subject, input(1, 'concurrent-one', 'editorial', 'light')), mutateAccountAppearance(db, subject, input(1, 'concurrent-two', 'concierge', 'dark'))]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.status, 409);
  const after = await readAccountAppearance(db, subject);
  assert.equal(after.recordVersion, 2);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM appearance_preference_mutations').get().n, 1);
  const receipt = sqlite.prepare('SELECT * FROM appearance_preference_mutations').get();
  assert.deepEqual(JSON.parse(receipt.after_json), after.record);
});
test('idempotent retry cannot apply twice; key reuse with changed payload conflicts; scope includes subject', async () => {
  const { db, sqlite } = fresh();
  await mutateAccountAppearance(db, subject, input());
  assert.equal((await mutateAccountAppearance(db, subject, input())).duplicatePrevented, true);
  await assert.rejects(mutateAccountAppearance(db, subject, input(1, 'request-key-0001', 'editorial')), error => error.status === 409);
  const other = { subjectType: 'provider', subjectId: subject.subjectId };
  assert.equal((await mutateAccountAppearance(db, other, input())).data.recordVersion, 2);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM appearance_preferences').get().n, 2);
});
test('old idempotent retries return the current account and cannot regress the cookie', async () => {
  const { db } = fresh();
  await mutateAccountAppearance(db, subject, input());
  await mutateAccountAppearance(db, subject, input(2, 'next-request-0002', 'editorial', 'light'));
  const retry = await mutateAccountAppearance(db, subject, input());
  assert.equal(retry.duplicatePrevented, true);
  assert.equal(retry.data.recordVersion, 3);
  assert.equal(retry.data.record.explicit, 'editorial');
});
test('concurrent identical retries are applied once and report the duplicate', async () => {
  const { db, sqlite } = fresh();
  await readAccountAppearance(db, subject);
  const results = await Promise.all([mutateAccountAppearance(db, subject, input()), mutateAccountAppearance(db, subject, input())]);
  assert.equal(results.filter(result => result.duplicatePrevented).length, 1);
  assert.equal((await readAccountAppearance(db, subject)).recordVersion, 2);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM appearance_preference_mutations').get().n, 1);
});
test('transaction failure rolls back preference and audit receipt', async () => {
  const { db, sqlite } = fresh();
  await readAccountAppearance(db, subject);
  sqlite.exec("CREATE TRIGGER refuse_appearance BEFORE UPDATE ON appearance_preferences BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  await assert.rejects(mutateAccountAppearance(db, subject, input()));
  assert.equal((await readAccountAppearance(db, subject)).recordVersion, 1);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM appearance_preference_mutations').get().n, 0);
});
test('rate limit is transactional, subject scoped, and idempotent retries remain usable', async () => {
  const { db, sqlite } = fresh();
  for (let i = 0; i < 30; i++) await mutateAccountAppearance(db, subject, input(i + 1, `rate-request-${i}`));
  await assert.rejects(mutateAccountAppearance(db, subject, input(31, 'rate-over-limit')), error => error.status === 429);
  assert.equal((await mutateAccountAppearance(db, subject, input(1, 'rate-request-0'))).duplicatePrevented, true);
  assert.equal((await mutateAccountAppearance(db, { ...subject, subjectId: 'other' }, input())).data.recordVersion, 2);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM appearance_preference_mutations WHERE subject_id=?').get(subject.subjectId).n, 30);
});
test('real session route rejects unauthenticated, forged-subject, malformed and unsupported values without writes', async () => {
  const { db, sqlite } = fresh();
  await runWithWorkersDb(db, async () => {
    assert.equal((await GET(request(null, null, 'GET'))).status, 401);
    assert.equal((await POST(request(null, input()))).status, 401);
    const cookie = await session(db);
    await GET(request(cookie, null, 'GET'));
    const invalid = [null, [], 1, '{', { ...input(), subjectId: 'victim' }, { ...input(), subjectType: 'provider' }, { ...input(), customerId: 'victim' }, { ...input(), record: { explicit: 'emerald', mode: 'dark' } }, { ...input(), record: { explicit: '\u2603', mode: 'dark' } }, { ...input(), record: { explicit: 'concierge;admin=true', mode: 'dark' } }, { ...input(), record: { explicit: 'x'.repeat(241), mode: 'dark' } }, { ...input(), record: { explicit: 'editorial', mode: 'auto' } }, { ...input(), record: { explicit: 'editorial' } }, { ...input(), record: { explicit: 'editorial', mode: 'dark', assigned: 'concierge' } }, { ...input(), expectedRecordVersion: 0 }, { ...input(), expectedRecordVersion: 1.5 }, { ...input(), idempotencyKey: '\u2603bad-key' }, { ...input(), record: 'v1.-.editorial.system.-' }];
    for (const value of invalid) {
      const response = await POST(request(cookie, value));
      assert.equal(response.status, 400, JSON.stringify(value));
      assert.equal(response.headers.has('set-cookie'), false);
    }
    assert.equal(sqlite.prepare('SELECT record_version FROM appearance_preferences').get().record_version, 1);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM appearance_preference_mutations').get().n, 0);
    assert.equal((await POST(request(cookie, input(), 'POST', { origin: 'https://evil.test' }))).status, 403);
    assert.equal((await POST(request(cookie, input(), 'POST', { 'sec-fetch-site': 'cross-site' }))).status, 403);
  });
});
test('route cookie matches exact response; another customer/provider cannot read or change owner record', async () => {
  const { db } = fresh();
  await runWithWorkersDb(db, async () => {
    const cookie = await session(db);
    const response = await POST(request(cookie, input()));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.data.accountAuthoritative, true);
    assert.equal(result.data.recordVersion, 2);
    const token = response.headers.get('set-cookie').split(';')[0].split('=')[1];
    assert.deepEqual(parseAppearanceRecord(token).record, result.data.record);
    for (const [kind, id] of [['customer', 'owner-two'], ['provider', 'owner-one']]) {
      const otherCookie = await session(db, kind, id);
      const other = await (await GET(request(otherCookie, null, 'GET'))).json();
      assert.equal(other.data.recordVersion, 1);
      assert.equal(other.data.record.explicit, null);
    }
    assert.equal((await readAccountAppearance(db, subject)).recordVersion, 2);
  });
});
test('GET query rejection follows authentication and never initializes or mutates appearance', async () => {
  const { db, sqlite } = fresh();
  await runWithWorkersDb(db, async () => {
    for (const query of ['?subjectId=victim', '?subjectType=provider', '?unknown=value']) {
      const anonymous = await GET(new Request(origin + '/api/appearance' + query));
      assert.equal(anonymous.status, 401);
      assert.equal(anonymous.headers.has('set-cookie'), false);
    }
    const cookie = await session(db);
    const signedIn = await GET(new Request(origin + '/api/appearance?subjectId=victim', { headers: { cookie } }));
    assert.equal(signedIn.status, 400);
    assert.equal(signedIn.headers.has('set-cookie'), false);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('appearance_preferences','appearance_preference_mutations')").get().n, 0);
    await GET(request(cookie, null, 'GET'));
    const before = sqlite.prepare('SELECT * FROM appearance_preferences').get();
    assert.equal((await GET(new Request(origin + '/api/appearance?subjectId=victim', { headers: { cookie } }))).status, 400);
    assert.deepEqual(sqlite.prepare('SELECT * FROM appearance_preferences').get(), before);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM appearance_preference_mutations').get().n, 0);
  });
});
test('logout and revoked session keep device fallback and cannot mutate account', async () => {
  const { db } = fresh();
  await runWithWorkersDb(db, async () => {
    const cookie = await session(db);
    await POST(request(cookie, input()));
    await revokePlatformSession(db, request(cookie, null, 'GET'), 'user_logout');
    assert.equal((await POST(request(cookie, input(2, 'after-logout')))).status, 401);
    const fallback = await resolveRequestAppearance(db, request(cookie + '; pawspace-appearance=v1.editorial.editorial.light.-', null, 'GET'));
    assert.equal(fallback.accountAuthoritative, false);
    assert.equal(fallback.recordVersion, null);
    assert.equal(fallback.snapshot.mode, 'light');
    assert.equal((await readAccountAppearance(db, subject)).record.explicit, 'concierge');
  });
});
test('signed-in first paint is account authoritative; expired session cannot read or write; sign-in restores the same choice', async () => {
  const { db, sqlite } = fresh();
  await runWithWorkersDb(db, async () => {
    const cookie = await session(db);
    await POST(request(cookie, input()));
    const painted = await resolveRequestAppearance(db, request(cookie + '; pawspace-appearance=v1.editorial.editorial.light.-', null, 'GET'));
    assert.equal(painted.accountAuthoritative, true);
    assert.equal(painted.record.explicit, 'concierge');
    assert.equal(painted.snapshot.mode, 'dark');
    sqlite.exec('UPDATE platform_identity_sessions SET expires_at=1');
    assert.equal((await GET(request(cookie, null, 'GET'))).status, 401);
    assert.equal((await POST(request(cookie, input(2, 'expired-request')))).status, 401);
    const freshCookie = await session(db);
    const restored = await (await GET(request(freshCookie, null, 'GET'))).json();
    assert.equal(restored.data.record.explicit, 'concierge');
    assert.equal(restored.data.recordVersion, 2);
  });
});
test('database/session failure and corrupt row fall back safely without replacing saved preferences', async () => {
  const { db, sqlite } = fresh();
  await runWithWorkersDb(db, async () => {
    const cookie = await session(db);
    await readAccountAppearance(db, subject);
    sqlite.exec('PRAGMA ignore_check_constraints=ON');
    sqlite.exec("UPDATE appearance_preferences SET assigned_theme='bad'");
    const response = await GET(request(cookie, null, 'GET'));
    assert.equal(response.status, 503);
    assert.equal(response.headers.has('set-cookie'), false);
    const resolved = await resolveRequestAppearance(db, request(cookie, null, 'GET'), { cookieValue: 'v1.editorial.editorial.dark.-' });
    assert.equal(resolved.accountAuthoritative, false);
    assert.equal(resolved.snapshot.mode, 'dark');
    assert.equal(sqlite.prepare('SELECT assigned_theme FROM appearance_preferences').get().assigned_theme, 'bad');
    const broken = { prepare() { throw Error('private database detail'); }, batch() { throw Error('private database detail'); } };
    const unavailable = await resolveRequestAppearance(broken, request(cookie, null, 'GET'), { cookieValue: 'malformed;draft' });
    assert.equal(unavailable.snapshot.effective, 'editorial');
    assert.equal(unavailable.accountAuthoritative, false);
  });
});
test('migration executes locally and malformed/duplicate device cookies use safe defaults', async () => {
  const { db, sqlite } = fresh();
  sqlite.exec(readFileSync(new URL('../migrations/appearance-preferences.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/appearance-preferences.sql', import.meta.url), 'utf8'));
  assert.equal((await readAccountAppearance(db, subject, { cookieValue: 'v1.editorial.editorial.system.theme~signature~style', adminDefault: 'editorial' })).record.explicit, null);
  const duplicate = appearanceCookieValue(request('pawspace-appearance=v1.concierge.editorial.dark.-; pawspace-appearance=v1.editorial.editorial.light.-', null, 'GET'));
  assert.equal(parseAppearanceRecord(duplicate).invalid, true);
});
test('gateway exemption is exact GET/POST only and does not grant adjacent routes or unsupported methods', async () => {
  for (const method of ['GET', 'POST']) assert.equal(await requiredPermission(request(null, input(), method)), null);
  for (const method of ['DELETE', 'PUT', 'PATCH']) assert.notEqual(await requiredPermission(new Request(origin + '/api/appearance', { method })), null);
  assert.notEqual(await requiredPermission(new Request(origin + '/api/appearance/other')), null);
});
