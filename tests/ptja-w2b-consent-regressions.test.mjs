/**
 * PawSpace Total Journey Audit, Wave 2 Batch B — consent that does not survive, and consent that only
 * one of two outbound engines can see.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_CONSENT_DB__", "__PTJA_CONSENT_ENV__");

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

function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_CONSENT_DB__ = db;
  globalThis.__PTJA_CONSENT_ENV__ = {};
  return { sqlite, db };
}

// =====================================================================================================
// PTJA-W2B-C02 — a channel-only preference write ERASES the customer's recorded opt-out
//
// setCommunicationPreference upserts with
//   ON CONFLICT(customer_id) DO UPDATE SET service_updates=excluded.service_updates,
//     marketing=excluded.marketing, preferred_channel=excluded.preferred_channel, ...
// Every column is overwritten from the incoming row unconditionally. The route deliberately passes NULL
// for anything the request omitted - `typeof body.serviceUpdates==="boolean" ? body.serviceUpdates :
// null` - so it distinguishes "set to false" from "not mentioned", and then the upsert throws that
// distinction away.
//
// MEASURED, four calls in one world: the customer opted out of service updates and marketing; the next
// service_recovery message was correctly SUPPRESSED with reason service_updates_opt_out; a preference
// write that mentioned only preferredChannel:"email" then set BOTH consent columns to NULL; and the
// identical message was QUEUED for delivery seconds later. The prior decision is not recoverable from
// that table afterwards - the consent record itself is destroyed.
//
// An omitted field is not a decision. Each column now keeps its recorded value unless the caller
// actually supplied one.
// =====================================================================================================

test("W2B-C02: a channel-only preference write preserves the recorded opt-out", async () => {
  const { sqlite, db } = world();
  const engine = await import("../lib/communication-engine.ts");
  await engine.ensureCommunicationTables(db);

  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-A','ops.admin@pawspace.test','Ops admin','admin','active',?,?)").bind(now, now).run();
  const route = await import("../app/api/communications/route.ts");
  const post = async (body) => {
    const response = await route.POST(new Request("https://uat.pawspace.in/api/communications", {
      method: "POST",
      headers: { "content-type": "application/json", "oai-authenticated-user-email": "ops.admin@pawspace.test", "oai-authenticated-user-full-name": "Ops%20admin", "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8" },
      body: JSON.stringify(body),
    }));
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  await post({ action: "preference", customerId: "CUST-OPTOUT", serviceUpdates: false, marketing: false, source: "customer_self_service_opt_out" });
  const optedOut = sqlite.prepare("SELECT service_updates,marketing FROM communication_preferences WHERE customer_id='CUST-OPTOUT'").get();
  assert.equal(Number(optedOut.service_updates), 0, "the opt-out is recorded");

  await post({ action: "preference", customerId: "CUST-OPTOUT", preferredChannel: "email" });
  const after = sqlite.prepare("SELECT service_updates,marketing,preferred_channel FROM communication_preferences WHERE customer_id='CUST-OPTOUT'").get();
  // Asserted against the RAW value, not Number(): Number(null) is 0, so a Number() comparison passes
  // on an erased column and would have made this whole case vacuous.
  assert.notEqual(after.service_updates, null,
    `a write that never mentioned consent must not erase it: ${JSON.stringify(after)}`);
  assert.equal(Number(after.service_updates), 0, "the opt-out still reads as opted out");
  assert.notEqual(after.marketing, null, `nor the marketing opt-out beside it: ${JSON.stringify(after)}`);
  assert.equal(Number(after.marketing), 0, "which also still reads as opted out");
  assert.equal(String(after.preferred_channel), "email", "while the change that WAS asked for still applies");
});

test("W2B-C02: an explicit consent change still applies, in both directions", async () => {
  // Non-vacuity. Making every column sticky would satisfy the case above and make consent unchangeable.
  const { sqlite, db } = world();
  const engine = await import("../lib/communication-engine.ts");
  await engine.ensureCommunicationTables(db);

  await engine.setCommunicationPreference(db, { customerId: "CUST-1", serviceUpdates: false, marketing: false, source: "opt_out" });
  await engine.setCommunicationPreference(db, { customerId: "CUST-1", marketing: true, source: "opt_in" });
  const after = sqlite.prepare("SELECT service_updates,marketing FROM communication_preferences WHERE customer_id='CUST-1'").get();
  assert.equal(Number(after.marketing), 1, "an explicit opt-in applies");
  assert.notEqual(after.service_updates, null, `and leaves the flag it did not mention alone: ${JSON.stringify(after)}`);
  assert.equal(Number(after.service_updates), 0, "still opted out of service updates");

  await engine.setCommunicationPreference(db, { customerId: "CUST-1", marketing: false, source: "opt_out_again" });
  assert.equal(Number(sqlite.prepare("SELECT marketing FROM communication_preferences WHERE customer_id='CUST-1'").get().marketing), 0,
    "and an explicit opt-out applies again");
});

// =====================================================================================================
// PTJA-W2B-C08 — two consent stores, and each outbound engine reads only its own
//
// lib/communication-engine.ts consent() reads communication_preferences.
// lib/crm-automation-governance.ts automationDecision reads customer_contact_preferences.
// Neither reads the other's, and both are written by live surfaces.
//
// MEASURED: a customer recorded a marketing OPT-OUT through /api/communications. Engine A - the
// governed outbox - suppressed the next marketing message with reason marketing_opt_out. Engine B -
// /api/crm-automation - returned {"allowed":true,"reason":"allowed"} for the same customer, the same
// channel and the same purpose minutes later, and queued it. Any campaign run through the CRM
// automation engine ignored every opt-out ever recorded on the communications preference API, and
// lib/haptik-outbound-governance.ts and lib/whatsapp-uat-adapter.ts read the same blind store.
//
// The correction does not pick a winner between the two tables, because that would silently discard
// whichever set of consent decisions lost. An opt-out recorded ANYWHERE is honoured: automationDecision
// now also consults communication_preferences, and a recorded opt-out in either store blocks. That is
// the only reading under which consent means anything, and it fails closed.
// =====================================================================================================

test("W2B-C08: an opt-out recorded on the communications API blocks CRM automation too", async () => {
  const { db } = world();
  const engine = await import("../lib/communication-engine.ts");
  const automation = await import("../lib/crm-automation-governance.ts");
  await engine.ensureCommunicationTables(db);
  await automation.ensureCrmAutomationGovernance(db);

  // historical consent on the OTHER store, then an opt-out on this one
  await db.prepare("CREATE TABLE IF NOT EXISTS customer_contact_preferences (customer_id TEXT PRIMARY KEY,marketing_consent INTEGER DEFAULT 0,service_consent INTEGER DEFAULT 1,whatsapp_consent INTEGER DEFAULT 0,sms_consent INTEGER DEFAULT 0,email_consent INTEGER DEFAULT 0,source TEXT,updated_by TEXT,updated_at INTEGER)").run();
  await db.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,source,updated_by,updated_at) VALUES ('CUST-X',1,1,1,1,1,'staff','ops',?)").bind(Date.now()).run();
  // An approved, enabled policy, so the decision actually REACHES the consent check. Without this the
  // policy gate blocks first and an assertion on allowed===false would pass for the wrong reason.
  await db.prepare("INSERT OR REPLACE INTO crm_automation_policy (policy_key,enabled,quiet_start_hour,quiet_end_hour,max_contacts,window_hours,max_attempts,retry_minutes,updated_by,updated_at) VALUES ('marketing:whatsapp',1,NULL,NULL,50,24,5,60,'ops',?)").bind(Date.now()).run();
  await engine.setCommunicationPreference(db, { customerId: "CUST-X", marketing: false, serviceUpdates: true, source: "customer_opt_out_request" });

  const decision = await automation.automationDecision(db, {
    customerId: "CUST-X", journeyCode: "winback", channel: "whatsapp", purpose: "marketing",
  });
  assert.equal(decision.allowed, false,
    `an opt-out recorded on either store must block: ${JSON.stringify(decision)}`);
  assert.match(String(decision.reason), /consent|opt_out/,
    `and must block FOR THAT REASON, not incidentally on some other gate: ${JSON.stringify(decision)}`);
});

test("W2B-C08: a customer who has opted in on both stores is still reachable", async () => {
  // Non-vacuity. Blocking whenever either store is silent would stop every campaign.
  const { db } = world();
  const engine = await import("../lib/communication-engine.ts");
  const automation = await import("../lib/crm-automation-governance.ts");
  await engine.ensureCommunicationTables(db);
  await automation.ensureCrmAutomationGovernance(db);

  await db.prepare("CREATE TABLE IF NOT EXISTS customer_contact_preferences (customer_id TEXT PRIMARY KEY,marketing_consent INTEGER DEFAULT 0,service_consent INTEGER DEFAULT 1,whatsapp_consent INTEGER DEFAULT 0,sms_consent INTEGER DEFAULT 0,email_consent INTEGER DEFAULT 0,source TEXT,updated_by TEXT,updated_at INTEGER)").run();
  await db.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,source,updated_by,updated_at) VALUES ('CUST-Y',1,1,1,1,1,'staff','ops',?)").bind(Date.now()).run();
  // An approved, enabled policy, so the decision actually REACHES the consent check. Without this the
  // policy gate blocks first and an assertion on allowed===false would pass for the wrong reason.
  await db.prepare("INSERT OR REPLACE INTO crm_automation_policy (policy_key,enabled,quiet_start_hour,quiet_end_hour,max_contacts,window_hours,max_attempts,retry_minutes,updated_by,updated_at) VALUES ('marketing:whatsapp',1,NULL,NULL,50,24,5,60,'ops',?)").bind(Date.now()).run();
  await engine.setCommunicationPreference(db, { customerId: "CUST-Y", marketing: true, serviceUpdates: true, source: "customer_opt_in" });

  const decision = await automation.automationDecision(db, {
    customerId: "CUST-Y", journeyCode: "winback", channel: "whatsapp", purpose: "marketing",
  });
  assert.equal(decision.allowed, true,
    `a customer who has opted in on both stores stays reachable: ${JSON.stringify(decision)}`);
});

// =====================================================================================================
// PTJA-W2B-C03 — a frequency cap of 0 disables the cap entirely
//
// automationDecision guards the whole frequency-cap block on the TRUTHINESS of max_contacts:
//   if(policy.max_contacts && policy.window_hours){ ...cap... }
// so the stored value 0 is indistinguishable from NULL / "not configured" and the block never runs. The
// write side accepts 0 deliberately - save_policy validates only that the value is finite and not
// negative - so the STRICTEST setting the API offers produces UNLIMITED dispatches.
//
// MEASURED: policy marketing:whatsapp saved with maxContacts 0, then five queue calls - all five
// returned 201 {"queued":true,"reason":"allowed"}. The control with maxContacts 2 capped at two.
//
// Absence and zero are now distinguished: a configured 0 means zero contacts allowed.
// =====================================================================================================

async function automationWorld(maxContacts) {
  const { sqlite, db } = world();
  const automation = await import("../lib/crm-automation-governance.ts");
  await automation.ensureCrmAutomationGovernance(db);
  await db.prepare("CREATE TABLE IF NOT EXISTS customer_contact_preferences (customer_id TEXT PRIMARY KEY,marketing_consent INTEGER DEFAULT 0,service_consent INTEGER DEFAULT 1,whatsapp_consent INTEGER DEFAULT 0,sms_consent INTEGER DEFAULT 0,email_consent INTEGER DEFAULT 0,source TEXT,updated_by TEXT,updated_at INTEGER)").run();
  await db.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,source,updated_by,updated_at) VALUES ('CUST-M',1,1,1,1,1,'staff','ops',?)").bind(Date.now()).run();
  await db.prepare("INSERT OR REPLACE INTO crm_automation_policy (policy_key,enabled,quiet_start_hour,quiet_end_hour,max_contacts,window_hours,max_attempts,retry_minutes,updated_by,updated_at) VALUES ('marketing:whatsapp',1,NULL,NULL,?,24,3,5,'ops',?)")
    .bind(maxContacts, Date.now()).run();
  const decide = () => automation.automationDecision(db, { customerId: "CUST-M", journeyCode: "winback", channel: "whatsapp", purpose: "marketing" });
  return { sqlite, db, automation, decide };
}

test("W2B-C03: a configured frequency cap of 0 allows nothing", async () => {
  const { decide } = await automationWorld(0);
  const decision = await decide();
  assert.equal(decision.allowed, false,
    `the strictest cap the API accepts must not mean "no cap": ${JSON.stringify(decision)}`);
});

test("W2B-C03: an unset cap still means unlimited, and a real cap still counts", async () => {
  // Non-vacuity in both directions: NULL must keep meaning "not configured", and an ordinary cap must
  // still admit dispatches up to its limit.
  const unset = await automationWorld(null);
  assert.equal((await unset.decide()).allowed, true, "an unconfigured cap does not block");

  const capped = await automationWorld(2);
  assert.equal((await capped.decide()).allowed, true, "a cap of 2 admits the first dispatch");
});

// =====================================================================================================
// PTJA-W2B-C06 — a caller-supplied future asOf fabricates SLA breaches and sends premature notices
//
// The only check on asOf was finiteness. The value flows into runStaffAlertSweep as
// `input.asOf ?? Date.now()` and from there into every `due_at<=?` predicate, so a future timestamp
// makes the entire open case backlog look overdue at once.
//
// MEASURED: a case created seconds earlier, with first_response_due_at now+90min and nothing overdue.
// POST /api/staff-alerts {"action":"sweep","asOf":9999999999999} returned created=3 and
// customerNotifications {"attempted":2,"enqueued":2} - real "your case is overdue" messages enqueued to
// a real customer. The control with asOf=Date.now() returned created=0, attempted=0. And because the
// communication idempotency key omits the sweep clock, the GENUINE later notice is then permanently
// duplicatePrevented - the customer gets the wrong message now and never gets the right one.
//
// A sweep answers "what is overdue as of now". It cannot legitimately be asked about the future, so a
// future asOf is refused. Sweeping a PAST moment is untouched - that is a legitimate backfill.
// =====================================================================================================

test("W2B-C06: a future sweep clock sends no customer notices", async () => {
  const { db } = world();
  const alerts = await import("../lib/staff-alert-center.ts");
  await alerts.ensureStaffAlertTables(db);
  const now = Date.now();
  const cases = await import("../lib/unified-case-center.ts");
  await cases.ensureUnifiedCaseTables(db);
  await db.prepare("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)").run();
  await db.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,created_at,updated_at) VALUES ('CUST-1','blr','Meera','+919845012345',?,?)").bind(now, now).run();
  // a case with 90 minutes still to run - nothing is overdue
  await db.prepare("INSERT INTO unified_cases (id,idempotency_key,case_type,severity,status,title,description,customer_id,booking_id,source_type,source_id,owner_team,first_response_due_at,manager_escalation_due_at,resolution_due_at,created_by,updated_by,created_at,updated_at) VALUES ('CASE-1','idem-1','customer_complaint','medium','open','Groomer was late','Late by an hour','CUST-1','BKG-1','manual','src-1','customer_support',?,?,?,'ops','ops',?,?)")
    .bind(now + 90 * 60_000, now + 180 * 60_000, now + 1080 * 60_000, now, now).run();

  const future = await alerts.runStaffAlertSweep(db, { actorId: "ops", asOf: 9999999999999 });
  assert.equal(Number(future.customerNotifications?.enqueued || 0), 0,
    `a sweep evaluating the future must send no customer notice: ${JSON.stringify(future.customerNotifications)}`);
  assert.equal(Number(future.customerNotifications?.attempted || 0), 0, "and must not even attempt one");
});

test("W2B-C06: a genuinely overdue case at the real clock still notifies", async () => {
  // Non-vacuity. Silencing every notice would satisfy the case above and remove the feature.
  const { db } = world();
  const alerts = await import("../lib/staff-alert-center.ts");
  await alerts.ensureStaffAlertTables(db);
  const now = Date.now();
  const cases = await import("../lib/unified-case-center.ts");
  await cases.ensureUnifiedCaseTables(db);
  await db.prepare("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)").run();
  await db.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,created_at,updated_at) VALUES ('CUST-1','blr','Meera','+919845012345',?,?)").bind(now, now).run();
  // genuinely overdue, at the real clock
  await db.prepare("INSERT INTO unified_cases (id,idempotency_key,case_type,severity,status,title,description,customer_id,booking_id,source_type,source_id,owner_team,first_response_due_at,manager_escalation_due_at,resolution_due_at,created_by,updated_by,created_at,updated_at) VALUES ('CASE-2','idem-2','customer_complaint','medium','open','Groomer was late','Late by an hour','CUST-1','BKG-1','manual','src-2','customer_support',?,?,?,'ops','ops',?,?)")
    .bind(now - 90 * 60_000, now - 30 * 60_000, now + 600 * 60_000, now - 200 * 60_000, now).run();

  const real = await alerts.runStaffAlertSweep(db, { actorId: "ops" });
  assert.ok(Number(real.customerNotifications?.attempted || 0) > 0,
    `a genuinely overdue case at the real clock still notifies: ${JSON.stringify(real.customerNotifications)}`);
});
