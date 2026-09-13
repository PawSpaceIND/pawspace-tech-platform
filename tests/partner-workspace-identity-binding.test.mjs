import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// Session -> provider binding for the Partner app workspace.
//
// EXECUTED, not asserted about. The Partner app signs in with OTP, which issues a platform identity
// session. resolvePrimaryActor then reports that session's actor email as the synthetic audit id
// `provider:<subjectId>` - there is no mailbox anywhere in the flow. /api/provider-workspace resolved
// the provider with an email-only lookup against provider_identity_links, so it matched nothing for
// EVERY Partner-app session: GET answered 200 with {linked:false} and no earnings key, which the
// Earnings tab rendered as a silent zero, and POST threw an ungoverned 403 that authError redacted.
//
// This drives the real chain - OTP, signed assertion, identity binding, platform session, actor - and
// then resolves the provider from it, so a regression to email-only resolution fails here.
// ---------------------------------------------------------------------------

const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); },
  };
}

/** The signing secret is obviously synthetic and local to this process. */
function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db, PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT: "not-a-real-uat-signing-secret-for-tests" };
  return { sqlite, db };
}

const mod = {
  otp: () => import("../lib/partner-otp.ts"),
  binding: () => import("../lib/identity-binding.ts"),
  session: () => import("../lib/platform-session.ts"),
  assertion: () => import("../lib/verified-identity-assertion.ts"),
  workspace: () => import("../lib/provider-workspace.ts"),
};

/**
 * Everything /api/identity-session POST does, with the repository's own functions, and then the actor
 * that lib/server-auth's resolvePrimaryActor builds from the resolved session. The synthetic audit-id
 * email is the whole point of the defect, so it is derived here rather than hand-written.
 */
async function signedInPartnerActor(db, { phone, name = "Asha Partner", cityId = "blr" }) {
  const [otp, binding, session, assertion] = await Promise.all([mod.otp(), mod.binding(), mod.session(), mod.assertion()]);
  const challenge = await otp.requestPartnerOtp(db, { phone });
  const verified = await otp.verifyPartnerOtp(db, { challengeId: challenge.challengeId, code: challenge.sandboxCode, name, cityId });

  const payload = await assertion.verifyIdentityAssertion(db, verified.assertion);
  const bound = await binding.upsertIdentityBinding(db, {
    identitySource: payload.identitySource,
    principalType: payload.principalType,
    principalKey: payload.principalKey,
    subjectType: payload.subjectType,
    subjectId: payload.subjectId,
    cityId: payload.cityId ?? null,
    verificationState: "verified",
    expiresAt: null,
    actorId: `otp_adapter:${payload.identitySource}`,
    reason: "Verified OTP identity assertion exchange",
  });
  const issued = await session.issuePlatformSession(db, {
    bindingId: String(bound.id),
    identitySource: payload.identitySource,
    principalType: payload.principalType,
    principalKey: payload.principalKey,
    subjectType: payload.subjectType,
    subjectId: payload.subjectId,
    ttlSeconds: 28_800,
  });

  const request = new Request("https://app.pawspace.test/api/provider-workspace", {
    headers: { cookie: `${session.PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}` },
  });
  const resolved = await session.resolvePlatformSession(db, request);
  assert.ok(resolved, "the OTP session must resolve; the rest of this test is meaningless otherwise");

  return {
    request,
    providerId: verified.providerId,
    bindingId: String(bound.id),
    actor: {
      email: resolved.auditId,
      name: `Provider ${resolved.subjectId}`,
      roleCode: resolved.roleCode,
      permissions: resolved.permissions,
      developmentPreview: false,
      identitySource: resolved.identitySource,
      principalType: resolved.principalType,
      principalKey: resolved.principalKey,
      subjectType: resolved.subjectType,
    },
  };
}

test("an OTP Partner-app session carries no mailbox, only a synthetic audit id", async () => {
  const { db } = fresh();
  const { actor, providerId } = await signedInPartnerActor(db, { phone: "9000000101" });

  // This is the shape the defect turned on: the actor's "email" is an audit id, not an address.
  assert.equal(actor.email, `provider:${providerId}`);
  assert.equal(actor.subjectType, "provider");
  assert.equal(actor.roleCode, "service_provider");
  assert.doesNotMatch(actor.email, /@/, "no mailbox exists anywhere in the OTP flow");
});

test("a Partner-app session resolves to its own provider, driven through the real OTP chain", async () => {
  const { db } = fresh();
  const workspace = await mod.workspace();
  const { actor, providerId } = await signedInPartnerActor(db, { phone: "9000000102" });

  // provider_identity_links is never written by this flow, so an email-only lookup matched nothing
  // and every Partner-app session read as unlinked - a silent zero on Earnings, a redacted 403 on POST.
  assert.equal(await workspace.resolveProviderForActor(db, actor.email), providerId,
    "the Partner app's own session must resolve to its own provider record");
});

test("the legacy provider_identity_links address still resolves, case-insensitively", async () => {
  const { sqlite, db } = fresh();
  const workspace = await mod.workspace();
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_identity_links (email TEXT PRIMARY KEY, provider_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', verified_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO provider_identity_links (email,provider_id,status,verified_at,updated_at) VALUES (?,?,'active',1,1)")
    .run("groomer.arun@pawspace.in", "groom_arun");

  assert.equal(await workspace.resolveProviderForActor(db, "groomer.arun@pawspace.in"), "groom_arun",
    "a workspace sign-in with no platform session must keep working through the legacy link");
  assert.equal(await workspace.resolveProviderForActor(db, "Groomer.Arun@PawSpace.in"), "groom_arun");
});

test("revocation is enforced at the session, so a revoked binding yields no actor at all", async () => {
  // The guard lives in resolvePlatformSession, which JOINs identity_bindings on EVERY request and
  // revokes the session unless the binding is still active, verified, unexpired and still pointing at
  // the same subject and principal. So by the time an actor exists its binding has just been
  // re-verified, and the session's own subject id cannot outlive a revoked binding. An earlier version
  // of this file claimed the opposite and guarded it a second time in the resolver; that was wrong,
  // and the duplicate guard is gone. This test pins the real boundary instead.
  const { db, sqlite } = fresh();
  const workspace = await mod.workspace();
  const [binding, session] = await Promise.all([mod.binding(), mod.session()]);
  const { actor, request, bindingId, providerId } = await signedInPartnerActor(db, { phone: "9000000103" });

  assert.equal(await workspace.resolveProviderForActor(db, actor.email), providerId);
  assert.ok(await session.resolvePlatformSession(db, request), "the session resolves while the binding is good");

  await binding.revokeIdentityBinding(db, { id: bindingId, actorId: "ops.one@pawspace.in", reason: "Partner offboarded" });

  assert.equal(await session.resolvePlatformSession(db, request), null,
    "a revoked binding must stop resolving the session, so no actor is ever built from it");
  assert.equal(sqlite.prepare("SELECT status FROM platform_identity_sessions WHERE binding_id=?").get(bindingId).status, "revoked",
    "the session must be marked revoked, not merely refused for this one request");
});
