import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";
import { createD1 } from "./helpers/d1.mjs";

// ---------------------------------------------------------------------------
// AI bot call outcomes -> CRM. Real execution of the real disposition module.
// The property that matters: a bot call must leave exactly the same trail a human
// rep's call leaves (attempt, activity, lead state, callback, escalation), using
// one vocabulary, so the existing CRM rules fire - and a bot must never be able
// to declare money received.
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

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// batch() is one transaction in D1: see tests/helpers/d1.mjs. The loop this replaced committed
// each statement as it went, so any atomicity claim below was measured against the wrong machine.
const makeD1 = (sqlite, options) => createD1(sqlite, options);

// Pull the DDL for shared CRM tables out of the ROUTES THAT OWN THEM, never from the module under
// test. The first version of this suite declared crm_activities itself and therefore agreed with a
// column name (customer_id/summary) that no deployed database has - the bug only surfaced against
// real staging. Owning-module DDL makes that class of drift a test failure instead.
function applyOwnedDdl(sqlite, path) {
  const source = read(path);
  for (const match of source.matchAll(/\.prepare\(\s*(["'`])([\s\S]*?)\1/g)) {
    if (/^\s*CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(match[2])) { try { sqlite.exec(match[2]); } catch { /* index for a table this suite does not need */ } }
  }
}

const BOT = "haptik_voice";
function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,service_code TEXT NOT NULL,package_name TEXT,provider_id TEXT,status TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT,total_amount REAL NOT NULL,currency TEXT DEFAULT 'INR',created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL)");
  // crm_contacts / crm_activities / crm_tasks / lead_work_items as the CRM route really defines them.
  applyOwnedDdl(sqlite, "app/api/crm/route.ts");
  return { sqlite, db };
}

async function leadWorld(options = {}) {
  const { sqlite, db } = fresh();
  const disposition = await import("../lib/bot-call-disposition.ts");
  await disposition.ensureBotCallDispositionTables(db);
  const haptik = await import("../lib/haptik-integration-governance.ts");
  await haptik.ensureHaptikTables(db);
  const now = Date.now();
  const phone = options.phone ?? "9876500101";
  sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,email,area,stage,owner,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("CU-BOT", "Asha Verma", phone, "asha@example.test", "Bengaluru East", "New lead", "Unassigned", "Website", now, now);
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,call_attempts,whatsapp_attempts,recycle_cycle,opt_out,created_at,updated_at) VALUES (?,?,?,?,?,?,'active','day_1',1,?,?,?,0,0,0,0,?,?)")
    .run("LEAD-BOT", "CU-BOT", "Website", "grooming", "Unassigned", "Sales Manager", now, now + 600000, now + 1800000, now, now);
  return { sqlite, db, disposition, haptik, phone };
}

// ---------------------------------------------------------------------------
// 1. The founder's tag list is all present and drives the CRM.
// ---------------------------------------------------------------------------
test("every requested outcome tag exists and maps onto the CRM's own attempt vocabulary", async () => {
  const { BOT_CALL_TAGS, BOT_CALL_TAG_CODES } = await import("../lib/bot-call-disposition.ts");
  for (const required of ["callback_requested", "converted", "rnr", "interested", "paid", "cross_sell_potential", "human_intervention_needed", "not_interested", "do_not_call", "wrong_number", "language_barrier", "complaint", "voicemail", "busy", "info_shared"]) {
    assert.ok(BOT_CALL_TAG_CODES.includes(required), `missing tag: ${required}`);
  }
  // The CRM's lead_attempts CHECK vocabulary (app/api/revenue-crm/route.ts) is the only outcome set
  // the rest of the CRM understands - every bot tag must land inside it.
  const crmRoute = read("app/api/revenue-crm/route.ts");
  const allowed = ["RNR", "Connected", "Interested", "Not interested", "Invalid", "Opt-out"];
  for (const value of allowed) assert.ok(crmRoute.includes(`"${value}"`), `CRM vocabulary drifted: ${value}`);
  for (const tag of BOT_CALL_TAGS) assert.ok(allowed.includes(tag.crmOutcome), `${tag.code} maps to an outcome the CRM does not accept`);
  // No-contact tags must map to RNR so the 3-RNR escalation rule can count them.
  for (const code of ["rnr", "busy", "voicemail"]) assert.equal(BOT_CALL_TAGS.find(tag => tag.code === code).crmOutcome, "RNR");
});

test("a bot call writes the attempt, the activity and the lead state a human rep's call writes", async () => {
  const { sqlite, db, disposition } = await leadWorld();
  const result = await disposition.recordBotCallDisposition(db, {
    idempotencyKey: "call-1", leadId: "LEAD-BOT", botProvider: BOT, callRef: "HAPTIK-CALL-1",
    primaryTag: "interested", secondaryTags: ["cross_sell_potential"], crossSellServices: ["boarding", "dog_training"],
    notes: "Wants grooming this week, asked about boarding for Diwali", talkTimeSeconds: 96, sentiment: "positive",
    transcriptRef: "r2://haptik/transcripts/call-1.json", actorId: BOT,
  });
  assert.equal(result.primaryTag, "interested");
  assert.deepEqual(result.tags, ["interested", "cross_sell_potential"]);
  assert.equal(result.crmOutcome, "Interested");
  assert.equal(result.moneyVerified, false, "the bot never claims to have verified money");

  const attempt = sqlite.prepare("SELECT channel,outcome,sequence_number,provider_status FROM lead_attempts WHERE lead_id='LEAD-BOT'").all();
  assert.equal(attempt.length, 1);
  assert.equal(attempt[0].channel, "call", "a voice bot call is a call attempt, same as a rep's");
  assert.equal(attempt[0].outcome, "Interested");
  assert.equal(attempt[0].sequence_number, 1);
  assert.equal(attempt[0].provider_status, "bot_completed");

  const activity = sqlite.prepare("SELECT type,title,detail FROM crm_activities WHERE contact_id='CU-BOT'").get();
  assert.equal(activity.type, "bot_call");
  assert.match(activity.title, /haptik_voice bot call/);
  const detail = JSON.parse(activity.detail);
  assert.deepEqual(detail.crossSellServices, ["boarding", "dog_training"]);
  assert.equal(detail.transcriptRef, "r2://haptik/transcripts/call-1.json");
  assert.equal(detail.talkTimeSeconds, 96);

  const lead = sqlite.prepare("SELECT status,last_outcome,call_attempts,first_action_at,next_action_at FROM lead_work_items WHERE id='LEAD-BOT'").get();
  assert.equal(lead.status, "qualified", "a positive signal moves the lead forward");
  assert.equal(lead.last_outcome, "interested");
  assert.equal(lead.call_attempts, 1);
  assert.ok(lead.first_action_at, "the lead is no longer untouched, so its first-response clock is satisfied");
  assert.ok(lead.next_action_at, "a follow-up time is set rather than leaving the lead to rot");

  const contact = sqlite.prepare("SELECT stage,next_action FROM crm_contacts WHERE id='CU-BOT'").get();
  assert.equal(contact.stage, "Qualified");

  const stored = sqlite.prepare("SELECT primary_tag,tags_json,cross_sell_services_json,call_ref,sentiment FROM bot_call_dispositions").get();
  assert.equal(stored.call_ref, "HAPTIK-CALL-1");
  assert.equal(stored.sentiment, "positive");
  assert.deepEqual(JSON.parse(stored.cross_sell_services_json), ["boarding", "dog_training"]);
});

test("bot dispositions are idempotent - a retried webhook does not double-count the attempt", async () => {
  const { sqlite, db, disposition } = await leadWorld();
  const first = await disposition.recordBotCallDisposition(db, { idempotencyKey: "call-retry", leadId: "LEAD-BOT", botProvider: BOT, primaryTag: "rnr", actorId: BOT });
  const replay = await disposition.recordBotCallDisposition(db, { idempotencyKey: "call-retry", leadId: "LEAD-BOT", botProvider: BOT, primaryTag: "rnr", actorId: BOT });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(replay.id, first.id);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM lead_attempts WHERE lead_id='LEAD-BOT'").get().c, 1, "one call, one attempt");
  assert.equal(sqlite.prepare("SELECT call_attempts FROM lead_work_items WHERE id='LEAD-BOT'").get().call_attempts, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM crm_activities").get().c, 1);
});

// ---------------------------------------------------------------------------
// 2. Callback, escalation, opt-out: each becomes a real governed record.
// ---------------------------------------------------------------------------
test("a callback tag schedules a real governed callback at the time the customer asked for", async () => {
  const { sqlite, db, disposition } = await leadWorld();
  const callbackAt = Date.now() + 3 * 3600_000;
  const result = await disposition.recordBotCallDisposition(db, {
    idempotencyKey: "call-cb", leadId: "LEAD-BOT", botProvider: BOT, primaryTag: "callback_requested",
    callbackAt, notes: "Asked to be called after 6pm", actorId: BOT,
  });
  assert.ok(result.callbackId, "a real callback row is created");
  const callback = sqlite.prepare("SELECT lead_id,requested_at,status,reason FROM lead_callbacks WHERE id=?").get(result.callbackId);
  assert.equal(callback.lead_id, "LEAD-BOT");
  assert.equal(Number(callback.requested_at), callbackAt, "the promise is at the customer's real requested time");
  assert.equal(callback.status, "scheduled");
  const lead = sqlite.prepare("SELECT next_action_at,status FROM lead_work_items WHERE id='LEAD-BOT'").get();
  assert.equal(Number(lead.next_action_at), callbackAt, "the worklist and the callback queue agree");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM lead_callback_events WHERE lead_id='LEAD-BOT' AND event_type='scheduled'").get().c, 1, "the governed ledger recorded it, not a raw insert");

  // A callback tag without a real future time is refused rather than stored as a placeholder.
  await assert.rejects(
    () => disposition.recordBotCallDisposition(db, { idempotencyKey: "call-cb-bad", leadId: "LEAD-BOT", botProvider: BOT, primaryTag: "callback_requested", actorId: BOT }),
    /real future time/,
  );
  await assert.rejects(
    () => disposition.recordBotCallDisposition(db, { idempotencyKey: "call-cb-past", leadId: "LEAD-BOT", botProvider: BOT, primaryTag: "callback_requested", callbackAt: Date.now() - 60000, actorId: BOT }),
    /real future time/,
  );
});

test("needs-a-human and complaint tags open a real case in the queue Ops already works", async () => {
  const { sqlite, db, disposition } = await leadWorld();
  const needsHuman = await disposition.recordBotCallDisposition(db, {
    idempotencyKey: "call-human", leadId: "LEAD-BOT", botProvider: BOT, primaryTag: "human_intervention_needed",
    notes: "Customer has a medical question about her senior dog the bot must not answer", actorId: BOT,
  });
  assert.equal(needsHuman.escalated, true);
  assert.ok(needsHuman.caseId, "a real case exists, not just a tag nobody sees");
  const opened = sqlite.prepare("SELECT case_type,severity,status,owner_team,customer_id FROM unified_cases WHERE id=?").get(needsHuman.caseId);
  assert.equal(opened.case_type, "lead_escalation");
  assert.equal(opened.status, "open");
  assert.equal(opened.owner_team, "sales");
  assert.equal(opened.customer_id, "CU-BOT");
  assert.equal(sqlite.prepare("SELECT next_action FROM crm_contacts WHERE id='CU-BOT'").get().next_action, "Human follow-up required");

  const complaint = await disposition.recordBotCallDisposition(db, {
    idempotencyKey: "call-complaint", leadId: "LEAD-BOT", botProvider: BOT, primaryTag: "complaint",
    notes: "Unhappy about the last groomer being late", actorId: BOT,
  });
  const complaintCase = sqlite.prepare("SELECT case_type,severity,owner_team FROM unified_cases WHERE id=?").get(complaint.caseId);
  assert.equal(complaintCase.case_type, "customer_complaint");
  assert.equal(complaintCase.severity, "high", "a complaint is not filed as a routine follow-up");
  assert.equal(complaintCase.owner_team, "customer_experience");
});

test("a do-not-call outcome opts the lead out and closes it, so no bot or rep dials again", async () => {
  const { sqlite, db, disposition } = await leadWorld();
  const result = await disposition.recordBotCallDisposition(db, { idempotencyKey: "call-dnc", leadId: "LEAD-BOT", botProvider: BOT, primaryTag: "do_not_call", notes: "Asked not to be contacted again", actorId: BOT });
  assert.equal(result.optedOut, true);
  assert.equal(result.crmOutcome, "Opt-out");
  const lead = sqlite.prepare("SELECT status,opt_out FROM lead_work_items WHERE id='LEAD-BOT'").get();
  assert.equal(lead.opt_out, 1);
  assert.equal(lead.status, "closed");
  assert.equal(sqlite.prepare("SELECT stage FROM crm_contacts WHERE id='CU-BOT'").get().stage, "Do not contact");

  // The outbound batcher's consent filter now genuinely excludes this lead.
  const assignment = await import("../lib/lead-assignment-governance.ts");
  const source = read("lib/lead-assignment-governance.ts");
  assert.ok(/l\.opt_out=0/.test(source), "outbound batching filters opted-out leads");
  void assignment;
});

test("contradictory or unsupported tags are refused instead of producing an incoherent CRM", async () => {
  const { sqlite, db, disposition } = await leadWorld();
  for (const [primary, secondary] of [["interested", "not_interested"], ["do_not_call", "callback_requested"], ["wrong_number", "converted"], ["not_interested", "cross_sell_potential"]]) {
    await assert.rejects(
      () => disposition.recordBotCallDisposition(db, { idempotencyKey: `bad-${primary}-${secondary}`, leadId: "LEAD-BOT", botProvider: BOT, primaryTag: primary, secondaryTags: [secondary], crossSellServices: ["boarding"], callbackAt: Date.now() + 3600_000, actorId: BOT }),
      /Contradictory bot call tags/,
      `${primary} + ${secondary} must be refused`,
    );
  }
  await assert.rejects(() => disposition.recordBotCallDisposition(db, { idempotencyKey: "bad-tag", leadId: "LEAD-BOT", botProvider: BOT, primaryTag: "vibes_good", actorId: BOT }), /Unsupported bot call tag/);
  await assert.rejects(() => disposition.recordBotCallDisposition(db, { idempotencyKey: "bad-xsell", leadId: "LEAD-BOT", botProvider: BOT, primaryTag: "cross_sell_potential", actorId: BOT }), /at least one named service/);
  await assert.rejects(() => disposition.recordBotCallDisposition(db, { idempotencyKey: "", leadId: "LEAD-BOT", botProvider: BOT, primaryTag: "rnr", actorId: BOT }), /idempotency key is required/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM bot_call_dispositions").get().c, 0, "a refused disposition writes nothing at all");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM lead_attempts").get().c, 0);
});

// ---------------------------------------------------------------------------
// 3. Bot RNRs feed the real escalation rule.
// ---------------------------------------------------------------------------
test("three bot RNRs inside the window escalate the lead exactly like three human RNRs", async () => {
  const { sqlite, db, disposition } = await leadWorld();
  const assignment = await import("../lib/lead-assignment-governance.ts");
  await assignment.ensureLeadAssignmentTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  const now = Date.now();
  for (const email of ["rep.one@pawspace.in", "rep.two@pawspace.in"]) {
    sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)").run(`USR-${email}`, email, "Rep", "sales_associate", now, now);
  }
  const policy = await assignment.saveLeadAssignmentPolicy(db, { name: "Bengaluru grooming sales", teamCode: "sales_blr", serviceCodes: ["grooming"], cityIds: ["Bengaluru"], maxActiveWorkload: 5, continuityEnabled: false, requireShift: false, fallbackQueue: "sales_overflow", effectiveFrom: now - 3600_000, reason: "Bot RNR escalation test policy", actorId: "founder@pawspace.in" });
  await assignment.activateLeadAssignmentPolicy(db, { policyId: policy.id, approvalReference: "BOARD-2026-07", reason: "Activating for the bot RNR test", actorId: "founder@pawspace.in" });
  for (const email of ["rep.one@pawspace.in", "rep.two@pawspace.in"]) {
    await assignment.saveLeadAssignmentMember(db, { employeeEmail: email, teamCode: "sales_blr", serviceCodes: ["grooming"], cityIds: ["Bengaluru"], active: true, actorId: "founder@pawspace.in" });
  }
  const assigned = await assignment.assignLead(db, { leadId: "LEAD-BOT", idempotencyKey: "assign-bot", reason: "new_lead", actorId: "system", asOf: now });
  const firstOwner = assigned.assignment.employee_email;
  sqlite.prepare("UPDATE lead_work_items SET assigned_at=?,owner=? WHERE id='LEAD-BOT'").run(now, firstOwner);

  const first = await disposition.recordBotCallDisposition(db, { idempotencyKey: "rnr-1", leadId: "LEAD-BOT", botProvider: BOT, primaryTag: "rnr", actorId: BOT, asOf: now + 60_000 });
  assert.equal(first.autoReassignment?.triggered, false, "one RNR does not escalate");
  await disposition.recordBotCallDisposition(db, { idempotencyKey: "rnr-2", leadId: "LEAD-BOT", botProvider: BOT, primaryTag: "voicemail", actorId: BOT, asOf: now + 120_000 });
  const third = await disposition.recordBotCallDisposition(db, { idempotencyKey: "rnr-3", leadId: "LEAD-BOT", botProvider: BOT, primaryTag: "busy", actorId: BOT, asOf: now + 180_000 });

  assert.equal(third.autoReassignment?.triggered, true, "three bot no-contact attempts escalate the lead");
  assert.notEqual(third.autoReassignment.newOwner, firstOwner, "the lead moves to a different rep");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM lead_attempts WHERE lead_id='LEAD-BOT' AND outcome='RNR'").get().c, 3, "voicemail and busy count as no-contact attempts too");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM lead_assignments WHERE lead_id='LEAD-BOT' AND status='current'").get().c, 1);
});

