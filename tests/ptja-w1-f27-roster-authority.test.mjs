/**
 * PawSpace Total Journey Audit, Wave 1 F27 — a customer's own reserve fabricated the provider roster
 * and overrode Ops-published availability windows.
 *
 * backend/src/scheduling.ts makes published availability an eligibility RULE: a provider with no row
 * for a date is refused "No published availability on <date>", and a time outside every published
 * window is refused "Requested time is outside roster". app/api/provider-capacity-control POST
 * set_availability is the authorized Ops write path for that table (scheduling.manage, source
 * 'operations'), and backend/src/domain.ts declares the complete set of authored sources in
 * ProviderAvailability.source: "partner_app" | "operations" | "roster".
 *
 * seedUatRoster ran on the CUSTOMER's reserve path and wrote a fourth source, `uat_roster`, that the
 * domain does not declare. MEASURED on this branch before the fix:
 *
 *   - against an empty scheduling_availability table, ONE unprivileged reserve returned 200 with
 *     provider train_kiran and wrote 300 rows of 09:00-19:00 availability across three providers and
 *     100 days, every one of them source 'uat_roster'; provider- or Ops-authored rows: 0.
 *
 *   - with Ops having published groom_arun 09:00-11:00 for a date, a customer reserving 15:00-17:00
 *     IST on that date returned 200 groom_arun. listAvailability returned every row for provider+date
 *     and the engine's check is roster.some(...), so the synthetic 09:00-19:00 row simply joined the
 *     narrow published one beside it. Ops could not restrict a provider's hours at all.
 *
 * There was no environment flag anywhere in the scheduling domain, so production fabricated roster
 * exactly as UAT did. Two independent rules close it, and both are locked below:
 *
 *   1. Seeding is a capability and needs an explicit PAWSPACE_SCHEDULING_ENV=uat. Absent is not a
 *      declaration - the same reasoning as lib/payment-environment.ts.
 *   2. Where a provider or Ops HAS authored availability for a provider-date, only those rows count.
 *      This is the load-bearing half: turning seeding off cannot retract rows already in the table.
 *
 * Nothing here reads a source file. Every case executes the real route.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_F27_DB__", "__PTJA_F27_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const STAFF_HEADERS = {
  "oai-authenticated-user-email": "ops-roster@pawspace.test",
  "oai-authenticated-user-full-name": "Ops%20roster",
  "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
};

/** `seeding` maps to the real declaration a runtime would carry, or to no declaration at all. */
async function world({ seeding }) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_F27_DB__ = db;
  globalThis.__PTJA_F27_ENV__ = seeding
    ? { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_SCHEDULING_ENV: "uat" }
    : { PAWSPACE_PAYMENT_ENV: "sandbox" };
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const { seedProviderCapacityDefaults } = await import("../lib/provider-capacity-governance.ts");
  await ensureSecurityTables(db);
  await seedProviderCapacityDefaults(db);
  const now = Date.now();
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-PTJA-F27','ops-roster@pawspace.test','Ops roster','founder','active',?,?)").bind(now, now).run();
  return { sqlite, db };
}

async function customerCookie(db, customerId) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_otp", principalType: "identity_subject", principalKey: `customer:${customerId}`,
    subjectType: "customer", subjectId: customerId, verificationState: "verified",
    actorId: "ptja-f27", reason: "PTJA W1-F27 executable regression",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: String(binding.identity_source),
    principalType: String(binding.principal_type), principalKey: String(binding.principal_key),
    subjectType: "customer", subjectId: customerId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

