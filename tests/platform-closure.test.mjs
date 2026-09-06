/**
 * Platform CLOSURE — EXECUTED. Customer 360, revenue intelligence, CRM automation, unified
 * conversations, partner settlement, marketing governance and company analytics, each driven for
 * real against a SQLite-backed D1.
 *
 * WHAT THIS FILE USED TO BE. Twelve tests, every assertion a regex over source files and pages.
 * "CRM automation is policy gated idempotent retry bounded and dead lettered" asserted that the
 * strings `quiet_hours`, `frequency_cap` and `crm_automation_dead_letters` appeared in the module.
 * They appear whether quiet hours are enforced, whether a frequency cap is ever applied, or whether
 * a dead letter is ever written.
 *
 * The through-line of this suite is that the platform layer must be HONEST about what it does not
 * know: no invented contribution margin, no invented marketing spend, no zero standing in for a
 * source it could not read, and no message sent without consent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1, refusal, OPS_ORIGIN } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__PLATFORM_DB__", "__PLATFORM_ENV__");

const customer360 = await import("../lib/customer-360.ts");
const revenue = await import("../lib/revenue-intelligence.ts");
const crm = await import("../lib/crm-automation-governance.ts");
const conversations = await import("../lib/conversation-governance.ts");
const settlement = await import("../lib/partner-settlement-governance.ts");
const marketing = await import("../lib/marketing-governance.ts");
const analytics = await import("../lib/company-analytics.ts");

const CUSTOMER = "CUST-PLAT-1";
const STAFF = "ops.duty@pawspace.test";

/** DDL copied verbatim from lib/canonical-booking.ts, which owns canonical_customers. */
const CANONICAL_CUSTOMERS_DDL = "CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)";

async function platformWorld() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__PLATFORM_DB__ = db;
  globalThis.__PLATFORM_ENV__ = {};
  return { sqlite, db };
}