// ---------------------------------------------------------------------------
// 4. Money honesty: converted/paid are CLAIMS awaiting reconciliation.
// ---------------------------------------------------------------------------
test("a bot saying 'paid' records a claim for reconciliation and moves no money", async () => {
  const { sqlite, db, disposition } = await leadWorld();
  const result = await disposition.recordBotCallDisposition(db, {
    idempotencyKey: "call-paid", leadId: "LEAD-BOT", botProvider: BOT, primaryTag: "paid", secondaryTags: ["converted"],
    notes: "Customer says she paid on the UPI link during the call", actorId: BOT,
  });
  assert.equal(result.reconciliationStatus, "pending_reconciliation");
  assert.deepEqual(result.claimTags.sort(), ["converted", "paid"]);
  assert.equal(result.moneyVerified, false);
  // Nothing was written to any money table.
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM booking_payments").get().c, 0, "a bot claim never creates a payment");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM canonical_bookings").get().c, 0, "and never creates a booking");
  assert.equal(sqlite.prepare("SELECT converted_booking_id FROM lead_work_items WHERE id='LEAD-BOT'").get().converted_booking_id, null, "conversion stays payment-gated on the real booking");

  const pending = await disposition.pendingBotCallClaims(db);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].dispositionId, result.id);

  await assert.rejects(() => disposition.reconcileBotCallClaim(db, { dispositionId: result.id, outcome: "maybe", note: "unsure", actorId: "ops@pawspace.in" }), /'confirmed' or 'not_found'/);
  await assert.rejects(() => disposition.reconcileBotCallClaim(db, { dispositionId: result.id, outcome: "confirmed", note: "ok", actorId: "ops@pawspace.in" }), /reconciliation note is required/);

  const reconciled = await disposition.reconcileBotCallClaim(db, { dispositionId: result.id, outcome: "confirmed", note: "Matched payment PAY-123 against booking BK-99", actorId: "ops@pawspace.in" });
  assert.equal(reconciled.reconciliationStatus, "reconciled_confirmed");
  await assert.rejects(() => disposition.reconcileBotCallClaim(db, { dispositionId: result.id, outcome: "not_found", note: "Trying to reconcile it a second time", actorId: "ops.two@pawspace.in" }), /no pending money\/booking claim/);
  assert.equal((await disposition.pendingBotCallClaims(db)).length, 0);
});

