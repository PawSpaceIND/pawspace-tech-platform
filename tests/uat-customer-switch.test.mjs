import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
import { world } from './helpers/execution-harness.mjs';
installWorkersHooks('__UAT_CUSTOMER_DB__', '__UAT_CUSTOMER_ENV__');
const { GET, POST } = await import('../app/api/uat-customer-switch/route.ts');
const { resolvePlatformSession, issuePlatformSession } = await import('../lib/platform-session.ts');
const { resolveActor, requireCustomerOwnership, requirePermission } = await import('../lib/server-auth.ts');
const { ensureCustomerAccountTables } = await import('../lib/customer-account.ts');
const { upsertIdentityBinding } = await import('../lib/identity-binding.ts');
const { uatCustomerTestingEnabled } = await import('../lib/uat-customer-testing.ts');
const account = await import('../app/api/customer-account/route.ts');
const profile = await import('../app/api/customer-profile/route.ts');
const origin = 'https://pawspace-staging.karthik-fce.workers.dev';
const code = 'test-customer-access-local-fixture-only';
const env = () => ({ PAWSPACE_UAT_LOGIN: 'on', PAWSPACE_UAT_SIGNING_KEY: 'fixture-signing-key-only-not-a-real-secret', PAWSPACE_UAT_ACCESS_CODE: code,
  PAWSPACE_UAT_PERSONAS: 'on', PAWSPACE_DEPLOYMENT_ENV: 'staging', PAWSPACE_PAYMENT_ENV: 'sandbox', PAWSPACE_PAYMENT_LIVE_APPROVED: 'false', FORBID_PRODUCTION: 'true' });