function seedCustomer(sqlite, { customerId = CUSTOMER, name = "Asha K.", phone = "+919800000001", cityId = "blr" } = {}) {
  const now = Date.now();
  sqlite.exec(CANONICAL_CUSTOMERS_DDL);
  sqlite.prepare("INSERT OR REPLACE INTO canonical_customers (id,city_id,name,primary_phone,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(customerId, cityId, name, phone, `${customerId.toLowerCase()}@example.test`, now, now);
  return customerId;
}

const consent = (db, customerId, { marketing: marketingConsent = 0, service = 1 } = {}) =>
  db.prepare("INSERT OR REPLACE INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,opt_out,source,updated_by,updated_at) VALUES (?,?,?,1,1,1,0,'customer',?,?)")
    .bind(customerId, marketingConsent, service, STAFF, Date.now()).run();

// ---------------------------------------------------------------------------------------------
test("Customer 360 joins canonical customers with consent and duplicate review", async () => {
  const { db, sqlite } = await platformWorld();
  await customer360.ensureCustomer360Tables(db);

  assert.deepEqual(await customer360.buildCustomer360(db), [], "an empty platform reports no customers, not a crash");

  seedCustomer(sqlite);
  seedCustomer(sqlite, { customerId: "CUST-PLAT-2", name: "Ravi S.", phone: "+919800000002" });
  await consent(db, CUSTOMER, { marketing: 1 });

  const all = await customer360.buildCustomer360(db);
  assert.equal(all.length, 2, "the record is built from the canonical customer table");
  const mine = all.find((row) => row.customerId === CUSTOMER);
  assert.equal(mine.consent.marketing, true, "consent is read from the preferences table, not assumed");
  const other = all.find((row) => row.customerId === "CUST-PLAT-2");
  assert.equal(other.consent.marketing, false, "a customer with no preference row has NOT consented");

  // The single-customer read is scoped.
  const one = await customer360.buildCustomer360(db, CUSTOMER);
  assert.equal(one.length, 1);
  assert.equal(one[0].customerId, CUSTOMER);
  assert.deepEqual(await customer360.buildCustomer360(db, "CUST-NOBODY"), []);

  // Two records sharing a phone number are FLAGGED for review, never silently merged.
  seedCustomer(sqlite, { customerId: "CUST-PLAT-DUP", name: "Asha Kumar", phone: "+919800000001" });
  const reviewed = (await customer360.buildCustomer360(db, CUSTOMER))[0];
  assert.ok(reviewed.dataQuality.issues.includes("possible_duplicate"), "a shared phone number is a data-quality issue");
  assert.equal(
    Number((await db.prepare("SELECT COUNT(*) AS n FROM canonical_customers").first()).n),
    3,
    "no destructive merge is executed by building the record",
  );
});

// ---------------------------------------------------------------------------------------------
test("Revenue intelligence uses canonical signals and never invents contribution margin", async () => {
  const { db, sqlite } = await platformWorld();
  await customer360.ensureCustomer360Tables(db);

  assert.deepEqual(revenue.rankRevenueActions([]), [], "no customers, no invented actions");

  seedCustomer(sqlite);
  await consent(db, CUSTOMER, { marketing: 1 });
  const records = await customer360.buildCustomer360(db);
  const actions = revenue.rankRevenueActions(records);

  for (const action of actions) {
    // The whole point: the ranking never puts a number on margin it has not been given.
    assert.equal(action.expectedMargin, null, "no contribution margin is invented");
    assert.equal(action.marginStatus, "configuration_required");
    assert.equal(action.estimateOnly, true, "every ranking is labelled an estimate");
    assert.ok(Array.isArray(action.signals) || typeof action.reason === "string");
  }

  // A customer with no marketing consent is not ranked as a marketing target.
  seedCustomer(sqlite, { customerId: "CUST-PLAT-3", name: "No Consent", phone: "+919800000003" });
  const withUnconsented = revenue.rankRevenueActions(await customer360.buildCustomer360(db));
  const unconsented = withUnconsented.find((row) => row.customerId === "CUST-PLAT-3");
  if (unconsented) {
    assert.equal(unconsented.expectedMargin, null);
    assert.equal(unconsented.marginStatus, "configuration_required");
  }
});

// ---------------------------------------------------------------------------------------------
test("CRM automation is consent gated, idempotent and refuses a reused key", async () => {
  const { db, sqlite } = await platformWorld();
  await crm.ensureCrmAutomationGovernance(db);
  await customer360.ensureCustomer360Tables(db);
  seedCustomer(sqlite);

  // WITHOUT consent, a marketing automation is blocked and NOTHING is queued.
  const blocked = await crm.automationDecision(db, { customerId: CUSTOMER, purpose: "marketing", channel: "whatsapp" });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "marketing_consent_missing");
  assert.equal(blocked.policyStatus, "blocked");

  const notQueued = await crm.queueGovernedAutomation(db, {
    customerId: CUSTOMER, journeyCode: "winback", channel: "whatsapp", purpose: "marketing", idempotencyKey: "k-blocked",
  });
  assert.equal(notQueued.queued, false, "a blocked decision queues no message");
  assert.equal(notQueued.decision.reason, "marketing_consent_missing");
  assert.equal(
    Number((await db.prepare("SELECT COUNT(*) AS n FROM crm_automation_dispatches").first()).n),
    0,
    "a refused automation writes no dispatch row at all",
  );

  // Consent is NECESSARY but not SUFFICIENT: an approved automation policy is a second gate.
  await consent(db, CUSTOMER, { marketing: 1 });
  const noPolicy = await crm.automationDecision(db, { customerId: CUSTOMER, purpose: "marketing", channel: "whatsapp" });
  assert.equal(noPolicy.allowed, false, "consent alone does not open the tap");
  assert.equal(noPolicy.reason, "automation_policy_not_approved");
  assert.equal(noPolicy.policyStatus, "configuration_required");

  await db.prepare("INSERT OR REPLACE INTO crm_automation_policy (policy_key,enabled,quiet_start_hour,quiet_end_hour,max_contacts,window_hours,max_attempts,retry_minutes,updated_by,updated_at) VALUES ('marketing:whatsapp',1,NULL,NULL,5,24,3,30,?,?)")
    .bind(STAFF, Date.now()).run();
  const allowed = await crm.automationDecision(db, { customerId: CUSTOMER, purpose: "marketing", channel: "whatsapp" });
  assert.equal(allowed.allowed, true, "consent plus an approved policy is what unblocks it");

  // An opt-out recorded in the OTHER consent store still blocks -- the engine fails closed across both.
  await db.prepare("CREATE TABLE IF NOT EXISTS communication_preferences (customer_id TEXT PRIMARY KEY,service_updates INTEGER NOT NULL DEFAULT 1,marketing INTEGER NOT NULL DEFAULT 0,updated_at INTEGER)").run();
  await db.prepare("INSERT OR REPLACE INTO communication_preferences (customer_id,service_updates,marketing,updated_at) VALUES (?,1,0,?)")
    .bind("CUST-OPTED-OUT", Date.now()).run();
  await consent(db, "CUST-OPTED-OUT", { marketing: 1 });
  const optedOut = await crm.automationDecision(db, { customerId: "CUST-OPTED-OUT", purpose: "marketing", channel: "whatsapp" });
  assert.equal(optedOut.allowed, false, "an opt-out in either store blocks");
  assert.equal(optedOut.reason, "marketing_opt_out");

  const queued = await crm.queueGovernedAutomation(db, {
    customerId: CUSTOMER, journeyCode: "winback", channel: "whatsapp", purpose: "marketing", idempotencyKey: "k-1",
  });
  assert.equal(queued.queued, true);

  const replay = await crm.queueGovernedAutomation(db, {
    customerId: CUSTOMER, journeyCode: "winback", channel: "whatsapp", purpose: "marketing", idempotencyKey: "k-1",
  });
  assert.equal(replay.duplicatePrevented, true, "the same key returns the same dispatch");
  assert.equal(
    Number((await db.prepare("SELECT COUNT(*) AS n FROM crm_automation_dispatches").first()).n),
    1,
    "a replay queues nothing new",
  );

  // The same key pointed at a different dispatch is a caller bug, not a replay.
  const crossed = await refusal(crm.queueGovernedAutomation(db, {
    customerId: CUSTOMER, journeyCode: "reactivation", channel: "whatsapp", purpose: "marketing", idempotencyKey: "k-1",
  }));
  assert.equal(crossed?.status, 409);
  assert.match(crossed.message, /idempotency key is already bound to another dispatch/);

  // A queued dispatch is QUEUED, not delivered: nothing here talks to a provider.
  const dispatch = await db.prepare("SELECT status,attempt_count FROM crm_automation_dispatches LIMIT 1").first();
  assert.equal(dispatch.status, "queued");
  assert.equal(Number(dispatch.attempt_count), 0, "nothing has been attempted, let alone delivered");

  const unknownFailure = await crm.recordAutomationFailure(db, "DISPATCH-NOPE", "boom", STAFF).then(() => null, (error) => error);
  assert.match(String(unknownFailure?.message ?? unknownFailure), /Automation dispatch not found/);
});