test("the outcome summary is computed from real dispositions and is honest about money", async () => {
  const { sqlite, db, disposition } = await leadWorld();
  const now = Date.now();
  sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,email,area,stage,owner,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("CU-BOT2", "Rohit Menon", "9876500102", "rohit@example.test", "Bengaluru East", "New lead", "Unassigned", "Website", now, now);
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,call_attempts,whatsapp_attempts,recycle_cycle,opt_out,created_at,updated_at) VALUES (?,?,?,?,?,?,'active','day_1',1,?,?,?,0,0,0,0,?,?)")
    .run("LEAD-BOT2", "CU-BOT2", "Website", "grooming", "Unassigned", "Sales Manager", now, now + 600000, now + 1800000, now, now);

  await disposition.recordBotCallDisposition(db, { idempotencyKey: "s-1", leadId: "LEAD-BOT", botProvider: BOT, primaryTag: "interested", secondaryTags: ["cross_sell_potential"], crossSellServices: ["boarding"], actorId: BOT });
  await disposition.recordBotCallDisposition(db, { idempotencyKey: "s-2", leadId: "LEAD-BOT2", botProvider: BOT, primaryTag: "rnr", actorId: BOT });
  await disposition.recordBotCallDisposition(db, { idempotencyKey: "s-3", leadId: "LEAD-BOT2", botProvider: BOT, primaryTag: "paid", actorId: BOT });

  const summary = await disposition.botCallDispositionSummary(db, {});
  assert.equal(summary.calls, 3);
  assert.equal(summary.contacted, 2, "the RNR is not counted as a contact");
  assert.equal(summary.contactRate, 0.667);
  assert.equal(summary.byTag.interested, 1);
  assert.equal(summary.byTag.cross_sell_potential, 1);
  assert.equal(summary.byTag.rnr, 1);
  assert.equal(summary.crossSellInterest.boarding, 1);
  assert.equal(summary.pendingReconciliation, 1);
  assert.equal(summary.truth.moneyVerifiedByBot, false);
  assert.equal(summary.truth.attemptsFeedTheSameCrmRules, true);
  assert.ok(summary.tagVocabulary.length >= 15, "the vocabulary is published for the CRM UI");

  const perLead = await disposition.botCallDispositionSummary(db, { leadId: "LEAD-BOT2" });
  assert.equal(perLead.calls, 2, "a per-lead view shows only that lead's calls");
});