async function post(modulePath, path, body, headers = {}) {
  const route = await import(modulePath);
  const response = await route.POST(new Request(`https://uat.pawspace.in${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  }));
  let parsed = null;
  try { parsed = await response.clone().json(); } catch { /* non-JSON */ }
  return { status: response.status, body: parsed };
}

/** A day far enough out that the future-window rule on reserve is never what answers. */
const DAY = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
/** 15:00-17:00 IST, outside a 09:00-11:00 published window and inside the synthetic 09:00-19:00 one. */
const OUTSIDE = [`${DAY}T09:30:00.000Z`, `${DAY}T11:30:00.000Z`];
/** 09:00-11:00 IST - exactly the window Ops publishes below, and the grooming 120-minute minimum. */
const INSIDE = [`${DAY}T03:30:00.000Z`, `${DAY}T05:30:00.000Z`];
/** Pins the decision to one provider, so what is asserted is that provider's roster and not another's. */
const ONLY_ARUN = [{ code: "ONLY-ARUN", field: "providerId", operator: "eq", value: "groom_arun" }];

const reserve = (cookie, { group, window, customRules }) => post(
  "../app/api/uat-scheduling/route.ts", "/api/uat-scheduling",
  {
    clientRequestId: group, customerId: "CUST-F27", petIds: ["PET-F27"], serviceCode: "grooming",
    cityId: "blr", zoneId: "blr-east", scheduledStart: window[0], scheduledEnd: window[1],
    ...(customRules ? { customRules } : {}),
  },
  { cookie },
);

const publishOpsWindow = (windows) => post(
  "../app/api/provider-capacity-control/route.ts", "/api/provider-capacity-control",
  { action: "set_availability", providerId: "groom_arun", cityId: "blr", zoneId: "blr-east", date: DAY, windows },
  STAFF_HEADERS,
);

test("W1-F27: an undeclared runtime does not let a customer's reserve write provider availability", async () => {
  const { sqlite, db } = await world({ seeding: false });
  const cookie = await customerCookie(db, "CUST-F27");

  const result = await reserve(cookie, { group: "F27-SEED", window: INSIDE });

  const written = sqlite.prepare("SELECT COUNT(*) n FROM scheduling_availability").get().n;
  assert.equal(written, 0,
    `an unprivileged reserve wrote ${written} availability rows on a runtime that declared no scheduling environment`);
  assert.equal(result.status, 409,
    `with no published availability the reserve must be refused, not satisfied by its own writes: ${JSON.stringify(result.body).slice(0, 400)}`);
  assert.equal(result.body?.error, "NO_SCHEDULE_AVAILABLE");
});

test("W1-F27: a declared UAT runtime still seeds - the gate is a declaration, not a shutdown", async () => {
  // Non-vacuity for the case above. Refusing every reserve everywhere would satisfy it and would stop
  // the platform's own UAT booking path, which is exactly what this gate must not do.
  const { sqlite, db } = await world({ seeding: true });
  const cookie = await customerCookie(db, "CUST-F27");

  const result = await reserve(cookie, { group: "F27-SEED-ON", window: INSIDE });

  assert.equal(result.status, 200,
    `a declared UAT runtime must still reserve: ${JSON.stringify(result.body).slice(0, 400)}`);
  assert.ok(sqlite.prepare("SELECT COUNT(*) n FROM scheduling_availability WHERE source='uat_roster'").get().n > 0,
    "a declared UAT runtime must still seed the synthetic roster");
});

test("W1-F27: an Ops-published window bounds the day a customer may book", async () => {
  // Seeding DECLARED ON, so what is being asserted is not the env gate a second time: it is that a
  // synthetic row can no longer widen a window Ops deliberately narrowed.
  const { sqlite, db } = await world({ seeding: true });
  const published = await publishOpsWindow(["09:00-11:00"]);
  assert.equal(published.status, 201, `Ops must be able to publish: ${JSON.stringify(published.body)}`);

  const cookie = await customerCookie(db, "CUST-F27");
  const result = await reserve(cookie, { group: "F27-OUT", window: OUTSIDE, customRules: ONLY_ARUN });

  assert.equal(result.status, 409,
    `15:00-17:00 IST is outside the 09:00-11:00 Ops published, so it must be refused: ${JSON.stringify(result.body).slice(0, 400)}`);
  const synthetic = sqlite.prepare("SELECT COUNT(*) n FROM scheduling_availability WHERE provider_id='groom_arun' AND date=? AND source='uat_roster'").get(DAY).n;
  assert.equal(synthetic, 0,
    `a synthetic row was written beside Ops' published window for the same provider-date (${synthetic} rows)`);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations").get().n, 0,
    "nothing may be reserved on a refused request");
});