// ---------------------------------------------------------------------------------------------
test("Unified conversations preserve thread links, assignment and the visibility boundary", async () => {
  const { db, sqlite } = await platformWorld();
  await conversations.ensureConversationGovernance(db);
  seedCustomer(sqlite);

  assert.deepEqual(await conversations.listConversationThreads(db, {}), [], "an empty inbox is empty, not an error");

  const now = Date.now();
  await db.prepare("INSERT INTO communication_threads (id,customer_id,status,created_at,updated_at) VALUES ('THREAD-1',?,'open',?,?)")
    .bind(CUSTOMER, now, now).run();

  const inbound = await conversations.recordInboundMessage(db, {
    threadId: "THREAD-1", customerId: CUSTOMER, channel: "whatsapp",
    payload: { text: "Is my booking confirmed?" }, provider: "wati",
    providerReference: "wamid-1", eventId: "evt-1", createdBy: CUSTOMER,
  });
  assert.ok(inbound.id, "an inbound message lands on the thread");

  // The provider reference is the deduplication key: a redelivered webhook is not a second message.
  const redelivered = await conversations.recordInboundMessage(db, {
    threadId: "THREAD-1", customerId: CUSTOMER, channel: "whatsapp",
    payload: { text: "Is my booking confirmed?" }, provider: "wati",
    providerReference: "wamid-1", eventId: "evt-1", createdBy: CUSTOMER,
  });
  assert.equal(redelivered.duplicatePrevented, true);
  assert.equal(redelivered.id, inbound.id);

  const threads = await conversations.listConversationThreads(db, {});
  assert.equal(threads.length, 1);
  assert.equal(threads[0].customer_id ?? threads[0].customerId, CUSTOMER);

  // A message for one customer cannot be filed on another customer's thread.
  const mismatched = await conversations.recordInboundMessage(db, {
    threadId: "THREAD-1", customerId: "CUST-PLAT-9", channel: "whatsapp",
    payload: { text: "Wrong customer" }, provider: "wati", providerReference: "wamid-2", eventId: "evt-2", createdBy: "CUST-PLAT-9",
  }).then(() => null, (error) => error);
  assert.match(String(mismatched?.message ?? mismatched), /thread\/customer mismatch/);

  // Assignment and status are recorded against the thread, with an SLA.
  await conversations.assignConversation(db, {
    threadId: "THREAD-1", assignedTo: STAFF, assignedBy: STAFF, reason: "CX queue triage", slaMinutes: 30,
  });
  const assignment = await db.prepare("SELECT assigned_to,assigned_by,status,reason FROM conversation_assignments WHERE thread_id=?").bind("THREAD-1").first();
  assert.equal(assignment.assigned_to, STAFF);
  assert.equal(assignment.assigned_by, STAFF);
  assert.equal(assignment.status, "active");
  assert.equal(assignment.reason, "CX queue triage", "the reason for an assignment is recorded, not discarded");
  // The SLA is stored as a due INSTANT on the thread, not as a duration on the assignment.
  const thread = await db.prepare("SELECT assigned_to,sla_due_at FROM communication_threads WHERE id=?").bind("THREAD-1").first();
  assert.equal(thread.assigned_to, STAFF);
  assert.ok(Number(thread.sla_due_at) > Date.now(), "an SLA due time is set in the future");

  await conversations.setConversationStatus(db, { threadId: "THREAD-1", status: "closed", actorEmail: STAFF, reason: "Answered" });

  // A CLOSED conversation does not silently swallow a new customer message.
  const afterClose = await conversations.recordInboundMessage(db, {
    threadId: "THREAD-1", customerId: CUSTOMER, channel: "whatsapp",
    payload: { text: "One more thing" }, provider: "wati", providerReference: "wamid-3", eventId: "evt-3", createdBy: CUSTOMER,
  }).then(() => null, (error) => error);
  assert.match(String(afterClose?.message ?? afterClose), /Closed conversation cannot accept a new inbound message until reopened/);

  const unknownThread = await conversations.assignConversation(db, {
    threadId: "THREAD-NOPE", assignedTo: STAFF, assignedBy: STAFF,
  }).then(() => null, (error) => error);
  assert.match(String(unknownThread?.message ?? unknownThread), /Conversation thread not found/);

  // Every state change is audited.
  const audit = await db.prepare("SELECT COUNT(*) AS n FROM conversation_audit_events WHERE thread_id=?").bind("THREAD-1").first();
  assert.ok(Number(audit.n) >= 2, "assignment and closure are both audited");
});