// ---------------------------------------------------------------------------
// 5. Resolving the lead: by id, by dialled number, and never inventing one.
// ---------------------------------------------------------------------------
test("a bot call is matched to an existing lead by the dialled number, not a bot-specific id", async () => {
  const { sqlite, db, disposition, phone } = await leadWorld();
  const byPhone = await disposition.recordBotCallDisposition(db, { idempotencyKey: "phone-1", phone: `+91 ${phone}`, botProvider: BOT, primaryTag: "interested", actorId: BOT });
  assert.equal(byPhone.leadId, "LEAD-BOT", "the formatted number resolves to the CRM's existing lead");
  assert.equal(byPhone.contactId, "CU-BOT");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM crm_contacts").get().c, 1, "no duplicate contact was forked for the bot");

  await assert.rejects(
    () => disposition.recordBotCallDisposition(db, { idempotencyKey: "phone-unknown", phone: "9000000000", botProvider: BOT, primaryTag: "interested", actorId: BOT }),
    /capture the lead before recording a call outcome/,
    "an outcome for a number the CRM has never seen is refused rather than inventing a lead",
  );
  await assert.rejects(
    () => disposition.recordBotCallDisposition(db, { idempotencyKey: "no-target", botProvider: BOT, primaryTag: "interested", actorId: BOT }),
    /lead id or a valid dialled phone number/,
  );
  await assert.rejects(
    () => disposition.recordBotCallDisposition(db, { idempotencyKey: "bad-lead", leadId: "LEAD-NOPE", botProvider: BOT, primaryTag: "interested", actorId: BOT }),
    /Lead not found/,
  );
});

