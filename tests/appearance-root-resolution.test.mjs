import test from 'node:test'; import assert from 'node:assert/strict';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
// Executes the real client/root modules (extensionless app imports resolve through the shared hook); no backend, no network.
installWorkersHooks('__APPEARANCE_GLUE__');
const { resolveRootAppearance } = await import('../app/components/appearance-root.ts');
const { resolveAppearance } = await import('../app/components/appearance-resolver.ts');
const deviceCookie = 'v1.-.editorial.dark.-';
const accountRecord = { version: '1', explicit: 'concierge', assigned: 'editorial', mode: 'light', legacy: null };
const accountSnapshot = { ...resolveAppearance({ cookieValue: 'v1.concierge.editorial.light.-', conciergeAvailable: false }) };
function helper(answer, seen = []) { return async (db, request, options) => { seen.push({ db, url: request.url, cookie: request.headers.get('cookie'), options }); return typeof answer === 'function' ? answer() : answer; }; }

test('first paint: an authoritative account record wins over the device cookie; the root passes the snapshot through and never writes cookies', async () => {
  const seen = []; const out = await resolveRootAppearance({ cookieValue: deviceCookie, cookieHeader: `pawspace-appearance=${deviceCookie}; other=1`, trustedOrigin: () => 'https://pawspace.example', acquireDb: async () => 'DB', resolveRequestAppearance: helper({ record: accountRecord, snapshot: accountSnapshot, recordVersion: 12, accountAuthoritative: true }, seen), conciergeAvailable: false });
  assert.equal(out.source, 'account'); assert.equal(out.accountAuthoritative, true); assert.equal(out.recordVersion, 12);
  assert.equal(out.snapshot.explicit, 'concierge'); assert.equal(out.snapshot.effective, 'editorial', 'closed gate: saved Concierge retained, Editorial rendered'); assert.equal(out.snapshot.mode, 'light');
  assert.equal(seen[0].db, 'DB'); assert.equal(seen[0].url, 'https://pawspace.example/'); assert.equal(seen[0].cookie, `pawspace-appearance=${deviceCookie}; other=1`); assert.deepEqual(seen[0].options, { cookieValue: deviceCookie, conciergeAvailable: false });
  assert.equal('setCookie' in out, false);
});
test('signed out: the helper answers with the device snapshot and no authority; the root renders the device record', async () => {
  const device = resolveAppearance({ cookieValue: deviceCookie });
  const out = await resolveRootAppearance({ cookieValue: deviceCookie, cookieHeader: `pawspace-appearance=${deviceCookie}`, trustedOrigin: () => 'http://localhost:4185', acquireDb: async () => 'DB', resolveRequestAppearance: helper({ record: { version: '1', explicit: null, assigned: 'editorial', mode: 'dark', legacy: null }, snapshot: device, recordVersion: null, accountAuthoritative: false }) });
  assert.equal(out.source, 'device'); assert.equal(out.accountAuthoritative, false); assert.equal(out.recordVersion, null); assert.equal(out.snapshot.mode, 'dark');
});
test('storage fallback: database acquisition failure falls back to the existing device resolution without calling the helper', async () => {
  const seen = []; const out = await resolveRootAppearance({ cookieValue: deviceCookie, cookieHeader: '', trustedOrigin: () => 'http://localhost:4185', acquireDb: async () => { throw new Error('no binding'); }, resolveRequestAppearance: helper({}, seen) });
  assert.equal(out.source, 'device-fallback'); assert.equal(seen.length, 0); assert.deepEqual(out.snapshot, resolveAppearance({ cookieValue: deviceCookie })); assert.equal(out.recordVersion, null); assert.equal(out.accountAuthoritative, false);
});
test('an authoritative flag without a positive safe version never enables account writes', async () => {
  for (const recordVersion of [0, -3, 2.5, null, '4']) {
    const out = await resolveRootAppearance({ cookieValue: deviceCookie, cookieHeader: '', trustedOrigin: () => 'http://localhost:4185', acquireDb: async () => 'DB', resolveRequestAppearance: helper({ record: accountRecord, snapshot: accountSnapshot, recordVersion, accountAuthoritative: true }) });
    assert.equal(out.accountAuthoritative, false, String(recordVersion)); assert.equal(out.recordVersion, null);
  }
});
test('a malformed device cookie with no account still renders safe Editorial', async () => {
  const bad = 'v1;e=concierge;a=editorial;m=dark';
  const out = await resolveRootAppearance({ cookieValue: bad, cookieHeader: `pawspace-appearance=${bad}`, trustedOrigin: () => 'http://localhost:4185', acquireDb: async () => 'DB', resolveRequestAppearance: helper(() => ({ record: null, snapshot: resolveAppearance({ cookieValue: bad }), recordVersion: null, accountAuthoritative: false })) });
  assert.equal(out.snapshot.effective, 'editorial'); assert.equal(out.snapshot.invalidInput, true); assert.equal(out.source, 'device');
});