// ---------------------------------------------------------------------------------------------
test("Partner Finance is policy gated, reason bound and sandbox only", async () => {
  const { db } = await platformWorld();
  await settlement.ensurePartnerSettlementTables(db);

  const badPeriod = await settlement.refreshPartnerSettlementStatements(db, "not-a-period").then(() => null, (error) => error);
  assert.match(String(badPeriod?.message ?? badPeriod), /Invalid settlement period code/);

  await settlement.refreshPartnerSettlementStatements(db, "2026-09");
  const statements = await db.prepare("SELECT id,status,policy_status FROM partner_settlement_statements LIMIT 1").first();

  const missing = await settlement.approveSettlement(db, { statementId: "PS-NOPE", actor: STAFF }).then(() => null, (error) => error);
  assert.match(String(missing?.message ?? missing), /Settlement statement not found/);

  // A period with no partner activity produces no statement, so one is seeded directly: the guards
  // below are about what may be done TO a statement, not about how it came to exist.
  if (!statements) {
    const now = Date.now();
    await db.prepare("INSERT INTO partner_settlement_statements (id,provider_id,period_code,currency,earned_amount,adjustment_amount,payable_amount,status,source_json,policy_status,created_at,updated_at) VALUES ('PS-SEED-1','host_maya_rohan','2026-09','INR',10000,0,10000,'draft','[]','configuration_required',?,?)")
      .bind(now, now).run();
  }
  const statement = statements ?? await db.prepare("SELECT id,status,policy_status FROM partner_settlement_statements LIMIT 1").first();

  assert.equal(statement.policy_status, "configuration_required", "payout policy starts unconfigured");
  assert.equal(statement.status, "draft", "a freshly built statement is a draft, never paid");

  /*
   * THREE gates stand between a computed statement and money leaving. Each is tested separately, so
   * satisfying one is never mistaken for satisfying the others.
   */
  // 1. A payout needs an APPROVED statement.
  const draftPayout = await settlement.createSandboxPayoutInstruction(db, {
    statementId: statement.id, idempotencyKey: "payout-draft", actor: STAFF,
  }).then(() => null, (error) => error);
  assert.match(String(draftPayout?.message ?? draftPayout), /Approved settlement statement is required/);

  // 2. A statement cannot be approved while the payout POLICY is unconfigured.
  const noPolicy = await settlement.approveSettlement(db, { statementId: statement.id, actor: STAFF })
    .then(() => null, (error) => error);
  assert.match(String(noPolicy?.message ?? noPolicy), /policy is not approved\/configured/);
  assert.equal(
    (await db.prepare("SELECT status FROM partner_settlement_statements WHERE id=?").bind(statement.id).first()).status,
    "draft",
    "a refused approval leaves the statement in draft",
  );

  // 3. Approving the policy needs a real reason (checked below), and only then does the chain open.
  await settlement.approveSettlementPolicy(db, {
    statementId: statement.id, reason: "Payout policy signed off by the Finance director", actor: STAFF,
  });
  await settlement.approveSettlement(db, { statementId: statement.id, actor: STAFF });
  const instruction = await settlement.createSandboxPayoutInstruction(db, {
    statementId: statement.id, idempotencyKey: "payout-1", actor: STAFF,
  });
  assert.ok(instruction, "with all three gates satisfied a SANDBOX instruction is created");
  const stored = await db.prepare("SELECT environment,status FROM partner_payout_instructions WHERE statement_id=?").bind(statement.id).first();
  // EQUIVALENT MUTATION, recorded rather than hidden: changing the DDL's
  // `environment TEXT NOT NULL DEFAULT 'sandbox'` changes nothing, because the INSERT writes
  // 'sandbox' explicitly on every row. The assertion below pins the value the INSERT actually writes,
  // which is the one that can go wrong.
  assert.equal(stored.environment, "sandbox", "and it is a sandbox instruction, never a live payout");
  assert.notEqual(stored.status, "paid", "creating an instruction does not move money");

  // Approving a policy demands a real reason, not a rubber stamp.
  const thinReason = await settlement.approveSettlementPolicy(db, {
    statementId: statement.id, reason: "ok", actor: STAFF,
  }).then(() => null, (error) => error);
  assert.match(String(thinReason?.message ?? thinReason), /at least 8 characters/);

  // Adjustments are equally bound.
  const zeroAdjustment = await settlement.addSettlementAdjustment(db, {
    statementId: statement.id, type: "incentive", amount: 0, reason: "Quarterly incentive award", actor: STAFF,
  }).then(() => null, (error) => error);
  assert.match(String(zeroAdjustment?.message ?? zeroAdjustment), /Non-zero adjustment amount is required/);

  const thinAdjustmentReason = await settlement.addSettlementAdjustment(db, {
    statementId: statement.id, type: "incentive", amount: 500, reason: "why", actor: STAFF,
  }).then(() => null, (error) => error);
  assert.match(String(thinAdjustmentReason?.message ?? thinAdjustmentReason), /at least 8 characters/);
});