// ---------------------------------------------------------------------------
// 6. Haptik layer audit: the three defects found alongside this build.
// ---------------------------------------------------------------------------
test("Haptik lead capture attaches to an existing CRM contact instead of forking a duplicate", async () => {
  const { sqlite, db, haptik } = await leadWorld();
  const captured = await haptik.captureHaptikLead(db, { idempotencyKey: "hl-1", phone: "+91 98765 00101", name: "Asha V", service: "grooming", city: "Bengaluru", actorId: BOT });
  assert.equal(captured.contactId, "CU-BOT", "the website lead and the bot lead are the same customer");
  assert.equal(captured.leadId, "LEAD-BOT", "and the same open lead, so history is not split");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM crm_contacts").get().c, 1);
  const replay = await haptik.captureHaptikLead(db, { idempotencyKey: "hl-1", phone: "+91 98765 00101", actorId: BOT });
  assert.equal(replay.duplicatePrevented, true);
});

test("Haptik callbacks go through the governed callback ledger, with no past-dated placeholders", async () => {
  const { sqlite, db, haptik } = await leadWorld();
  const preferredAt = Date.now() + 2 * 3600_000;
  const scheduled = await haptik.captureHaptikCallback(db, { idempotencyKey: "hcb-1", phone: "9876500101", leadId: "LEAD-BOT", preferredAt, reason: "Customer asked for a call at 5pm", actorId: BOT });
  assert.equal(scheduled.requestedAt, preferredAt);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM lead_callback_events WHERE lead_id='LEAD-BOT' AND event_type='scheduled'").get().c, 1, "the governed ledger recorded it");
  assert.equal(Number(sqlite.prepare("SELECT next_action_at FROM lead_work_items WHERE id='LEAD-BOT'").get().next_action_at), preferredAt, "the worklist agrees with the promise");

  // A bot passing no preferred time (or a stale one) must not create a past-dated callback.
  const noTime = await haptik.captureHaptikCallback(db, { idempotencyKey: "hcb-2", phone: "9876500101", leadId: "LEAD-BOT", reason: "Customer asked for a call back soon", actorId: BOT });
  assert.ok(noTime.requestedAt > Date.now(), "a missing preferred time becomes the soonest real slot, not 'now' in the past");
  const live = sqlite.prepare("SELECT COUNT(*) c FROM lead_callbacks WHERE lead_id='LEAD-BOT' AND status='scheduled'").get();
  assert.equal(live.c, 1, "only one live promise to the customer at a time");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM lead_callbacks WHERE lead_id='LEAD-BOT' AND status='superseded'").get().c, 1, "the earlier promise stays visible in history");
});

