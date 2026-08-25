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