test("W1-F27: a request inside the Ops-published window still reserves", async () => {
  // Non-vacuity for the case above. Refusing the narrowed provider outright would satisfy it and would
  // mean publishing a window makes a provider unbookable rather than bounded.
  const { db } = await world({ seeding: true });
  assert.equal((await publishOpsWindow(["09:00-11:00"])).status, 201);
  const cookie = await customerCookie(db, "CUST-F27");

  const result = await reserve(cookie, { group: "F27-IN", window: INSIDE, customRules: ONLY_ARUN });

  assert.equal(result.status, 200,
    `09:00-11:00 IST is exactly the published window and must reserve: ${JSON.stringify(result.body).slice(0, 400)}`);
  assert.equal(result.body?.data?.provider?.id, "groom_arun");
});

test("W1-F27: a synthetic row already in the table cannot re-open a day Ops narrows afterwards", async () => {
  // The ordering that makes the read-side rule load-bearing rather than redundant. The seeder writes
  // 100 days forward, so by the time Ops narrows a date the synthetic row for it is usually already
  // there - and no gate on future writes can retract it.
  const { sqlite, db } = await world({ seeding: true });
  const cookie = await customerCookie(db, "CUST-F27");

  // A real earlier booking on a different day seeds the whole forward window, this date included.
  const earlier = await reserve(cookie, { group: "F27-EARLIER", window: INSIDE, customRules: ONLY_ARUN });
  assert.equal(earlier.status, 200, `the earlier reserve must succeed to seed: ${JSON.stringify(earlier.body).slice(0, 300)}`);
  const seeded = sqlite.prepare("SELECT windows_json FROM scheduling_availability WHERE provider_id='groom_arun' AND date=? AND source='uat_roster'").get(DAY);
  assert.ok(seeded, "the earlier reserve must have left a synthetic row for this provider-date to narrow over");
  assert.match(String(seeded.windows_json), /09:00-19:00/, "the synthetic row is the wide one");

  // Ops now narrows the same day, and the wide synthetic row is still sitting beside it.
  assert.equal((await publishOpsWindow(["09:00-11:00"])).status, 201);
  const after = await reserve(cookie, { group: "F27-AFTER", window: OUTSIDE, customRules: ONLY_ARUN });

  assert.equal(after.status, 409,
    `the stale synthetic row re-opened a day Ops had narrowed: ${JSON.stringify(after.body).slice(0, 400)}`);
  assert.ok(sqlite.prepare("SELECT COUNT(*) n FROM scheduling_availability WHERE provider_id='groom_arun' AND date=? AND source='uat_roster'").get(DAY).n > 0,
    "the synthetic row is still present - it is ignored, not deleted, which is what makes this case meaningful");
});

test("W1-F27: only an explicit uat declaration unlocks seeding", async () => {
  const { uatRosterSeedingEnabled } = await import("../lib/scheduling-roster-authority.ts");
  for (const env of [undefined, null, {}, { PAWSPACE_SCHEDULING_ENV: "" }, { PAWSPACE_SCHEDULING_ENV: "  " },
    { PAWSPACE_SCHEDULING_ENV: "live" }, { PAWSPACE_SCHEDULING_ENV: "production" }, { PAWSPACE_SCHEDULING_ENV: "staging" }]) {
    assert.equal(uatRosterSeedingEnabled(env), false, `${JSON.stringify(env)} is not a uat declaration`);
  }
  for (const env of [{ PAWSPACE_SCHEDULING_ENV: "uat" }, { PAWSPACE_SCHEDULING_ENV: " UAT " }]) {
    assert.equal(uatRosterSeedingEnabled(env), true, `${JSON.stringify(env)} is a uat declaration`);
  }
});