function fresh(t, overrides = {}) { const runtime = { ...env(), ...overrides }; const w = world('__UAT_CUSTOMER_DB__', '__UAT_CUSTOMER_ENV__', runtime); t.after(() => w.sqlite.close()); return { ...w, runtime }; }
const request = (body = { code, persona: 'customer-a' }, host = origin, headers = {}) => new Request(host + '/api/uat-customer-switch', {
  method: 'POST', headers: { 'content-type': 'application/json', origin: host, ...headers }, body: JSON.stringify(body),
});
async function login(persona = 'customer-a') {
  const response = await POST(request({ code, persona })); assert.equal(response.status, 200, await response.clone().text());
  const cookie = response.headers.getSetCookie().find(value => value.startsWith('pawspace_identity_session=')).split(';')[0];
  return { response, cookie, req: new Request(origin + '/api/customer-account', { headers: { cookie } }) };
}
const noSessions = w => { const exists = w.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='platform_identity_sessions'").get(); assert.equal(exists ? w.sqlite.prepare('SELECT COUNT(*) n FROM platform_identity_sessions').get().n : 0, 0); };
for (const [key, value] of Object.entries({ PAWSPACE_UAT_PERSONAS: 'off', PAWSPACE_DEPLOYMENT_ENV: 'production', PAWSPACE_PAYMENT_ENV: 'live', PAWSPACE_PAYMENT_LIVE_APPROVED: 'true', FORBID_PRODUCTION: 'false', PAWSPACE_UAT_LOGIN: 'off', PAWSPACE_UAT_SIGNING_KEY: 'short' })) {
  test(`test issuer refuses unsafe ${key}`, async t => { const w = fresh(t, { [key]: value }); assert.equal((await POST(request())).status, 404); assert.equal((await GET(new Request(origin))).status, 404); noSessions(w); });
}
for (const host of ['https://app.pawspace.in', 'https://pawspace-staging.karthik-fce.workers.dev.evil.test', 'http://pawspace-staging.karthik-fce.workers.dev']) {
  test(`test issuer refuses unapproved origin ${host}`, async t => { const w = fresh(t); assert.equal((await POST(request(undefined, host))).status, 404); noSessions(w); });
}
test('switch requires access code, exact persona and same-origin write', async t => {
  const w = fresh(t);
  assert.equal((await POST(request({ persona: 'customer-a' }))).status, 401);
  assert.equal((await POST(request({ code: 'wrong', persona: 'customer-a' }))).status, 401);
  assert.equal((await POST(request({ code, persona: 'real-customer-id' }))).status, 400);
  assert.equal((await POST(request(undefined, origin, { origin: 'https://untrusted.test' }))).status, 403);
  assert.equal((await POST(request(undefined, origin, { origin: '' }))).status, 403); noSessions(w);
});
test('absent test flag fails closed', async t => {
  const w = fresh(t, { PAWSPACE_UAT_PERSONAS: undefined }); assert.equal((await POST(request())).status, 404); noSessions(w);
});
test('listing contains only fixed keys and names, no phone or credential', async t => {
  fresh(t); const result = await GET(new Request(origin)), body = await result.json();
  assert.equal(body.enabled, true); assert.deepEqual(body.personas.map(p => p.key), ['customer-a', 'customer-b']);
  assert.deepEqual(Object.keys(body.personas[0]).sort(), ['key', 'name']); assert.equal(result.headers.get('cache-control'), 'no-store');
});
test('local e2e opt-in cannot activate a remote e2e environment', () => {
  assert.equal(uatCustomerTestingEnabled(new Request('http://localhost:4185'), { ...env(), PAWSPACE_DEPLOYMENT_ENV: 'e2e' }), true);
  assert.equal(uatCustomerTestingEnabled(new Request(origin), { ...env(), PAWSPACE_DEPLOYMENT_ENV: 'e2e' }), false);
});
test('synthetic session is customer-only, audited, bounded and never grants marketing consent', async t => {
  const w = fresh(t), { response, req } = await login(), actor = await resolveActor(req);
  assert.equal(actor.roleCode, 'customer'); assert.equal(actor.identitySource, 'uat_persona'); assert.equal(actor.developmentPreview, false);
  assert.ok(!actor.permissions.includes('*'));
  assert.throws(() => requirePermission(actor, 'customers.manage'), error => error instanceof Response && error.status === 403);
  await requireCustomerOwnership(w.db, actor, 'UAT-AUDIT-CUSTOMER-A');
  await assert.rejects(() => requireCustomerOwnership(w.db, actor, 'UAT-AUDIT-CUSTOMER-B'), error => error instanceof Response && error.status === 403);
  const row = w.sqlite.prepare('SELECT * FROM canonical_customers').get();
  assert.equal(row.source, 'uat_audit_fixture'); assert.equal(JSON.parse(row.consent_json).marketing, false); assert.equal(JSON.parse(row.consent_json).whatsapp, false);
  const binding = w.sqlite.prepare('SELECT * FROM identity_bindings').get();
  assert.equal(binding.identity_source, 'uat_persona'); assert.equal(JSON.parse(binding.metadata_json).phoneOwnershipVerified, false);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM platform_identity_session_audit WHERE action='issued'").get().n, 1);
  const cookies = response.headers.getSetCookie();
  assert.ok(cookies.some(cookie => cookie.startsWith('pawspace_uat=;') && cookie.includes('Max-Age=0')));
  const sessionCookie = cookies.find(cookie => cookie.startsWith('pawspace_identity_session='));
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=86400']) assert.ok(sessionCookie.includes(attr));
  assert.ok((await resolvePlatformSession(w.db, req)).expiresAt <= Date.now() + 86_400_000);
});
test('switching test access off immediately denies both session and profile reads', async t => {
  const w = fresh(t), { req } = await login(); assert.ok(await resolvePlatformSession(w.db, req));
  w.runtime.PAWSPACE_UAT_PERSONAS = 'off'; assert.equal(await resolvePlatformSession(w.db, req), null); assert.equal((await profile.GET(req)).status, 401);
});
test('expired test session is refused', async t => { const w = fresh(t), { req } = await login(); w.sqlite.prepare('UPDATE platform_identity_sessions SET expires_at=?').run(Date.now() - 1); assert.equal(await resolvePlatformSession(w.db, req), null); });
test('repeat login supersedes the old session without duplicating customer', async t => {
  const w = fresh(t), a = await login(), b = await login(); assert.equal(await resolvePlatformSession(w.db, a.req), null); assert.ok(await resolvePlatformSession(w.db, b.req));
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM canonical_customers').get().n, 1);
});
test('test session cannot resolve on a production host with matching DB', async t => {
  const w = fresh(t), { cookie } = await login(); assert.equal(await resolvePlatformSession(w.db, new Request('https://app.pawspace.in/api/customer-account', { headers: { cookie } })), null);
});
for (const collision of ['source', 'phone']) test(`existing ${collision} conflict is refused without modifying the record`, async t => {
  const w = fresh(t); await ensureCustomerAccountTables(w.db);
  const id = collision === 'source' ? 'UAT-AUDIT-CUSTOMER-A' : 'ANOTHER-CUSTOMER';
  w.sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,'blr','Existing Customer','9000000841','customer_app_otp','{}',0,0)").run(id);
  assert.equal((await POST(request())).status, 409); noSessions(w); assert.equal(w.sqlite.prepare('SELECT name FROM canonical_customers WHERE id=?').get(id).name, 'Existing Customer');
});
test('unsigned customer-account self-service read returns V2 customer sign-in guidance, not staff staging-login copy', async t => {
  fresh(t);
  const response = await account.GET(new Request(origin + '/api/customer-account'));
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error, 'A verified customer sign-in is required. Sign in and try again.');
  assert.equal(body.signInUrl, undefined);
  assert.doesNotMatch(body.error, /staging-login/i);
});