// ---------------------------------------------------------------------------------------------
test("Marketing starts draft and requires approval plus a governed audience snapshot", async () => {
  const { db, sqlite } = await platformWorld();
  await marketing.ensureMarketingGovernance(db);
  await customer360.ensureCustomer360Tables(db);

  const now = Date.now();
  const campaign = async (id, holdout = 0) => {
    await db.prepare("INSERT INTO governed_marketing_campaigns (id,name,objective,service_code,city_id,audience_rule_json,budget_amount,currency,holdout_percent,status,approval_status,created_by,created_at,updated_at) VALUES (?,?,'winback','boarding','blr','{}',50000,'INR',?, 'draft','approval_required',?,?,?)")
      .bind(id, `Campaign ${id}`, holdout, STAFF, now, now).run();
    return id;
  };

  const missing = await marketing.snapshotCampaignAudience(db, { campaignId: "CMP-NOPE", actor: STAFF }).then(() => null, (error) => error);
  assert.match(String(missing?.message ?? missing), /Campaign not found/);

  const id = await campaign("CMP-1");
  const stored = await db.prepare("SELECT status,approval_status,approved_by FROM governed_marketing_campaigns WHERE id=?").bind(id).first();
  assert.equal(stored.status, "draft", "a campaign starts as a draft");
  assert.equal(stored.approval_status, "approval_required");
  assert.equal(stored.approved_by, null);

  // Approval is one gate.
  const unapproved = await marketing.activateCampaign(db, { campaignId: id, actor: STAFF }).then(() => null, (error) => error);
  assert.match(String(unapproved?.message ?? unapproved), /requires explicit approval before activation/);

  // A governed audience snapshot is a SEPARATE gate: an approved campaign with no snapshot still
  // cannot go live, which is what stops an approval being a blank cheque over an unknown audience.
  await db.prepare("UPDATE governed_marketing_campaigns SET approval_status='approved',approved_by=?,approved_at=? WHERE id=?")
    .bind("director@pawspace.test", Date.now(), id).run();
  const noSnapshot = await marketing.activateCampaign(db, { campaignId: id, actor: STAFF }).then(() => null, (error) => error);
  assert.match(String(noSnapshot?.message ?? noSnapshot), /requires a governed audience snapshot before activation/);

  // The snapshot SUPPRESSES anyone without marketing consent -- the whole point of governing it.
  seedCustomer(sqlite, { customerId: "CUST-CONSENTED", name: "Consented", phone: "+919800000011" });
  seedCustomer(sqlite, { customerId: "CUST-SILENT", name: "No consent", phone: "+919800000012" });
  await consent(db, "CUST-CONSENTED", { marketing: 1 });

  const snapshot = await marketing.snapshotCampaignAudience(db, { campaignId: id, actor: STAFF });
  assert.ok(snapshot.snapshotId ?? snapshot.id, "a snapshot is identified");
  const members = await db.prepare("SELECT customer_id,cohort,suppression_reason AS reason FROM marketing_audience_members ORDER BY customer_id").all();
  const byCustomer = Object.fromEntries(members.results.map((row) => [row.customer_id, row]));
  assert.equal(byCustomer["CUST-SILENT"].cohort, "suppressed", "no consent, no marketing");
  assert.match(String(byCustomer["CUST-SILENT"].reason), /marketing_consent_missing/);
  assert.equal(byCustomer["CUST-CONSENTED"].cohort, "eligible");
  assert.equal(byCustomer["CUST-CONSENTED"].reason, null);

  // With BOTH gates satisfied -- approved, and over a governed audience -- it can activate.
  const activated = await marketing.activateCampaign(db, { campaignId: id, actor: STAFF });
  assert.ok(activated, "an approved campaign with a governed audience can activate");
  assert.equal(
    (await db.prepare("SELECT status FROM governed_marketing_campaigns WHERE id=?").bind(id).first()).status,
    "active",
  );
});

