/**
 * ADVERSARIAL PII REVEAL — client-supplied assignment metadata as an authorization input.
 *
 * WHAT app/api/customer-data-reveal DOES. It is the one place a masked customer record becomes an
 * unmasked one, and the decision is delegated to lib/purpose-based-access.ts so the surface cannot be
 * more generous than the policy. The policy is right: two justifications and only two — the record is
 * ASSIGNED to you, or you hold the explicit `customers.view_full_phone` grant.
 *
 * WHAT THE ROUTE DOES WITH IT. It builds the `assignment` it passes to mayReveal() out of the REQUEST
 * BODY, verbatim:
 *
 *     const assignment = body.assignment?.id ? { type:..., id:String(body.assignment.id),
 *       assignedTo: body.assignment.assignedTo ?? null, status: body.assignment.status ?? null,
 *       scheduledStart: body.assignment.scheduledStart ?? null,
 *       completedAt: body.assignment.completedAt ?? null } : null;
 *
 * and mayReveal() answers yes when `text(assignment.assignedTo) === text(actor.email)`. So the caller
 * decides the input to its own authorization check. "This record is assigned to me" is not looked up
 * anywhere — not against `communication_threads.assigned_to` (which is what app/api/conversations reads
 * to build exactly this object) and not against `crm_contacts.owner` (which is what app/api/crm reads).
 * Those two routes derive assignment from the database. This one accepts it from the wire.
 *
 * The same body also carries `status`, `scheduledStart` and `completedAt`, which are the three inputs to
 * the address rule and the provider dispute window. A caller who may assert its own assignment may also
 * assert that the booking is confirmed, that service is an hour away, and that its completed job
 * completed just now — which opens the full doorstep address and re-opens a closed provider window.
 *
 * WHY THIS IS CHEAP TO FIX, AND WHY THAT MATTERS FOR THE FINDING. app/control/customer-reveal.tsx — the
 * only first-party caller in the repository — posts `{customerId, purpose, reason, fields}`. It has
 * never sent `assignment`. Nothing legitimate populates this field, so deriving it server-side (or
 * dropping it) breaks no caller. PII-14 asserts that, so the finding cannot be dismissed as
 * "the screens depend on it".
 *
 * SCOPE NOTE. app/api/customer-contact is in this file too, because it is the OTHER surface where a
 * client-supplied `assignedTo` would matter — and there the vector is already closed (the outbox row is
 * stamped with the resolved actor's own email, never the body's). PII-15/16 lock that, so a future edit
 * cannot quietly open it.
 *
 * Tests prefixed [OPEN] assert the security property and are expected to fail against the current
 * route: they are the finding as an executable assertion. The rest are regression locks on boundaries
 * that already hold.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__ADV_PII_DB__", "__ADV_PII_ENV__");

const RAW_PHONE = "+919812345678";
const RAW_EMAIL = "meera.subject@example.com";
const RAW_LINE1 = "18 Ulsoor Lake Road";
const RAW_PIN = "560042";
const AREA = "Ulsoor";

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Non-preview host: on localhost every actor is the preview superuser and nothing here is measurable. */
const REVEAL_URL = "https://uat.pawspace.in/api/customer-data-reveal";

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => { const out = []; for (const item of items) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

/**
 * A staff identity holding the REAL permissions of the named default role.
 *
 * `associate` is the interesting actor: it holds customers.view (so it may open the surface) and NOT
 * customers.view_full_phone (so assignment is the only thing that can justify a reveal for it). That is
 * exactly the population the tampered field would promote.
 */
async function staffWorld(role, { email = `${role}.probe@pawspace.test` } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__ADV_PII_DB__ = db;
  globalThis.__ADV_PII_ENV__ = {};
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const { ensureDataAccessTables } = await import("../lib/purpose-based-access.ts");
  // Created up front so "nothing was logged" is measured against a real empty table rather than
  // against a table that does not exist — an absent table satisfies the assertion for the wrong reason.
  await ensureDataAccessTables(db);
  const now = Date.now();
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .bind(`USR-${role.toUpperCase()}`, email, role, role, now, now).run();
  return {
    sqlite, db, email, now,
    headers: { "content-type": "application/json", "oai-authenticated-user-email": email },
  };
}

function seedSubject(sqlite, now) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,email,created_at,updated_at) VALUES ('CUST-PII','blr','Meera Subject',?,?,?,?)").run(RAW_PHONE, RAW_EMAIL, now, now);
  sqlite.exec("CREATE TABLE IF NOT EXISTS customer_addresses (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,label TEXT NOT NULL,line1 TEXT NOT NULL,line2 TEXT,area TEXT,city TEXT NOT NULL,postal_code TEXT,is_default INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO customer_addresses (id,customer_id,label,line1,area,city,postal_code,is_default,created_at,updated_at) VALUES ('ADDR-PII','CUST-PII','Home',?,?,'Bengaluru',?,1,?,?)").run(RAW_LINE1, AREA, RAW_PIN, now, now);
}