test("a Haptik booking request reads the lead's real contact and never moves money", async () => {
  const { sqlite, db, haptik } = await leadWorld();
  const requested = await haptik.requestHaptikBooking(db, { idempotencyKey: "hbr-1", phone: "9999999999", leadId: "LEAD-BOT", serviceCode: "grooming", cityId: "blr", zoneId: "blr-east", preferredSlot: "2026-07-20 10:00", petName: "Bruno", actorId: BOT });
  assert.equal(requested.contactId, "CU-BOT", "the request is filed against the lead's real contact, not a guessed id");
  assert.equal(requested.status, "booking_requested");
  assert.match(requested.note, /no money moved/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM canonical_bookings").get().c, 0, "the bot creates a governed REQUEST, never a confirmed booking");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM booking_payments").get().c, 0);
  assert.equal(sqlite.prepare("SELECT status,last_outcome FROM lead_work_items WHERE id='LEAD-BOT'").get().status, "qualified");

  await assert.rejects(
    () => haptik.requestHaptikBooking(db, { idempotencyKey: "hbr-bad", phone: "9876500101", leadId: "LEAD-NOPE", serviceCode: "grooming", actorId: BOT }),
    /Lead not found/,
  );
});

// ---------------------------------------------------------------------------
// 7. Surfaces and guards.
// ---------------------------------------------------------------------------
test("the bot outcome endpoints are permission-gated and the Haptik webhook stays key-authenticated", () => {
  const gateway = read("lib/api-gateway.ts");
  assert.ok(/url\.pathname==="\/api\/bot-call-outcomes"/.test(gateway), "the gateway maps the internal bot-outcome route");
  assert.ok(/communications\.call/.test(gateway.slice(gateway.indexOf("/api/bot-call-outcomes"), gateway.indexOf("/api/bot-call-outcomes") + 400)), "recording an outcome needs a calling permission");
  const route = read("app/api/bot-call-outcomes/route.ts");
  assert.ok(/authorize\(request,"customers\.manage"\)/.test(route), "reconciling a money claim needs a manage permission");
  const haptikRoute = read("app/api/haptik/route.ts");
  assert.ok(/record_call_outcome/.test(haptikRoute), "Haptik can post the post-call outcome");
  assert.ok(/HAPTIK_API_KEY/.test(haptikRoute) && /Invalid Haptik credentials/.test(haptikRoute), "the webhook stays fail-closed and key-authenticated");
});

