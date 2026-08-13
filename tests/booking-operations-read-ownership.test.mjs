/**
 * A provider could read any booking's operational trail by supplying its id.
 *
 * `GET /api/booking-operations?bookingId=<id>` returned that booking's operational events, customer
 * notifications, rebooking cases and refund cases with no authorization in the handler at all. The
 * only gate was lib/api-gateway.ts asking for `bookings.view`, which every service_provider holds by
 * design and must keep holding to do their own job. Reproduced against a REAL service_provider
 * identity - Provider A read Provider B's customer name, complaint text, refund amount and the staff
 * member who raised it.
 *
 * `bookings.view` answers "may this person see booking data at all". It cannot answer "may they see
 * THIS booking". The fix is object ownership, not a stronger global permission.
 *
 * Every actor here resolves through the real workspace identity path. The development-preview host
 * silently resolves a superuser holding "*", which makes any authorization result meaningless, so the
 * first test asserts what each actor actually is before anything else is trusted.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__BOREAD_DB__", "__BOREAD_ENV__");

/** Records every statement so a denial can be proved to happen BEFORE sensitive rows are fetched. */
const executed = [];
function makeD1(sqlite) {
  function statement(sql, args) {
    const run = (fn) => { executed.push(sql); return fn(); };
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => run(() => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; }),
      run: async () => run(() => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; }),
      all: async () => run(() => ({ results: sqlite.prepare(sql).all(...args) })),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

// The security DDL and role catalogue are memoized per isolate, so the suite shares one database.
const sqlite = new DatabaseSync(":memory:");
globalThis.__BOREAD_DB__ = makeD1(sqlite);
globalThis.__BOREAD_ENV__ = {};

const route = await import("../app/api/booking-operations/route.ts");
const { resolveActor } = await import("../lib/server-auth.ts");

const ACTORS = {
  providerA: { email: "provider.a@pawspace.test", role: "service_provider", providerId: "PRV-A" },
  providerB: { email: "provider.b@pawspace.test", role: "service_provider", providerId: "PRV-B" },
  associate: { email: "associate@pawspace.test", role: "associate", providerId: null },
  manager: { email: "manager@pawspace.test", role: "manager", providerId: null },
  admin: { email: "admin@pawspace.test", role: "admin", providerId: null },
};

const SENSITIVE_TABLES = ["booking_operational_events", "booking_customer_notifications", "booking_rebooking_cases", "booking_refund_cases"];
const readOps = (actor, bookingId) => route.GET(new Request(`https://app.pawspace.test/api/booking-operations?bookingId=${bookingId}`, {
  headers: { "oai-authenticated-user-email": actor.email },
}));
const sensitiveReads = () => executed.filter((sql) => /^\s*SELECT/i.test(sql) && SENSITIVE_TABLES.some((table) => sql.includes(table)));

test("SETUP: two unrelated providers, one booking each, foreign booking seeded in all four tables", async () => {
  await readOps(ACTORS.providerA, "BOOTSTRAP").catch(() => null);
  await resolveActor(new Request("https://app.pawspace.test/x", { headers: { "oai-authenticated-user-email": ACTORS.providerA.email } })).catch(() => null);

  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,provider_id TEXT,status TEXT,total_amount REAL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_identity_links (email TEXT PRIMARY KEY, provider_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', verified_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  for (const actor of Object.values(ACTORS)) {
    sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)").run(`U-${actor.email}`, actor.email, actor.email, actor.role, now, now);
    if (actor.providerId) sqlite.prepare("INSERT OR REPLACE INTO provider_identity_links (email,provider_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)").run(actor.email, actor.providerId, now, now);
  }
  sqlite.prepare("INSERT OR REPLACE INTO canonical_bookings VALUES ('BK-A','CUS-A','PRV-A','confirmed',4000)").run();
  sqlite.prepare("INSERT OR REPLACE INTO canonical_bookings VALUES ('BK-B','CUS-B-VIP','PRV-B','confirmed',7500)").run();

  // Booking A carries its own trail so an allowed read is distinguishable from an empty one.
  sqlite.prepare("INSERT INTO booking_operational_events (id,booking_id,provider_id,event_type,reason,impact_minutes,detail_json,actor_id,created_at) VALUES ('EV-A','BK-A','PRV-A','running_late','OWN-A: traffic on Hosur Road',20,'{}',?,?)").run(ACTORS.providerA.email, now);

  // Booking B: distinctive values in every table the handler returns.
  sqlite.prepare("INSERT INTO booking_operational_events (id,booking_id,provider_id,event_type,reason,impact_minutes,detail_json,actor_id,created_at) VALUES ('EV-B','BK-B','PRV-B','vehicle_issue','SECRET-B: bike broke down near Indiranagar',45,'{}',?,?)").run(ACTORS.providerB.email, now);
  sqlite.prepare("INSERT INTO booking_customer_notifications (id,booking_id,customer_id,channel,template_code,message,status,event_id,created_at) VALUES ('N-B','BK-B','CUS-B-VIP','whatsapp','vehicle_issue','SECRET-B: Mrs Kapoor, your provider reported a vehicle issue.','queued','EV-B',?)").run(now);
  sqlite.prepare("INSERT INTO booking_rebooking_cases (id,booking_id,source_event_id,status,reason,eligible_at,created_at,updated_at) VALUES ('RB-B','BK-B','EV-B','offered','SECRET-B: delay exceeded customer comfort window',?,?,?)").run(now, now, now);
  sqlite.prepare("INSERT INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,created_at,updated_at) VALUES ('RC-B','BK-B','PAY-B',7500,'SECRET-B: service complaint - groomer was rude to the customer','requested','cx.lead@pawspace.test',?,?)").run(now, now);

  for (const table of SENSITIVE_TABLES) {
    assert.equal(sqlite.prepare(`SELECT COUNT(*) n FROM ${table} WHERE booking_id='BK-B'`).get().n, 1, `${table} seeded`);
  }
});