/**
 * The SERVER-SIDE record of who a booking is assigned to.
 *
 * app/api/conversations builds its `assignment` object from exactly this column. Seeded here so the
 * tampering tests are not merely asserting "an unknown id is refused": the record exists, it is real,
 * and it is assigned to somebody else. A fix that verifies assignment has a source of truth to read,
 * and these tests stay meaningful once it does.
 */
async function seedAssignedBooking(db, { threadId, bookingId, assignedTo, status = "open" }) {
  const governance = await import("../lib/conversation-governance.ts");
  await governance.ensureConversationGovernance(db);
  await db.prepare("INSERT INTO communication_threads (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES (?,?,?,NULL,NULL,?,?,NULL,?,?)")
    .bind(threadId, "CUST-PII", bookingId, status, assignedTo, Date.now(), Date.now()).run();
}

/** The SERVER-SIDE record of who a lead belongs to — what app/api/crm reads to build `assignment`. */
function seedOwnedLead(sqlite, now, { id, owner }) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, primary_phone TEXT NOT NULL, secondary_phone TEXT, email TEXT, area TEXT, pet_names TEXT, pet_summary TEXT, stage TEXT NOT NULL DEFAULT 'New lead', owner TEXT DEFAULT 'Unassigned', source TEXT DEFAULT 'Website', lifetime_value REAL DEFAULT 0, next_action TEXT, opportunity TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,email,area,stage,owner,source,lifetime_value,created_at,updated_at) VALUES (?,'Meera Subject',?,?,?,'Qualified',?,'Website',0,?,?)")
    .run(id, RAW_PHONE, RAW_EMAIL, AREA, owner, now, now);
}