test("shared CRM tables are written with the column names their owning route defines", () => {
  const crmRoute = read("app/api/crm/route.ts"), moduleSource = read("lib/bot-call-disposition.ts");
  for (const table of ["crm_contacts", "crm_activities", "lead_work_items"]) {
    const owner = crmRoute.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([^"]*)\\)`));
    if (!owner) continue;
    const ownerColumns = owner[1].split(",").map(part => part.trim().split(/\s+/)[0]);
    for (const insert of moduleSource.matchAll(new RegExp(`INSERT (?:OR IGNORE )?INTO ${table} \\(([a-z_,]+)\\)`, "g"))) {
      for (const column of insert[1].split(",")) {
        assert.ok(ownerColumns.includes(column), `${table}.${column} does not exist in the owning route's schema`);
      }
    }
    for (const update of moduleSource.matchAll(new RegExp(`UPDATE ${table} SET ([^"]+?) WHERE`, "g"))) {
      for (const assignment of update[1].split(",")) {
        const column = assignment.trim().split(/[=+]/)[0].trim();
        if (column && /^[a-z_]+$/.test(column)) assert.ok(ownerColumns.includes(column), `${table}.${column} does not exist in the owning route's schema`);
      }
    }
  }
});

test("bot call modules do not fabricate values or use banned DB access", () => {
  for (const path of ["lib/bot-call-disposition.ts", "lib/haptik-integration-governance.ts"]) {
    const source = read(path);
    assert.ok(!/Math\.random/.test(source), `${path} must not fabricate values with Math.random`);
    assert.ok(!/globalThis\.__D1__/.test(source), `${path} must not use the banned globalThis D1 pattern`);
  }
  // The disposition module must never write to a money table.
  const source = read("lib/bot-call-disposition.ts");
  for (const table of ["booking_payments", "canonical_bookings", "pawspace_wallet_ledger", "booking_invoices"]) {
    assert.ok(!new RegExp(`(INSERT INTO|UPDATE|DELETE FROM)\\s+${table}`).test(source), `the bot must never write ${table}`);
  }
});