test("PRECONDITION: the actors are the real roles, not a preview superuser", async () => {
  const resolved = {};
  for (const [name, actor] of Object.entries(ACTORS)) {
    resolved[name] = await resolveActor(new Request("https://app.pawspace.test/x", { headers: { "oai-authenticated-user-email": actor.email } }));
  }
  for (const name of ["providerA", "providerB"]) {
    const actor = resolved[name];
    assert.equal(actor.roleCode, "service_provider", `${name} must really be a provider`);
    assert.equal(actor.developmentPreview, false, `${name} must not be the preview actor`);
    assert.ok(!actor.permissions.includes("*"), `${name} must not hold the wildcard`);
    assert.ok(!actor.permissions.includes("bookings.manage"), `${name} must not hold booking administration`);
    assert.ok(actor.permissions.includes("bookings.view"), `${name} does hold bookings.view - which is the whole point`);
  }
  assert.ok(resolved.associate.permissions.includes("bookings.view") && !resolved.associate.permissions.includes("bookings.manage"), "associate holds view but not manage");
  for (const name of ["manager", "admin"]) {
    assert.ok(resolved[name].permissions.includes("bookings.manage"), `${name} carries explicit booking administration`);
  }
});

test("a provider reads their OWN booking", async () => {
  const response = await readOps(ACTORS.providerA, "BK-A");
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.events.length, 1, "their own trail is returned");
  assert.match(body.data.events[0].reason, /OWN-A/);
});

test("a provider is refused another provider's booking, and receives none of its data", async () => {
  executed.length = 0;
  const response = await readOps(ACTORS.providerA, "BK-B");
  const text = await response.text();

  assert.ok(response.status === 403 || response.status === 404, `expected a refusal, got ${response.status}`);
  // Nothing from any of the four tables may appear in the refused response.
  for (const secret of [
    "SECRET-B: bike broke down near Indiranagar",
    "SECRET-B: Mrs Kapoor, your provider reported a vehicle issue.",
    "SECRET-B: delay exceeded customer comfort window",
    "SECRET-B: service complaint - groomer was rude to the customer",
    "CUS-B-VIP", "cx.lead@pawspace.test", "7500",
  ]) {
    assert.ok(!text.includes(secret), `the refused response must not contain ${JSON.stringify(secret)}`);
  }
  assert.ok(!text.includes("SECRET-B"), "no foreign value at all");
});

test("the four sensitive queries never run for a refused request", async () => {
  // Authorization must happen before the rows are fetched, not after - a handler that reads and then
  // filters has already put the data in memory and one refactor away from a response.
  executed.length = 0;
  await readOps(ACTORS.providerA, "BK-B");
  assert.deepEqual(sensitiveReads(), [], `no sensitive table may be SELECTed on denial, saw ${JSON.stringify(sensitiveReads())}`);

  // And they DO run when the read is allowed, so the assertion above is not vacuous.
  executed.length = 0;
  await readOps(ACTORS.providerA, "BK-A");
  assert.equal(sensitiveReads().length, SENSITIVE_TABLES.length, "an allowed read queries all four");
});

test("the other provider reads their own booking, so the rule is ownership and not a denylist", async () => {
  const response = await readOps(ACTORS.providerB, "BK-B");
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.match(body.data.events[0].reason, /SECRET-B/, "Provider B legitimately sees their own booking");
  assert.equal(body.data.refunds.length, 1);
});

test("Ops keep arbitrary-booking access through explicit booking administration", async () => {
  for (const name of ["manager", "admin"]) {
    for (const bookingId of ["BK-A", "BK-B"]) {
      const response = await readOps(ACTORS[name], bookingId);
      assert.equal(response.status, 200, `${name} must still read ${bookingId}`);
    }
  }
  // Ops are not put through provider ownership: neither holds a provider identity link.
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_identity_links WHERE email IN (?,?)").get(ACTORS.manager.email, ACTORS.admin.email).n, 0);
});

test("an associate holding bookings.view gets no global booking access", async () => {
  // Deliberate decision: nothing in the platform consumes this endpoint as an associate, and there is
  // no record-level assignment linking an associate to a booking - canonical_bookings carries a
  // provider, not a rep. Granting them every booking merely because they hold bookings.view is the
  // defect restated, so they are refused until such a rule exists.
  for (const bookingId of ["BK-A", "BK-B"]) {
    const response = await readOps(ACTORS.associate, bookingId);
    assert.ok(response.status >= 400, `associate must not read ${bookingId} without a record-level claim`);
    assert.ok(!(await response.text()).includes("SECRET-B"));
  }
});

test("a booking id that does not exist is not a way in", async () => {
  const response = await readOps(ACTORS.providerA, "BK-DOES-NOT-EXIST");
  assert.equal(response.status, 404);
});

test("the handler authorizes rather than relying on the gateway alone", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../app/api/booking-operations/route.ts", import.meta.url), "utf8");
  const getBody = source.slice(source.indexOf("export async function GET"), source.indexOf("export async function POST"));
  assert.match(getBody, /resolveActor\(request\)/, "the handler resolves the caller");
  assert.match(getBody, /requirePermission\(actor, "bookings\.view"\)/, "bookings.view stays the read permission - it is not strengthened");
  assert.match(getBody, /requireProviderOwnership\(db, actor, String\(booking\.provider_id/, "and object ownership is enforced");
  // The ownership check must precede the sensitive reads in source order too.
  assert.ok(getBody.indexOf("requireProviderOwnership") < getBody.indexOf("booking_operational_events"), "ownership is checked before the trail is read");
});