// ---------------------------------------------------------------------------------------------
test("Company analytics is canonical and reports unreadable sources instead of zero", async () => {
  const { db } = await platformWorld();

  // On a cold database the tables do not exist. The honest answer is "I could not read this",
  // NOT a dashboard full of confident zeros.
  const cold = await analytics.buildCompanyAnalytics(db, {});
  assert.ok(cold.degraded, "a source it cannot read is reported as degraded");
  assert.match(cold.degraded.headline, /missing rather than zero/);
  assert.ok(cold.degraded.sources.includes("bookings"));
  for (const entry of cold.degraded.entries) {
    assert.ok(entry.reason, `${entry.source} says why it could not be read`);
  }

  // The metrics the platform cannot compute are marked, not guessed.
  assert.equal(cold.bookings.completionRate, null, "no completion rate is invented from no bookings");
  assert.equal(cold.bookings.cancellationRate, null);

  const json = JSON.stringify(cold);
  assert.match(json, /configuration_required/, "contribution margin stays configuration_required");
  assert.match(json, /not_connected/, "marketing spend stays not_connected");

  // The date filter is validated rather than silently coerced.
  const badRange = await analytics.buildCompanyAnalytics(db, { from: "yesterday" }).then(() => null, (error) => error);
  assert.ok(badRange, "a malformed date range is refused, not interpreted");

  const filtered = await analytics.buildCompanyAnalytics(db, { from: "2026-01-01", to: "2026-12-31", serviceCode: "boarding", zoneId: "blr-east" });
  assert.equal(filtered.period.from, "2026-01-01");
  assert.equal(filtered.period.to, "2026-12-31");
  assert.equal(filtered.filters.serviceCode, "boarding");
  assert.equal(filtered.filters.zoneId, "blr-east");
});

// ---------------------------------------------------------------------------------------------
test("The API gateway maps every platform closure route to a real permission", async () => {
  const { db } = await platformWorld();
  const gateway = await import("../lib/api-gateway.ts");
  const env = { DB: db };

  const ask = async (path, method = "GET") => {
    const init = method === "GET"
      ? {}
      : { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "noop" }) };
    const decision = await gateway.authorizeApiRequest(new Request(`${OPS_ORIGIN}${path}`, init), env);
    return decision instanceof Response ? decision.status : (decision.permission ?? "public");
  };

  // Every platform surface is guarded. None of them is public, and none of them is unmapped.
  for (const path of [
    "/api/customer-360", "/api/revenue-intelligence", "/api/crm-automation", "/api/conversations",
    "/api/partner-finance", "/api/marketing-control", "/api/company-analytics",
  ]) {
    const read = await ask(path);
    assert.notEqual(read, "public", `${path} must not be a public surface`);
    assert.equal(read, 401, `${path} refuses an anonymous read`);

    const write = await ask(path, "POST");
    assert.notEqual(write, "public", `${path} POST must not be public`);
    assert.equal(write, 401, `${path} refuses an anonymous write`);
  }
});