const reveal = async (headers, body) => {
  const route = await import("../app/api/customer-data-reveal/route.ts");
  const response = await route.POST(new Request(REVEAL_URL, { method: "POST", headers, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json().catch(() => null) };
};

const maskedRead = async (headers, customerId) => {
  const route = await import("../app/api/customer-data-reveal/route.ts");
  const response = await route.GET(new Request(`${REVEAL_URL}?customerId=${customerId}`, { headers }));
  return { status: response.status, body: await response.json().catch(() => null) };
};

/** Does this response body contain the value ANYWHERE — including somewhere nobody thought to look? */
const exposes = (payload, value) => JSON.stringify(payload ?? {}).includes(value);
const REASON = "Customer called about tomorrow's visit";

// =============================================================================================
// 0. Controls. Without these the whole file is vacuous.
// =============================================================================================

test("PII-00 (non-vacuity): an admin holding the explicit grant CAN reveal, with a reason", async () => {
  // If this fails, every masked assertion below could be passing because the route is simply broken.
  const { sqlite, headers, now } = await staffWorld("admin");
  seedSubject(sqlite, now);
  const result = await reveal(headers, { customerId: "CUST-PII", purpose: "operations", reason: REASON });
  assert.equal(result.status, 200, `the legitimate reveal path must work: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(exposes(result.body, RAW_PHONE), true, "and return the number");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM customer_data_reveals").get().c), 1, "and log exactly one reveal");
});

test("PII-01 (non-vacuity): an associate with NO assignment sees a masked number", async () => {
  const { sqlite, headers, now } = await staffWorld("associate");
  seedSubject(sqlite, now);
  const result = await reveal(headers, { customerId: "CUST-PII", purpose: "operations", reason: REASON });
  assert.equal(exposes(result.body, RAW_PHONE), false, `no assignment, no reveal: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(exposes(result.body, RAW_EMAIL), false, "and the email travels with it");
});

// =============================================================================================
// 1. Self-asserted assignment. The live gap.
// =============================================================================================

test("[OPEN] PII-02: an associate cannot reveal by naming ITSELF as the assignee of a record that does not exist", async () => {
  // The simplest form of the attack: no booking, no lead, no thread — just the claim.
  const { sqlite, headers, now, email } = await staffWorld("associate");
  seedSubject(sqlite, now);
  const result = await reveal(headers, {
    customerId: "CUST-PII", purpose: "operations", reason: REASON,
    assignment: { type: "booking", id: "BK-DOES-NOT-EXIST", assignedTo: email },
  });
  assert.equal(exposes(result.body, RAW_PHONE), false,
    `a self-asserted assignment to a non-existent record must not unmask anything: ${JSON.stringify(result).slice(0, 400)}`);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM customer_data_reveals").get().c), 0,
    "and nothing may be logged as revealed, because nothing may be revealed");
});

test("[OPEN] PII-03: an associate cannot reveal a booking that is REALLY assigned to somebody else", async () => {
  // The record exists and the database says whose it is. The body says otherwise, and the body wins.
  const { sqlite, db, headers, now, email } = await staffWorld("associate");
  seedSubject(sqlite, now);
  await seedAssignedBooking(db, { threadId: "THREAD-1", bookingId: "BK-REAL-1", assignedTo: "someone.else@pawspace.test" });
  const result = await reveal(headers, {
    customerId: "CUST-PII", purpose: "operations", reason: REASON,
    assignment: { type: "booking", id: "BK-REAL-1", assignedTo: email, status: "confirmed" },
  });
  assert.equal(exposes(result.body, RAW_PHONE), false,
    `assignment must be read from communication_threads.assigned_to, not from the request: ${JSON.stringify(result).slice(0, 400)}`);
});

test("[OPEN] PII-04: an associate cannot reveal a LEAD owned by somebody else by claiming the owner field", async () => {
  // The same attack against the other assignment source. app/api/crm derives assignedTo from
  // crm_contacts.owner; the reveal route accepts whatever the caller types in its place.
  const { sqlite, headers, now, email } = await staffWorld("associate");
  seedSubject(sqlite, now);
  seedOwnedLead(sqlite, now, { id: "CUST-PII", owner: "other.rep@pawspace.test" });
  const result = await reveal(headers, {
    customerId: "CUST-PII", purpose: "sales", reason: REASON,
    assignment: { type: "lead", id: "CUST-PII", assignedTo: email, status: "Qualified" },
  });
  assert.equal(exposes(result.body, RAW_PHONE), false,
    `lead ownership must come from crm_contacts.owner: ${JSON.stringify(result).slice(0, 400)}`);
});

test("[OPEN] PII-05: the same tamper must not hand over the email either", async () => {
  // Stated separately because the fields are revealed independently: a fix that only re-verifies the
  // phone would leave this green-looking and still leaking.
  const { sqlite, headers, now, email } = await staffWorld("associate");
  seedSubject(sqlite, now);
  const result = await reveal(headers, {
    customerId: "CUST-PII", purpose: "operations", reason: REASON, fields: ["email"],
    assignment: { type: "booking", id: "BK-ANY", assignedTo: email },
  });
  assert.equal(exposes(result.body, RAW_EMAIL), false, `no email: ${JSON.stringify(result).slice(0, 400)}`);
});

test("[OPEN] PII-06: forged status + scheduledStart must not open the full doorstep address", async () => {
  // Three client-supplied fields drive the address rule: assignedTo (mine), status (eligible) and
  // scheduledStart (near execution). All three arrive in the same object. This is the worst outcome in
  // the file — a home address, for a stranger's booking, on an associate's screen.
  const { sqlite, headers, now, email } = await staffWorld("associate");
  seedSubject(sqlite, now);
  const result = await reveal(headers, {
    customerId: "CUST-PII", purpose: "operations", reason: REASON,
    assignment: { type: "booking", id: "BK-FORGED", assignedTo: email, status: "confirmed", scheduledStart: now + HOUR },
  });
  assert.notEqual(result.body?.data?.address?.precision, "full",
    `a forged near-execution confirmed booking must not open the address: ${JSON.stringify(result).slice(0, 400)}`);
  assert.equal(exposes(result.body, RAW_LINE1), false, "line 1 must not be served");
  assert.equal(exposes(result.body, RAW_PIN), false, "nor the postcode");
});

test("PII-07: a service_provider cannot reach this surface at all, forged assignment or not", async () => {
  // Measured, not assumed: the `service_provider` role holds bookings.view / scheduling.view /
  // communications.* and NOT customers.view, so authorize() refuses before any body is parsed. Worth
  // locking, because it is what keeps the service_delivery branch below out of provider hands — and
  // because a test that merely asserted "the address is masked" here would pass for this reason while
  // proving nothing about the branch.
  const { sqlite, headers, now, email } = await staffWorld("service_provider");
  seedSubject(sqlite, now);
  const result = await reveal(headers, {
    customerId: "CUST-PII", purpose: "service_delivery", reason: REASON,
    assignment: { type: "booking", id: "BK-NOT-MINE", assignedTo: email, status: "confirmed" },
  });
  assert.equal(result.status, 403, `a provider must be refused outright: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(exposes(result.body, RAW_LINE1), false, "and nothing leaks in the refusal");
});

test("[OPEN] PII-08: purpose=service_delivery must not open the doorstep on a self-asserted job", async () => {
  // The service_delivery branch of decideCustomerDataAccess checks NO permission at all: any non-null
  // assignment yields precision:"full". The purpose string and the assignment object both come from the
  // request body, so an actor who may open the surface at all (an associate holds customers.view) can
  // select that branch for itself and read a home address it has no relationship to.
  const { sqlite, headers, now, email } = await staffWorld("associate");
  seedSubject(sqlite, now);
  const result = await reveal(headers, {
    customerId: "CUST-PII", purpose: "service_delivery", reason: REASON,
    assignment: { type: "booking", id: "BK-NOT-MINE", assignedTo: email, status: "confirmed" },
  });
  assert.notEqual(result.body?.data?.address?.precision, "full",
    `an unverified job must not open the doorstep: ${JSON.stringify(result).slice(0, 400)}`);
  assert.equal(exposes(result.body, RAW_LINE1), false, "line 1 must not be served");
  assert.equal(exposes(result.body, RAW_PIN), false, "nor the postcode");
});

test("[OPEN] PII-08b: a closed dispute window must not re-open because the caller restated completedAt", async () => {
  // R01-10 in tests/ptja-w2-b2-purpose-based-access.test.mjs proves the window closes — by calling the
  // pure decision function with a real completedAt. Over HTTP the caller supplies completedAt, so the
  // expiry it proves is only ever as stale as the attacker says it is. Same actor as PII-08, so the
  // only variable is the timestamp.
  const { sqlite, headers, now, email } = await staffWorld("associate");
  seedSubject(sqlite, now);
  const stale = await reveal(headers, {
    customerId: "CUST-PII", purpose: "service_delivery", reason: REASON,
    assignment: { type: "booking", id: "BK-LONG-DONE", assignedTo: email, status: "completed", completedAt: now - 200 * DAY },
  });
  assert.notEqual(stale.body?.data?.address?.precision, "full", "a genuinely old job is correctly shut");
  const refreshed = await reveal(headers, {
    customerId: "CUST-PII", purpose: "service_delivery", reason: REASON,
    assignment: { type: "booking", id: "BK-LONG-DONE", assignedTo: email, status: "completed", completedAt: now },
  });
  assert.notEqual(refreshed.body?.data?.address?.precision, "full",
    `restating completedAt as "just now" must not re-open it: ${JSON.stringify(refreshed).slice(0, 400)}`);
});

test("[OPEN] PII-09: a reveal granted on a self-asserted assignment must not be logged as legitimate", async () => {
  // Evidence quality. customer_data_reveals stores assignment_type and assignment_id straight from the
  // request, so a tampered reveal is recorded citing a booking id the attacker invented. The audit
  // trail then testifies that the access was justified.
  const { sqlite, headers, now, email } = await staffWorld("associate");
  seedSubject(sqlite, now);
  await reveal(headers, {
    customerId: "CUST-PII", purpose: "operations", reason: REASON,
    assignment: { type: "booking", id: "BK-FICTION", assignedTo: email },
  });
  const rows = sqlite.prepare("SELECT assignment_id FROM customer_data_reveals").all();
  assert.equal(rows.length, 0, `an unjustified reveal must not exist, let alone cite ${rows[0]?.assignment_id ?? "-"} as its justification`);
});

// =============================================================================================
// 2. Boundaries that already hold. Regression locks.
// =============================================================================================

test("PII-10: a role without customers.view cannot reach the surface at all, tampered body or not", async () => {
  const { sqlite, headers, now, email } = await staffWorld("finance");
  seedSubject(sqlite, now);
  const result = await reveal(headers, {
    customerId: "CUST-PII", purpose: "operations", reason: REASON,
    assignment: { type: "booking", id: "BK-ANY", assignedTo: email, status: "confirmed" },
  });
  assert.equal(result.status, 403, `permission is checked before any body work: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(exposes(result.body, RAW_PHONE), false, "and no data comes back");
});

test("PII-11: purpose=compliance does not unlock for a role without audit.view", async () => {
  // mayReveal has a compliance branch. It is gated on audit.view, which an associate does not hold —
  // so the purpose string, which IS client-supplied, cannot be used as a second forged input.
  const { sqlite, headers, now } = await staffWorld("associate");
  seedSubject(sqlite, now);
  const result = await reveal(headers, { customerId: "CUST-PII", purpose: "compliance", reason: REASON });
  assert.equal(exposes(result.body, RAW_PHONE), false, `compliance must not be self-declared: ${JSON.stringify(result).slice(0, 300)}`);
});

test("PII-12: an unknown subject is refused, not answered as an empty masked record", async () => {
  // Otherwise the surface enumerates which customer ids exist, at 200, for anyone who may open it.
  const { sqlite, headers, now, email } = await staffWorld("associate");
  seedSubject(sqlite, now);
  const result = await reveal(headers, {
    customerId: "CUST-NOBODY", purpose: "operations", reason: REASON,
    assignment: { type: "booking", id: "BK-ANY", assignedTo: email },
  });
  assert.equal(result.status, 404, `an unknown subject must 404: ${JSON.stringify(result).slice(0, 300)}`);
});

test("PII-13: a reason is required even with an assignment attached, and none is logged without one", async () => {
  const { sqlite, headers, now, email } = await staffWorld("admin");
  seedSubject(sqlite, now);
  for (const reason of [undefined, "", "x", "   "]) {
    const result = await reveal(headers, {
      customerId: "CUST-PII", purpose: "operations", ...(reason === undefined ? {} : { reason }),
      assignment: { type: "booking", id: "BK-ANY", assignedTo: email },
    });
    assert.equal(result.status, 400, `reason ${JSON.stringify(reason)} must be refused: ${JSON.stringify(result).slice(0, 200)}`);
    assert.equal(exposes(result.body, RAW_PHONE), false, "and nothing comes back with it");
  }
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM customer_data_reveals").get().c), 0, "and nothing is logged");
});

test("PII-14: no first-party caller supplies `assignment`, so deriving it server-side breaks nothing", async () => {
  // The reason PII-02..PII-09 are a cheap fix rather than a redesign. app/control/customer-reveal.tsx is
  // the only client in the repository that posts to this route, and its body is
  // {customerId, purpose, reason, fields}. If a screen ever does need assignment, it must come from the
  // database on the server side — which is what app/api/conversations and app/api/crm already do.
  const { readFile } = await import("node:fs/promises");
  const control = await readFile(new URL("../app/control/customer-reveal.tsx", import.meta.url), "utf8");
  assert.match(control, /\/api\/customer-data-reveal/, "this is still the reveal client");
  // The request BODY, not the whole file — the component does mention assignment in a tooltip, which is
  // copy, not a payload. Matching the body keeps this assertion about what goes on the wire.
  const body = control.match(/body:\s*JSON\.stringify\(\{([^}]*)\}\)/);
  assert.ok(body, "the reveal control still posts a JSON body");
  assert.equal(/assignment/.test(body[1]), false, `the posted body must carry no assignment, and carries: {${body[1].trim()}}`);
  assert.match(body[1], /customerId/, "it sends the subject");
  assert.match(body[1], /reason/, "and the reason, which is what the policy requires");
});

// =============================================================================================
// 3. app/api/customer-contact — the other surface a forged `assignedTo` would matter on.
// =============================================================================================

const contact = async (headers, body) => {
  const route = await import("../app/api/customer-contact/route.ts");
  const response = await route.POST(new Request("https://uat.pawspace.in/api/customer-contact", { method: "POST", headers, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json().catch(() => null) };
};

async function contactWorld(role) {
  const world = await staffWorld(role, { email: `${role}.caller@pawspace.test` });
  const { sqlite, db, now } = world;
  sqlite.exec("CREATE TABLE IF NOT EXISTS subscription_customers (customer_key TEXT PRIMARY KEY, customer_name TEXT NOT NULL, primary_phone TEXT, secondary_phone TEXT, segment TEXT NOT NULL DEFAULT '', outbound_priority TEXT NOT NULL DEFAULT '', next_best_action TEXT NOT NULL DEFAULT '', first_service_date TEXT NOT NULL DEFAULT '', last_service_date TEXT NOT NULL DEFAULT '', days_since_last_service INTEGER NOT NULL DEFAULT 0, dormancy_bucket TEXT NOT NULL DEFAULT '', orders INTEGER NOT NULL DEFAULT 0, gross_sales REAL NOT NULL DEFAULT 0, aov REAL NOT NULL DEFAULT 0, services_used TEXT NOT NULL DEFAULT '', primary_service TEXT NOT NULL DEFAULT '', grooming_orders INTEGER NOT NULL DEFAULT 0, grooming_subscription_orders INTEGER NOT NULL DEFAULT 0, training_orders INTEGER NOT NULL DEFAULT 0, boarding_orders INTEGER NOT NULL DEFAULT 0, pet_sitting_orders INTEGER NOT NULL DEFAULT 0, subscription_target_score REAL NOT NULL DEFAULT 0, import_batch_id TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO subscription_customers (customer_key,customer_name,primary_phone,secondary_phone,updated_at) VALUES ('CUST-PII','Meera Subject',?,?,?)").run(RAW_PHONE, RAW_PHONE, now);
  const engine = await import("../lib/communication-engine.ts");
  await engine.ensureCommunicationTables(db);
  return world;
}

test("PII-15: customer-contact returns only a masked number, never the raw one", async () => {
  const { headers } = await contactWorld("manager");
  const result = await contact(headers, { customerKey: "CUST-PII", channel: "call", target: "primary", purpose: "service_recovery", bookingId: "BK-1" });
  assert.equal(result.status, 200, `a manager may queue a call: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(exposes(result.body, RAW_PHONE), false, `the raw destination must never be served: ${JSON.stringify(result.body).slice(0, 400)}`);
  assert.ok(exposes(result.body, "•"), "the value is masked, not omitted, so the work stays possible");
});

test("PII-16: a client-supplied assignedTo on customer-contact is ignored in favour of the resolved actor", async () => {
  // This is the vector the directive names, on the surface where it would be most useful to an
  // attacker — the outbox row is what later grants access to the conversation. It is already closed:
  // enqueueCommunication is called with assignedTo: actor.email, a server-derived value. Locked so an
  // edit that starts trusting the body has to fail a test to land.
  const { sqlite, headers, email } = await contactWorld("manager");
  const result = await contact(headers, {
    customerKey: "CUST-PII", channel: "call", target: "primary", purpose: "service_recovery", bookingId: "BK-1",
    assignedTo: "victim.inbox@pawspace.test", createdBy: "victim.inbox@pawspace.test", actorEmail: "victim.inbox@pawspace.test",
  });
  assert.equal(result.status, 200, `the request itself is ordinary: ${JSON.stringify(result).slice(0, 300)}`);
  // assigned_to lives on the thread, created_by on the message. Both are read back from the database
  // rather than from the response, because the response is not what a later access check consults.
  const thread = sqlite.prepare("SELECT assigned_to FROM communication_threads WHERE customer_id='CUST-PII'").all();
  assert.equal(thread.length, 1, "one thread");
  assert.equal(String(thread[0].assigned_to), email, "assignment comes from the resolved actor, not the body");
  const message = sqlite.prepare("SELECT created_by FROM communication_messages WHERE customer_id='CUST-PII'").all();
  assert.equal(message.length, 1, "one queued message");
  assert.equal(String(message[0].created_by), email, "and so does authorship");
});

test("PII-17: a role without communications.manage cannot queue contact at all", async () => {
  const { headers } = await contactWorld("auditor");
  const result = await contact(headers, { customerKey: "CUST-PII", channel: "call", target: "primary", purpose: "marketing" });
  assert.equal(result.status, 403, `permission is required: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(exposes(result.body, RAW_PHONE), false, "and nothing leaks in the refusal");
});