test('account and profile resolve from actual session and refuse another customer scope', async t => {
  fresh(t); const { req, cookie } = await login(); const read = await account.GET(req); assert.equal(read.status, 200, await read.clone().text());
  assert.equal((await account.GET(new Request(origin + '/api/customer-account?customerId=another-customer', { headers: { cookie } }))).status, 403);
  const result = await profile.GET(new Request(origin + '/api/customer-profile?customerId=another-customer', { headers: { cookie } }));
  assert.equal(result.status, 200); assert.equal((await result.json()).data.customerId, 'UAT-AUDIT-CUSTOMER-A'); assert.equal(result.headers.get('cache-control'), 'no-store');
});
test('normal profile edits preserve ability to revisit the synthetic fixture', async t => {
  fresh(t); const { cookie } = await login();
  const save = await account.POST(new Request(origin + '/api/customer-account', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'update_profile', idempotencyKey: 'persona-profile-edit', profile: { name: 'Edited Test Customer' } }) }));
  assert.equal(save.status, 201, await save.clone().text()); const next = await login(); assert.equal((await next.response.json()).data.customerName, 'Edited Test Customer');
});
test('real Worker gateway reaches the test issuer before login, whose own locks remain authoritative', async t => {
  const w = fresh(t), { authorizeApiRequest } = await import('../lib/api-gateway.ts'), { authorizePlatformSessionRequest } = await import('../lib/session-api-gateway.ts');
  for (const flag of ['on', 'off']) {
    w.runtime.PAWSPACE_UAT_PERSONAS = flag; const req = request(); assert.equal(await authorizePlatformSessionRequest(req, w.db), null);
    const access = await authorizeApiRequest(req, { DB: w.db, ...w.runtime }); assert.equal(access instanceof Response, false); assert.equal(access.permission, null); assert.deepEqual(access.actor.permissions, []);
    assert.equal((await POST(req)).status, flag === 'on' ? 200 : 404);
  }
});
for (const subjectType of ['customer', 'provider']) test(`profile reconstruction preserves ordinary ${subjectType} session boundary`, async t => {
  const w = fresh(t); await ensureCustomerAccountTables(w.db);
  w.sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES ('NORMAL-CUSTOMER','blr','Normal Test Customer','9000000888','customer_app_otp','{}',0,0)").run();
  const identitySource = subjectType === 'customer' ? 'customer_otp' : 'partner_otp';
  const binding = await upsertIdentityBinding(w.db, { identitySource, principalType: 'identity_subject', principalKey: '9000000888', subjectType, subjectId: 'NORMAL-CUSTOMER', verificationState: 'verified', actorId: 'fixture', reason: 'isolated regression' });
  const issued = await issuePlatformSession(w.db, { bindingId: binding.id, identitySource, principalType: 'identity_subject', principalKey: '9000000888', subjectType, subjectId: 'NORMAL-CUSTOMER' });
  w.runtime.PAWSPACE_UAT_PERSONAS = 'off';
  const response = await profile.GET(new Request(origin + '/api/customer-profile', { headers: { cookie: `pawspace_identity_session=${issued.token}` } }));
  assert.equal(response.status, subjectType === 'customer' ? 200 : 401);
  if (subjectType === 'customer') assert.deepEqual((await response.json()).data, { customerId: 'NORMAL-CUSTOMER', customerName: 'Normal Test Customer', phone: '9000000888' });
});
test('profile does not accept an identity header or customer id without a platform session', async t => {
  fresh(t); const response = await profile.GET(new Request(origin + '/api/customer-profile?customerId=UAT-AUDIT-CUSTOMER-A', { headers: { 'oai-authenticated-user-email': 'founder@pawspace.in' } })); assert.equal(response.status, 401);
});