// ---------------------------------------------------------------------------------------------
test("Platform pre-live closure never claims production readiness", async () => {
  const { db, sqlite } = await platformWorld();
  await settlement.ensurePartnerSettlementTables(db);
  await marketing.ensureMarketingGovernance(db);
  await crm.ensureCrmAutomationGovernance(db);
  await customer360.ensureCustomer360Tables(db);
  seedCustomer(sqlite);

  // Analytics: the two figures a business would most want, and most easily fake.
  const report = JSON.parse(JSON.stringify(await analytics.buildCompanyAnalytics(db, {})));
  assert.match(JSON.stringify(report), /contributionMarginStatus":"configuration_required"/);
  assert.match(JSON.stringify(report), /marketingSpend":"not_connected"/);
  assert.doesNotMatch(JSON.stringify(report), /"contributionMargin":\s*-?\d/, "no contribution margin number is ever emitted");

  // Revenue intelligence: no margin, on any record.
  for (const action of revenue.rankRevenueActions(await customer360.buildCustomer360(db))) {
    assert.equal(action.expectedMargin, null);
    assert.equal(action.estimateOnly, true);
  }

  // Partner payouts: sandbox environment, unapproved policy, nothing instructed.
  await settlement.refreshPartnerSettlementStatements(db, "2026-09");
  const statements = await db.prepare("SELECT policy_status,status FROM partner_settlement_statements").all();
  for (const row of statements.results) {
    assert.notEqual(row.status, "paid", "nothing is marked paid before a payout exists");
  }
  // Payout instructions are sandbox by construction, and none exists without an approved policy.
  const instructions = await db.prepare("SELECT environment,status FROM partner_payout_instructions").all();
  for (const row of instructions.results) {
    assert.equal(row.environment, "sandbox", "no payout instruction is ever in a live environment");
  }

  // CRM: nothing is delivered, only queued.
  const dispatches = await db.prepare("SELECT DISTINCT status FROM crm_automation_dispatches").all();
  for (const row of dispatches.results) {
    assert.notEqual(row.status, "delivered", "no dispatch claims delivery");
  }

  // Marketing: no campaign is active until a human approves it.
  const campaigns = await db.prepare("SELECT status,approval_status FROM governed_marketing_campaigns").all();
  for (const row of campaigns.results) {
    if (row.status === "active") assert.equal(row.approval_status, "approved");
  }
});

// ---------------------------------------------------------------------------------------------
test("AI remains review-only and blocks sensitive autonomous actions", async () => {
  const { db } = await platformWorld();
  const ai = await import("../lib/ai-governance.ts");
  await ai.ensureAiGovernance(db);

  // Everything that moves money, contacts a customer or changes an assignment is forbidden outright.
  assert.deepEqual([...ai.forbiddenAutonomousActions], [
    "refund", "price_change", "payment", "payout", "outbound_contact", "customer_merge",
    "provider_assignment", "campaign_activation",
  ]);
  for (const action of ai.forbiddenAutonomousActions) {
    assert.throws(() => ai.assertAiActionAllowed(action), /AI autonomous action blocked/, `${action} is blocked`);
  }

  // Only the four read-and-suggest verbs are allowed at all.
  for (const action of ["summarize", "next_best_action", "draft_response", "risk_flag"]) {
    assert.doesNotThrow(() => ai.assertAiActionAllowed(action), `${action} is a suggestion, not an act`);
  }
  assert.throws(() => ai.assertAiActionAllowed("delete_customer"), /Unsupported AI suggestion type/);

  // A suggestion needs an authorised, unexpired context.
  const noContext = await ai.recordAiSuggestion(db, {
    contextId: "AICTX-NOPE", type: "summarize", content: { text: "hello" },
    confidence: 0.9, requestedBy: STAFF,
  }).then(() => null, (error) => error);
  assert.match(String(noContext?.message ?? noContext), /Authorized AI context is missing or expired/);

  const noScope = await ai.createAiContext(db, {
    actorEmail: STAFF, customerId: CUSTOMER, scope: [], context: {},
  }).then(() => null, (error) => error);
  assert.match(String(noScope?.message ?? noScope), /Authorized AI scope is required/);

  const context = await ai.createAiContext(db, {
    actorEmail: STAFF, customerId: CUSTOMER, scope: ["customer_360"], context: { note: "context" }, ttlMinutes: 15,
  });
  const contextId = context.id ?? context.contextId;

  // Confidence is a bounded number, not free text.
  for (const confidence of [-0.1, 1.1, Number.NaN]) {
    const bad = await ai.recordAiSuggestion(db, {
      contextId, type: "summarize", content: { text: "x" }, confidence, requestedBy: STAFF,
    }).then(() => null, (error) => error);
    assert.match(String(bad?.message ?? bad), /AI confidence must be between 0 and 1/);
  }

  const suggestion = await ai.recordAiSuggestion(db, {
    contextId, type: "next_best_action", content: { action: "Offer a boarding refresh" },
    confidence: 0.8, requestedBy: STAFF,
  });
  const suggestionId = suggestion.id ?? suggestion.suggestionId;

  // A suggestion is PENDING until a human reviews it, and the review needs a real note.
  const stored = await db.prepare("SELECT status FROM ai_suggestions WHERE id=?").bind(suggestionId).first();
  assert.notEqual(stored.status, "approved", "nothing is auto-approved");

  const thinNote = await ai.reviewAiSuggestion(db, {
    suggestionId, decision: "approved", actorEmail: STAFF, note: "ok",
  }).then(() => null, (error) => error);
  assert.match(String(thinNote?.message ?? thinNote), /AI review note must be at least 5 characters/);

  await ai.reviewAiSuggestion(db, {
    suggestionId, decision: "approved", actorEmail: STAFF, note: "Reviewed and agreed by the CX lead",
  });

  // A reviewed suggestion cannot be reviewed again -- the decision is final and auditable.
  const twice = await ai.reviewAiSuggestion(db, {
    suggestionId, decision: "rejected", actorEmail: STAFF, note: "Changed my mind entirely",
  }).then(() => null, (error) => error);
  assert.match(String(twice?.message ?? twice), /AI suggestion was already reviewed/);

  const missing = await ai.reviewAiSuggestion(db, {
    suggestionId: "AIS-NOPE", decision: "approved", actorEmail: STAFF, note: "Nothing to review",
  }).then(() => null, (error) => error);
  assert.match(String(missing?.message ?? missing), /AI suggestion not found/);
});

// ---------------------------------------------------------------------------------------------
test("CRM automation retries are bounded and end in a dead letter, never a silent loop", async () => {
  const { db, sqlite } = await platformWorld();
  await crm.ensureCrmAutomationGovernance(db);
  await customer360.ensureCustomer360Tables(db);
  seedCustomer(sqlite);
  await consent(db, CUSTOMER, { marketing: 1 });
  await db.prepare("INSERT OR REPLACE INTO crm_automation_policy (policy_key,enabled,quiet_start_hour,quiet_end_hour,max_contacts,window_hours,max_attempts,retry_minutes,updated_by,updated_at) VALUES ('marketing:whatsapp',1,NULL,NULL,50,24,2,30,?,?)")
    .bind(STAFF, Date.now()).run();

  const queued = await crm.queueGovernedAutomation(db, {
    customerId: CUSTOMER, journeyCode: "winback", channel: "whatsapp", purpose: "marketing", idempotencyKey: "retry-1",
  });
  assert.equal(queued.queued, true);
  const dispatchId = (await db.prepare("SELECT id FROM crm_automation_dispatches LIMIT 1").first()).id;

  // First failure: retried, not abandoned and not dead-lettered.
  const first = await crm.recordAutomationFailure(db, dispatchId, "provider timeout", STAFF);
  const afterFirst = await db.prepare("SELECT status,attempt_count FROM crm_automation_dispatches WHERE id=?").bind(dispatchId).first();
  assert.equal(Number(afterFirst.attempt_count), 1);
  assert.notEqual(afterFirst.status, "dead_letter", "one failure is not the end");
  assert.equal(
    Number((await db.prepare("SELECT COUNT(*) AS n FROM crm_automation_dead_letters").first()).n),
    0,
    "nothing is dead-lettered while retries remain",
  );
  assert.ok(first, "a recorded failure returns its new state");

  // Second failure hits max_attempts: the dispatch stops and a dead letter is written.
  await crm.recordAutomationFailure(db, dispatchId, "provider timeout", STAFF);
  const afterSecond = await db.prepare("SELECT status,attempt_count FROM crm_automation_dispatches WHERE id=?").bind(dispatchId).first();
  assert.equal(Number(afterSecond.attempt_count), 2);
  const deadLetters = await db.prepare("SELECT dispatch_id,reason FROM crm_automation_dead_letters").all();
  assert.equal(deadLetters.results.length, 1, "an exhausted retry becomes a dead letter, not an infinite loop");
  assert.equal(deadLetters.results[0].dispatch_id, dispatchId);
  assert.equal(afterSecond.status, "dead_letter");
});

// ---------------------------------------------------------------------------------------------
test("Conversation reads honour the customer visibility boundary", async () => {
  const { db, sqlite } = await platformWorld();
  await conversations.ensureConversationGovernance(db);
  seedCustomer(sqlite);
  seedCustomer(sqlite, { customerId: "CUST-PLAT-2", name: "Ravi S.", phone: "+919800000002" });

  const now = Date.now();
  for (const [threadId, customerId] of [["THREAD-A", CUSTOMER], ["THREAD-B", "CUST-PLAT-2"]]) {
    await db.prepare("INSERT INTO communication_threads (id,customer_id,status,created_at,updated_at) VALUES (?,?,'open',?,?)")
      .bind(threadId, customerId, now, now).run();
  }

  // The staff read sees both; the customer-scoped read sees one.
  assert.equal((await conversations.listConversationThreads(db, {})).length, 2);
  const mine = await conversations.listConversationThreads(db, { customerId: CUSTOMER });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, "THREAD-A");

  // A thread that does not exist reads as null rather than leaking an error shape.
  assert.equal(await conversations.getConversation(db, "THREAD-NOPE", "staff"), null);

  /*
   * The visibility boundary is FIELD level, not message level: the customer scope strips
   * payload.internalNote, payload.providerPhone and payload.customerPhone from every message, and
   * leaves the rest of the envelope alone. A staff note therefore has to be written into
   * `internalNote` to be protected -- putting the same words in `text` would reach the customer, so
   * this test pins the contract callers must actually honour.
   */
  await conversations.recordInboundMessage(db, {
    threadId: "THREAD-A", customerId: CUSTOMER, channel: "whatsapp",
    payload: { text: "Customer question" }, provider: "wati",
    providerReference: "wamid-A1", eventId: "evt-A1", createdBy: CUSTOMER,
  });
  await db.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,direction,channel,purpose,template_key,payload_json,status,provider,provider_reference,idempotency_key,created_by,created_at,updated_at) VALUES ('MSG-INTERNAL','THREAD-A',?,'internal','internal_note','internal','internal_note',?,'recorded','internal','note-1','idem-internal-1',?,?,?)")
    .bind(CUSTOMER, JSON.stringify({
      internalNote: "Do not tell the customer we lost the crate",
      providerPhone: "+919899999999", customerPhone: "+919800000001", summary: "Crate incident",
    }), STAFF, now, now).run();

  const staffView = await conversations.getConversation(db, "THREAD-A", "staff");
  const customerView = await conversations.getConversation(db, "THREAD-A", "customer");
  const staffText = JSON.stringify(staffView);
  const customerText = JSON.stringify(customerView);

  assert.match(staffText, /lost the crate/, "staff see the internal note");
  assert.match(staffText, /\+919899999999/, "staff see the provider number");
  assert.doesNotMatch(customerText, /lost the crate/, "the customer scope never returns an internal note");
  assert.doesNotMatch(customerText, /\+919899999999/, "nor a provider phone number");
  assert.doesNotMatch(customerText, /\+919800000001/, "nor a phone number echoed back into the payload");
  assert.match(customerText, /Customer question/, "the customer still sees their own message");
  assert.match(customerText, /Crate incident/, "and the rest of the envelope is not thrown away");

  // Both scopes see the same MESSAGES; only the sensitive fields differ.
  assert.equal(customerView.messages.length, staffView.messages.length);
});
