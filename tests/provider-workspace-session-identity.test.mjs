import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// resolveProviderForActor is handed actor.email, and two different identities arrive there.
//
// A staff login carries a real address, resolved through the legacy provider_identity_links table.
// A provider-scoped platform session carries no address at all: resolvePrimaryActor sets its email to
// the session auditId, `${subject_type}:${subject_id}`. The seeded table holds staff addresses only,
// so before this fix such a session resolved to nothing and /api/provider-workspace answered
// {linked:false} on GET and 403 on POST -- which the Partner App calls, so a tester who had switched
// provider lost the workspace tab.
//
// The end-to-end case below drives the REAL UAT switch and the REAL resolvePrimaryActor, then feeds
// the resulting actor.email to the resolver, so it fails if any link in that chain changes shape
// rather than only if this one function does. It deliberately sends no staff cookie: the fix stands
// on its own and does not depend on anything that clears one.
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

const ORIGIN = "https://uat.pawspace.test";
const GOOD_KEY = "k".repeat(32);
const GOOD_CODE = "c".repeat(32);
const OPEN = { PAWSPACE_UAT_LOGIN: "on", PAWSPACE_UAT_SIGNING_KEY: GOOD_KEY, PAWSPACE_UAT_ACCESS_CODE: GOOD_CODE };

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db, ...OPEN };
  const auth = await import("../lib/server-auth.ts");
  await auth.ensureSecurityTables(db); // creates provider_identity_links
  return { sqlite, db };
}

const resolver = async () => (await import("../lib/provider-workspace.ts")).resolveProviderForActor;

// --- the provider-session identity --------------------------------------------------------------

test("a provider session audit identity resolves to its own provider", async () => {
  const { db } = await world();
  const resolveProviderForActor = await resolver();
  assert.equal(await resolveProviderForActor(db, "provider:uatcap_groom_south"), "uatcap_groom_south");
});

test("the provider id is taken verbatim, not case-folded", async () => {
  // The legacy branch lowercases because addresses are case-insensitive. A provider id is not, so the
  // session form has to be matched before that happens or a mixed-case id resolves to a different one.
  const { db } = await world();
  const resolveProviderForActor = await resolver();
  assert.equal(await resolveProviderForActor(db, "provider:UatCap_Groom_South"), "UatCap_Groom_South");
});

test("a customer session does not resolve to a provider", async () => {
  // It must fall through to the address branch and find nothing, never be read as a provider subject.
  const { db } = await world();
  const resolveProviderForActor = await resolver();
  assert.equal(await resolveProviderForActor(db, "customer:cust_123"), null);
});

test("a bare or malformed identity still resolves to nothing", async () => {
  const { db } = await world();
  const resolveProviderForActor = await resolver();
  for (const value of ["", "   ", "provider:", "provider", "notprovider:x"]) {
    assert.equal(await resolveProviderForActor(db, value), null, `${JSON.stringify(value)} must not resolve`);
  }
});

// --- the staff-address identity is untouched ------------------------------------------------------

test("a seeded staff address still resolves through provider_identity_links", async () => {
  const { sqlite, db } = await world();
  const resolveProviderForActor = await resolver();
  const now = Date.now();
  sqlite.prepare("INSERT INTO provider_identity_links (email,provider_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)")
    .run("asha.groomer1@tkpetcare.in", "uatcap_groom_ft", now, now);

  assert.equal(await resolveProviderForActor(db, "asha.groomer1@tkpetcare.in"), "uatcap_groom_ft");
  assert.equal(await resolveProviderForActor(db, "ASHA.Groomer1@TKPetCare.in"), "uatcap_groom_ft", "addresses stay case-insensitive");
  assert.equal(await resolveProviderForActor(db, "nobody@pawspace.test"), null, "an unlinked address resolves to no provider");
});

test("an inactive link is still refused", async () => {
  const { sqlite, db } = await world();
  const resolveProviderForActor = await resolver();
  const now = Date.now();
  sqlite.prepare("INSERT INTO provider_identity_links (email,provider_id,status,verified_at,updated_at) VALUES (?,?,'revoked',?,?)")
    .run("revoked@tkpetcare.in", "uatcap_groom_ft", now, now);
  assert.equal(await resolveProviderForActor(db, "revoked@tkpetcare.in"), null);
});

// --- end to end, through the real switch and the real actor ---------------------------------------

test("a session minted by the UAT switch resolves to the provider it was switched to", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db, ...OPEN };

  const auth = await import("../lib/server-auth.ts");
  await auth.ensureSecurityTables(db);
  const capacity = await import("../lib/provider-capacity-governance.ts");
  await capacity.ensureProviderCapacityTables(db);
  await capacity.seedProviderCapacityDefaults(db);
  const binding = await import("../lib/identity-binding.ts");
  await binding.ensureIdentityBindingTables(db);
  const platform = await import("../lib/platform-session.ts");
  await platform.ensurePlatformSessionTables(db);

  const providerId = String(sqlite.prepare("SELECT id FROM provider_capacity_profiles WHERE live=1 AND status='active' ORDER BY id").all()[0].id);

  const { POST } = await import("../app/api/uat-provider-switch/route.ts");
  const switched = await POST(new Request(`${ORIGIN}/api/uat-provider-switch`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ providerId, code: GOOD_CODE }),
  }));
  assert.equal(switched.status, 200, "the switch must succeed before its session means anything");

  const sessionCookie = switched.headers.getSetCookie()
    .find(item => item.startsWith("pawspace_identity_session="))
    .split(";")[0];

  // No staff cookie: this is the session on its own, exactly as the Partner App carries it.
  const actor = await auth.resolvePrimaryActor(new Request(`${ORIGIN}/api/provider-workspace`, { headers: { cookie: sessionCookie } }));
  assert.equal(actor.subjectType, "provider");

  const resolveProviderForActor = await resolver();
  assert.equal(await resolveProviderForActor(db, actor.email), providerId,
    "the Partner App workspace must resolve the provider the session is actually bound to");

  // And the table it would otherwise have consulted is genuinely empty, so this could only have come
  // from the session itself rather than from a lucky seeded row.
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_identity_links").get().n, 0);
});
