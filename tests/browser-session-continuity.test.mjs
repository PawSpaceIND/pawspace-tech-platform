import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__G20_SESSION_DB__", "__G20_SESSION_ENV__");
const { upsertIdentityBinding, revokeIdentityBinding } = await import("../lib/identity-binding.ts");
const { issuePlatformSession, resolvePlatformSession, revokePlatformSession, platformSessionCookie, clearPlatformSessionCookie, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");

// Execute the real session/binding modules and their owned DDL. Only D1 transport is adapted;
// batch is one SQLite transaction, including rollback if issuance or its audit write fails.
function world(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  function statement(sql, args = []) {
    const execute = () => {
      const result = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(result.changes) } };
    };
    return {
      bind: (...values) => statement(sql, values),
      first: async () => sqlite.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
      run: async () => execute(),
      execute,
    };
  }
  const db = {
    prepare: sql => statement(sql),
    batch: async statements => {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map(item => item.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { sqlite, db };
}
function browser(token) {
  return new Request("https://pawspace.test/api/identity-session", {
    headers: { "cf-ray": crypto.randomUUID(), ...(token ? { cookie: `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(token)}` } : {}) },
  });
}
async function identity(db, subjectType = "customer", subjectId = "G20-CUSTOMER") {
  const fields = { identitySource: subjectType === "provider" ? "partner_otp" : "customer_otp", principalType: "identity_subject", principalKey: `g20:${subjectType}:${subjectId}`, subjectType, subjectId };
  const binding = await upsertIdentityBinding(db, { ...fields, actorId: "g20-regression", reason: "Isolated session continuity test", verificationState: "verified" });
  return { ...fields, bindingId: String(binding.id) };
}
const signIn = (db, subject, request = browser()) => issuePlatformSession(db, { ...subject, request });
const resolve = (db, issued) => resolvePlatformSession(db, browser(issued.token));

for (const kind of ["customer", "provider"]) {
  test(`${kind}: a second browser sign-in does not invalidate the first browser`, async t => {
    const { db } = world(t), subject = await identity(db, kind);
    const a = await signIn(db, subject), b = await signIn(db, subject);
    assert.equal((await resolve(db, a))?.subjectId, subject.subjectId);
    assert.equal((await resolve(db, b))?.subjectId, subject.subjectId);
    assert.notEqual(a.token, b.token);
  });
  test(`${kind}: same-browser re-login rotates only its presented token`, async t => {
    const { db } = world(t), subject = await identity(db, kind);
    const a = await signIn(db, subject), b = await signIn(db, subject);
    const replacement = await signIn(db, subject, browser(a.token));
    assert.equal(await resolve(db, a), null);
    assert.equal((await resolve(db, b))?.subjectId, subject.subjectId);
    assert.equal((await resolve(db, replacement))?.subjectId, subject.subjectId);
    assert.notEqual(replacement.token, a.token);
  });
}

test("concurrent independent browser sign-ins both remain valid", async t => {
  const { db } = world(t), subject = await identity(db);
  const [a, b] = await Promise.all([signIn(db, subject), signIn(db, subject)]);
  assert.ok(await resolve(db, a));
  assert.ok(await resolve(db, b));
});

test("overlapping verified exchanges cannot leave the browser with a superseded response token", async t => {
  const { db } = world(t), subject = await identity(db);
  const original = await signIn(db, subject);
  const [a, b] = await Promise.all([signIn(db, subject, browser(original.token)), signIn(db, subject, browser(original.token))]);
  assert.equal(await resolve(db, original), null);
  assert.ok(await resolve(db, a));
  assert.ok(await resolve(db, b));
});

test("explicit logout revokes only that browser and remains effective on the next request", async t => {
  const { db, sqlite } = world(t), subject = await identity(db);
  const a = await signIn(db, subject), b = await signIn(db, subject);
  assert.ok(await resolve(db, a));
  await revokePlatformSession(db, browser(a.token), "user_logout");
  assert.equal(await resolve(db, a), null);
  assert.ok(await resolve(db, b));
  assert.equal(sqlite.prepare("SELECT status FROM platform_identity_sessions WHERE id=?").get(a.session.id).status, "revoked");
});

test("session expiry is enforced server-side without extending it on activity", async t => {
  const { db, sqlite } = world(t), subject = await identity(db), a = await signIn(db, subject);
  assert.ok(await resolve(db, a));
  const before = sqlite.prepare("SELECT expires_at FROM platform_identity_sessions WHERE id=?").get(a.session.id).expires_at;
  await resolve(db, a);
  assert.equal(sqlite.prepare("SELECT expires_at FROM platform_identity_sessions WHERE id=?").get(a.session.id).expires_at, before);
  sqlite.prepare("UPDATE platform_identity_sessions SET expires_at=? WHERE id=?").run(Date.now() - 1, a.session.id);
  assert.equal(await resolve(db, a), null);
});

test("revoked identity binding blocks every browser", async t => {
  const { db } = world(t), subject = await identity(db);
  const a = await signIn(db, subject), b = await signIn(db, subject);
  await revokeIdentityBinding(db, { id: subject.bindingId, actorId: "security-test", reason: "Revoke identity" });
  assert.equal(await resolve(db, a), null);
  assert.equal(await resolve(db, b), null);
});

test("rebound identity never grants the old token access to a different subject", async t => {
  const { db, sqlite } = world(t), subject = await identity(db), a = await signIn(db, subject);
  sqlite.prepare("UPDATE identity_bindings SET subject_id='G20-OTHER' WHERE id=?").run(subject.bindingId);
  assert.equal(await resolve(db, a), null);
});

test("another subject's cookie cannot be used to revoke that subject's sessions", async t => {
  const { db } = world(t), aSubject = await identity(db, "customer", "G20-A"), bSubject = await identity(db, "customer", "G20-B");
  const a = await signIn(db, aSubject), b = await signIn(db, bSubject, browser(a.token));
  assert.equal((await resolve(db, a))?.subjectId, "G20-A");
  assert.equal((await resolve(db, b))?.subjectId, "G20-B");
});

test("unknown token authenticates nobody and cannot eject another browser during verified sign-in", async t => {
  const { db } = world(t), subject = await identity(db), a = await signIn(db, subject);
  assert.equal(await resolvePlatformSession(db, browser("invalid-token")), null);
  const b = await signIn(db, subject, browser("invalid-token"));
  assert.ok(await resolve(db, a));
  assert.ok(await resolve(db, b));
});

test("malformed cookie fails closed but does not prevent a verified sign-in", async t => {
  const { db } = world(t), subject = await identity(db), a = await signIn(db, subject);
  const malformed = new Request("https://pawspace.test/api/identity-session", { headers: { cookie: `${PLATFORM_SESSION_COOKIE}=%E0%A4%A` } });
  assert.equal(await resolvePlatformSession(db, malformed), null);
  const b = await signIn(db, subject, malformed);
  assert.ok(await resolve(db, a));
  assert.ok(await resolve(db, b));
});

test("trusted issuance without a browser request retains subject-wide replacement", async t => {
  const { db } = world(t), subject = await identity(db);
  const a = await signIn(db, subject), b = await signIn(db, subject);
  const replacement = await issuePlatformSession(db, subject);
  assert.equal(await resolve(db, a), null);
  assert.equal(await resolve(db, b), null);
  assert.ok(await resolve(db, replacement));
});

test("failed issuance rolls back token rotation and leaves the previous login usable", async t => {
  const { db, sqlite } = world(t), subject = await identity(db), a = await signIn(db, subject);
  sqlite.exec("CREATE TRIGGER g20_fail_session_audit BEFORE INSERT ON platform_identity_session_audit BEGIN SELECT RAISE(ABORT, 'g20 audit failure'); END");
  await assert.rejects(signIn(db, subject, browser(a.token)), /g20 audit failure/);
  assert.ok(await resolve(db, a));
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM platform_identity_sessions").get().n, 1);
});

test("cookie security, bounded expiry and customer/provider permissions remain unchanged", async t => {
  const { db } = world(t), customer = await identity(db), provider = await identity(db, "provider");
  const a = await issuePlatformSession(db, { ...customer, request: browser(), ttlSeconds: 1 });
  const b = await issuePlatformSession(db, { ...provider, request: browser(), ttlSeconds: 999999 });
  assert.equal(a.ttlSeconds, 900);
  assert.equal(b.ttlSeconds, 86400);
  assert.deepEqual((await resolve(db, a)).permissions, ["pricing.view", "scheduling.book"]);
  assert.equal((await resolve(db, b)).roleCode, "service_provider");
  assert.equal((await resolve(db, b)).permissions.includes("*"), false);
  assert.match(platformSessionCookie(a.token, a.ttlSeconds), /Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=900$/);
  assert.match(clearPlatformSessionCookie(), /Max-Age=0$/);
});

for (const legacyPrincipal of [false, true]) test(`UAT provider session is denied after test access is disabled (legacy principal: ${legacyPrincipal})`, async t => {
  const { db } = world(t);
  const runtime = { PAWSPACE_UAT_LOGIN: "on", PAWSPACE_UAT_SIGNING_KEY: "local-fixture-key-not-production-0123456789" };
  globalThis.__G20_SESSION_ENV__ = runtime;
  t.after(() => { delete globalThis.__G20_SESSION_ENV__; });
  let subject = await identity(db, "provider", "G20-UAT-PROVIDER");
  if (legacyPrincipal) {
    const principalKey = "uat-provider:G20-UAT-PROVIDER";
    const binding = await upsertIdentityBinding(db, { ...subject, principalKey, actorId: "fixture", reason: "Legacy UAT provider fixture" });
    subject = { ...subject, principalKey, bindingId: String(binding.id) };
  }
  const session = await issuePlatformSession(db, { ...subject, request: browser(), metadata: legacyPrincipal ? {} : { uatProviderSwitch: true } });
  const ordinary = await signIn(db, await identity(db, "provider", "G20-ORDINARY-PROVIDER"));
  assert.ok(await resolve(db, session));
  runtime.PAWSPACE_UAT_LOGIN = "off";
  assert.equal(await resolve(db, session), null);
  assert.ok(await resolve(db, ordinary));
  runtime.PAWSPACE_UAT_LOGIN = "on";
  runtime.PAWSPACE_UAT_SIGNING_KEY = "short";
  assert.equal(await resolve(db, session), null);
  assert.ok(await resolve(db, ordinary));
});