const { resolveTrustedOrigin } = await import('../app/components/appearance-root.ts');
test('review regression: an invalid trusted origin never throws; the whole root falls back to the device record', async () => {
  for (const origin of ['https://', '', null, 'javascript:alert(1)', 'http://evil.example']) {
    const seen = []; const out = await resolveRootAppearance({ cookieValue: deviceCookie, cookieHeader: `pawspace-appearance=${deviceCookie}`, trustedOrigin: () => origin, acquireDb: async () => 'DB', resolveRequestAppearance: helper({ record: accountRecord, snapshot: accountSnapshot, recordVersion: 1, accountAuthoritative: true }, seen) });
    assert.equal(out.source, 'device-fallback', String(origin)); assert.equal(out.accountAuthoritative, false); assert.deepEqual(out.snapshot, resolveAppearance({ cookieValue: deviceCookie }));
    if (origin === 'https://') assert.equal(seen.length, 0, 'the helper is not called without a trusted origin');
  }
});
test('review regression: an unexpected helper or storage rejection falls back to the device record instead of escaping', async () => {
  for (const failing of [async () => { throw new TypeError('D1_ERROR: no such table'); }, async () => { throw new Error('helper exploded'); }, async () => null, async () => ({ record: null, snapshot: null, recordVersion: 1, accountAuthoritative: true })]) {
    const out = await resolveRootAppearance({ cookieValue: deviceCookie, cookieHeader: '', trustedOrigin: () => 'https://pawspace.example', acquireDb: async () => 'DB', resolveRequestAppearance: failing });
    assert.equal(out.source, 'device-fallback'); assert.ok(out.fallbackReason); assert.deepEqual(out.snapshot, resolveAppearance({ cookieValue: deviceCookie }));
  }
  const thrower = await resolveRootAppearance({ cookieValue: deviceCookie, cookieHeader: '', trustedOrigin: () => { throw new Error('env unavailable'); }, acquireDb: async () => 'DB', resolveRequestAppearance: helper({}) });
  assert.equal(thrower.source, 'device-fallback');
});
test('trusted origin source: PAWSPACE_PUBLIC_ORIGIN (https host) is used; forwarded or host headers count only for development preview hosts', () => {
  assert.equal(resolveTrustedOrigin({ configured: 'https://pawspace.in', host: 'evil.example' }), 'https://pawspace.in');
  assert.equal(resolveTrustedOrigin({ configured: 'https://Staging.PawSpace.in:8443', host: null }), 'https://staging.pawspace.in:8443');
  for (const bad of ['http://pawspace.in', 'https://', 'https://pawspace.in/path', 'pawspace.in', 'https://a b', undefined, 42]) assert.equal(resolveTrustedOrigin({ configured: bad, host: 'pawspace.in' }), null, String(bad));
  assert.equal(resolveTrustedOrigin({ configured: '', host: 'localhost:4185' }), 'http://localhost:4185');
  assert.equal(resolveTrustedOrigin({ configured: '', host: '127.0.0.1:4185' }), 'http://127.0.0.1:4185');
  assert.equal(resolveTrustedOrigin({ configured: '', host: 'localhost.evil.example' }), null);
  assert.equal(resolveTrustedOrigin({ configured: '', host: 'localhost:4185/x' }), null);
});

test('actual config bindings provide the trusted origin to root resolution without changing staging locks', async () => {
  const {readFileSync}=await import('node:fs');
  const {runInNewContext}=await import('node:vm');
  const ts=await import('typescript');
  const source=readFileSync(new URL('../vite.config.ts',import.meta.url),'utf8');
  const parsed=ts.createSourceFile('vite.config.ts',source,ts.ScriptTarget.Latest,true);
  let initializer;
  for(const statement of parsed.statements)if(ts.isVariableStatement(statement))for(const declaration of statement.declarationList.declarations)if(declaration.name.getText(parsed)==='localBindingConfig')initializer=declaration.initializer.getText(parsed);
  assert.ok(initializer);
  const origin='https://pawspace-staging.karthik-fce.workers.dev';
  for(const configured of ['',origin]){
    const binding=runInNewContext('('+initializer+')',{process:{env:{PAWSPACE_PUBLIC_ORIGIN:configured}},d1:null,r2:null,SITE_CREATOR_PLACEHOLDER_DATABASE_ID:'fixture'});
    assert.equal(binding.vars.PAWSPACE_PUBLIC_ORIGIN,configured);
    assert.equal(resolveTrustedOrigin({configured:binding.vars.PAWSPACE_PUBLIC_ORIGIN,host:'public-untrusted.example'}),configured||null);
    assert.equal(binding.vars.PAWSPACE_PAYMENT_ENV,'sandbox');assert.equal(binding.vars.PAWSPACE_PAYMENT_LIVE_APPROVED,'false');
  }
  const stage=readFileSync(new URL('../scripts/stage-config.mjs',import.meta.url),'utf8');
  const declaration=stage.slice(stage.indexOf('cfg.vars = {'),stage.indexOf('\n};',stage.indexOf('cfg.vars = {'))+3);
  const cfg={};runInNewContext(declaration,{cfg,process:{env:{}},phoneTestsPaused:false,razorpayRelayOrigin:'',razorpayRelaySha:''});
  assert.equal(resolveTrustedOrigin({configured:cfg.vars.PAWSPACE_PUBLIC_ORIGIN,host:'public-untrusted.example'}),origin);
  assert.equal(cfg.vars.PAWSPACE_PAYMENT_ENV,'sandbox');assert.equal(cfg.vars.FORBID_PRODUCTION,'true');assert.equal(cfg.vars.PAWSPACE_PAYMENT_LIVE_APPROVED,'false');
});
