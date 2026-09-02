import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";

// ---------------------------------------------------------------------------
// Interakt WhatsApp - real execution of the real modules.
//
// The property that matters: a voice bot can now cause a WhatsApp message to a
// real person, and it must not be able to do so without configuration, an
// approved template, a known CRM lead, and consent it can evidence. Every
// refusal must come back as a reason the agent can say on the call rather than
// as a message that silently never arrives.
// ---------------------------------------------------------------------------
installWorkersHooks("__INTERAKT_DB__");

const LINK = "https://pawspace.in/grooming/packages";
const PHONE = "+919876500222";
const CONNECTED_ENV = { INTERAKT_API_KEY: "ik_test_key", INTERAKT_BASE_URL: "https://api.interakt.ai" };

async function world() {
  const { sqlite, db, reset } = freshCountingD1();
  globalThis.__INTERAKT_DB__ = db;
  const haptik = await import("../lib/haptik-integration-governance.ts");
  const account = await import("../lib/customer-account.ts");
  const customer360 = await import("../lib/customer-360.ts");
  const engine = await import("../lib/communication-engine.ts");
  const interakt = await import("../lib/interakt-whatsapp-governance.ts");
  // Every table comes from the module that OWNS it, so a column rename anywhere upstream fails this
  // suite instead of drifting away from the deployed schema.
  await haptik.ensureHaptikTables(db);
  await account.ensureCustomerAccountTables(db);
  await customer360.ensureCustomer360Tables(db);
  await engine.ensureCommunicationTables(db);
  await interakt.ensureInteraktTables(db);
  reset();
  return { sqlite, db, interakt, engine };
}

/** A CRM lead + contact + canonical customer for PHONE, exactly as capture_lead would leave them. */
async function knownLead(world_, options = {}) {
  const now = Date.now();
  await world_.interakt.ensureInteraktTables(world_.db);
  world_.sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,stage,owner,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("CU-IK", "Meera Rao", PHONE, "New lead", "Unassigned", "haptik_voice", now, now);
  world_.sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,call_attempts,whatsapp_attempts,recycle_cycle,opt_out,created_at,updated_at) VALUES (?,?,?,?,?,?,'active','day_1',1,?,?,?,0,0,0,?,?,?)")
    .run("LEAD-IK", "CU-IK", "haptik_voice", "grooming", "Unassigned", "Sales Manager", now, now + 600000, now + 1800000, options.leadOptOut ? 1 : 0, now, now);
  world_.sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,'{}',?,?)")
    .run("CU-IK", "blr", "Meera Rao", PHONE, "crm_lead", now, now);
  if (options.optOut) {
    world_.sqlite.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,opt_out,source,updated_by,updated_at) VALUES (?,0,1,0,0,0,1,'customer','test',?)")
      .run("CU-IK", now);
  }
  return "CU-IK";
}

async function configureLink(world_, { approved = true } = {}) {
  await world_.interakt.setInteraktLink(world_.db, { linkKey: "grooming_package_booking", url: LINK, actorId: "ops@pawspace.in" });
  await world_.interakt.setInteraktTemplate(world_.db, { templateKey: "pawspace_grooming_package_v1", linkKey: "grooming_package_booking", status: approved ? "approved" : "pending_approval", language: "en", actorId: "ops@pawspace.in" });
}

const queue = (world_, env, overrides = {}) => world_.interakt.queueInteraktWhatsApp(world_.db, env, {
  idempotencyKey: "call-ik-1", linkKey: "grooming_package_booking", phone: PHONE, leadId: "LEAD-IK",
  cityId: "blr", callRef: "HAPTIK-CALL-9001", consentGranted: true,
  consentSource: "voice_call_verbal_consent", consentEvidenceRef: "HAPTIK-CALL-9001",
  actorId: "haptik_voice", ...overrides,
});

// ---------------------------------------------------------------------------
// 1. The transport adapter is fail-closed and validates where it posts PII.
// ---------------------------------------------------------------------------
test("the Interakt client sends nothing until both keys are configured", async () => {
  const client = await import("../lib/interakt-client.ts");
  assert.equal(client.interaktConfigured({}), false);
  assert.equal(client.interaktConfigured({ INTERAKT_API_KEY: "k" }), false);
  assert.equal(client.interaktConfigured({ INTERAKT_BASE_URL: "https://api.interakt.ai" }), false);
  assert.equal(client.interaktConfigured(CONNECTED_ENV), true);

  let fetched = 0;
  const result = await client.sendInteraktTemplate({}, { phone: PHONE, templateKey: "t", fetcher: async () => { fetched++; return new Response("{}"); } });
  assert.equal(result.connected, false);
  assert.match(result.reason, /not connected/i);
  assert.equal(fetched, 0, "an unconfigured adapter must not reach the network at all");
});

test("the Interakt endpoint refuses a base URL that is not a plain https host", async () => {
  const { interaktEndpoint } = await import("../lib/interakt-client.ts");
  assert.equal(interaktEndpoint({ INTERAKT_BASE_URL: "https://api.interakt.ai" }), "https://api.interakt.ai/v1/public/message/");
  assert.equal(interaktEndpoint({ INTERAKT_BASE_URL: "https://api.interakt.ai/base/" }), "https://api.interakt.ai/base/v1/public/message/");
  assert.throws(() => interaktEndpoint({ INTERAKT_BASE_URL: "http://api.interakt.ai" }), /https/);
  assert.throws(() => interaktEndpoint({ INTERAKT_BASE_URL: "https://user:pass@api.interakt.ai" }), /credentials/);
  assert.throws(() => interaktEndpoint({ INTERAKT_BASE_URL: "https://169.254.169.254" }), /hostname/);
  assert.throws(() => interaktEndpoint({ INTERAKT_BASE_URL: "not-a-url" }), /valid URL/);
});

test("a number already carrying its country code is not sent with the code twice", async () => {
  const { interaktRecipient } = await import("../lib/interakt-client.ts");
  assert.deepEqual(interaktRecipient({}, "+919876500222"), { countryCode: "+91", phoneNumber: "9876500222" });
  assert.deepEqual(interaktRecipient({}, "9876500222"), { countryCode: "+91", phoneNumber: "9876500222" });
});

// ---------------------------------------------------------------------------
// 2. Every refusal is a stated reason, never a silent non-delivery.
// ---------------------------------------------------------------------------
test("each missing piece of setup blocks the send with the reason that names it", async () => {
  const w = await world();
  await knownLead(w);

  const unconnected = await queue(w, {});
  assert.equal(unconnected.status, "blocked");
  assert.equal(unconnected.reason, "interakt_not_connected");

  const noLink = await queue(w, CONNECTED_ENV, { idempotencyKey: "call-ik-nolink" });
  assert.equal(noLink.reason, "link_not_configured");

  await configureLink(w, { approved: false });
  const noTemplate = await queue(w, CONNECTED_ENV, { idempotencyKey: "call-ik-notemplate" });
  assert.equal(noTemplate.reason, "template_not_approved");

  // Nothing above may have queued a message.
  const messages = w.sqlite.prepare("SELECT COUNT(*) c FROM communication_messages").get().c;
  assert.equal(Number(messages), 0, "a blocked send must not create a communication message");
});

test("a WhatsApp send is never the first record of a person", async () => {
  const w = await world();
  await configureLink(w);
  const result = await queue(w, CONNECTED_ENV, { leadId: "", phone: "+919000011111" });
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "no_crm_lead");
});

test("a lead id from one customer cannot be used to message a different number", async () => {
  const w = await world();
  await knownLead(w);
  await configureLink(w);
  const result = await queue(w, CONNECTED_ENV, { phone: "+919555544444" });
  assert.equal(result.reason, "lead_phone_mismatch");
});

// ---------------------------------------------------------------------------
// 3. Consent: asserted on the call, evidenced, and never able to override opt-out.
// ---------------------------------------------------------------------------
test("an in-call consent assertion is stored as evidence and enables the send", async () => {
  const w = await world();
  await knownLead(w);
  await configureLink(w);
  const result = await queue(w, CONNECTED_ENV);
  assert.equal(result.duplicatePrevented, false);
  assert.equal(result.status, "queued", `expected queued, got ${result.status} / ${result.reason}`);
  assert.ok(result.messageId, "a queued send has a communication message");

  const evidence = w.sqlite.prepare("SELECT * FROM whatsapp_ai_consent_evidence WHERE lead_id=?").get("LEAD-IK");
  assert.ok(evidence, "the consent the bot asserted is recorded as evidence");
  assert.equal(Number(evidence.granted), 1);
  assert.equal(evidence.evidence_ref, "HAPTIK-CALL-9001", "the call reference is the evidence");
  assert.equal(evidence.wording_version, "interakt-voice-consent-v1");

  const preference = w.sqlite.prepare("SELECT * FROM customer_contact_preferences WHERE customer_id=?").get("CU-IK");
  assert.equal(Number(preference.whatsapp_consent), 1);
  assert.equal(Number(preference.marketing_consent), 1, "a marketing link records marketing consent");

  const message = w.sqlite.prepare("SELECT * FROM communication_messages WHERE id=?").get(result.messageId);
  assert.equal(message.channel, "whatsapp");
  assert.equal(message.purpose, "marketing");
  assert.equal(message.status, "queued");
  assert.match(String(message.payload_json), /pawspace\.in\/grooming\/packages/);
});

test("without an asserted consent the message is suppressed, not sent", async () => {
  const w = await world();
  await knownLead(w);
  await configureLink(w);
  const result = await queue(w, CONNECTED_ENV, { consentGranted: false, consentEvidenceRef: "" });
  assert.equal(result.status, "suppressed");
  assert.match(result.reason, /marketing_consent_unknown|marketing_opt_out/);
  // Suppressed messages are never handed to the outbox, so no sweep can pick them up.
  const outbox = w.sqlite.prepare("SELECT COUNT(*) c FROM communication_outbox").get().c;
  assert.equal(Number(outbox), 0);
  const preference = w.sqlite.prepare("SELECT COUNT(*) c FROM customer_contact_preferences").get().c;
  assert.equal(Number(preference), 0, "no evidence means no preference is written either");
});

test("an opted-out customer cannot be talked back into contactability by a bot", async () => {
  const w = await world();
  await knownLead(w, { optOut: true });
  await configureLink(w);
  const result = await queue(w, CONNECTED_ENV);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "customer_opted_out");
  const preference = w.sqlite.prepare("SELECT * FROM customer_contact_preferences WHERE customer_id=?").get("CU-IK");
  assert.equal(Number(preference.opt_out), 1, "the opt-out survives the attempt");
  assert.equal(Number(preference.whatsapp_consent), 0, "and the bot did not flip the channel on");
});

test("a lead marked opted out blocks the send before any consent is recorded", async () => {
  const w = await world();
  await knownLead(w, { leadOptOut: true });
  await configureLink(w);
  const result = await queue(w, CONNECTED_ENV);
  assert.equal(result.reason, "lead_opted_out");
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM whatsapp_ai_consent_evidence").get().c), 0);
});

// ---------------------------------------------------------------------------
// 4. Idempotency - a retried webhook must not message a customer twice.
// ---------------------------------------------------------------------------
test("a retried send request returns the first result and queues one message", async () => {
  const w = await world();
  await knownLead(w);
  await configureLink(w);
  const first = await queue(w, CONNECTED_ENV);
  const second = await queue(w, CONNECTED_ENV);
  assert.equal(second.duplicatePrevented, true);
  assert.equal(second.messageId, first.messageId);
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM communication_messages").get().c), 1);
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM interakt_sends").get().c), 1);
});

// ---------------------------------------------------------------------------
// 5. Dispatch - the send itself, and what happens when it fails.
// ---------------------------------------------------------------------------
test("dispatch sends the approved template with the configured link and records acceptance", async () => {
  const w = await world();
  await knownLead(w);
  await configureLink(w);
  const queued = await queue(w, CONNECTED_ENV);

  const seen = [];
  const fetcher = async (url, init) => { seen.push({ url: String(url), body: JSON.parse(String(init.body)), auth: init.headers.authorization }); return new Response(JSON.stringify({ result: true, id: "IK-MSG-1" }), { status: 200 }); };
  const result = await w.interakt.dispatchInteraktMessage(w.db, CONNECTED_ENV, { messageId: queued.messageId, fetcher });
  assert.equal(result.status, "provider_accepted");
  assert.equal(result.externalDelivery, true);
  assert.equal(result.providerReference, "IK-MSG-1");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://api.interakt.ai/v1/public/message/");
  assert.equal(seen[0].auth, "Basic ik_test_key");
  assert.equal(seen[0].body.template.name, "pawspace_grooming_package_v1");
  assert.equal(seen[0].body.phoneNumber, "9876500222");
  assert.deepEqual(seen[0].body.template.buttonValues, { 0: [LINK] });

  const message = w.sqlite.prepare("SELECT provider,provider_reference,status FROM communication_messages WHERE id=?").get(queued.messageId);
  assert.equal(message.provider, "interakt");
  assert.equal(message.provider_reference, "IK-MSG-1");
  const send = w.sqlite.prepare("SELECT status FROM interakt_sends WHERE message_id=?").get(queued.messageId);
  assert.equal(send.status, "provider_accepted");

  // A second dispatch of the same message must not send again.
  const again = await w.interakt.dispatchInteraktMessage(w.db, CONNECTED_ENV, { messageId: queued.messageId, fetcher });
  assert.equal(again.status, "already_dispatched");
  assert.equal(seen.length, 1, "an already-dispatched message is never sent twice");
});

test("consent is re-checked at dispatch, so a withdrawal between queue and send stops it", async () => {
  const w = await world();
  await knownLead(w);
  await configureLink(w);
  const queued = await queue(w, CONNECTED_ENV);
  w.sqlite.prepare("UPDATE customer_contact_preferences SET opt_out=1 WHERE customer_id=?").run("CU-IK");

  let fetched = 0;
  const result = await w.interakt.dispatchInteraktMessage(w.db, CONNECTED_ENV, { messageId: queued.messageId, fetcher: async () => { fetched++; return new Response("{}"); } });
  assert.equal(result.status, "consent_refused");
  assert.equal(fetched, 0);
});

test("a template whose approval is withdrawn stops dispatching", async () => {
  const w = await world();
  await knownLead(w);
  await configureLink(w);
  const queued = await queue(w, CONNECTED_ENV);
  await w.interakt.setInteraktTemplate(w.db, { templateKey: "pawspace_grooming_package_v1", linkKey: "grooming_package_booking", status: "paused", language: "en", actorId: "ops@pawspace.in" });
  let fetched = 0;
  const result = await w.interakt.dispatchInteraktMessage(w.db, CONNECTED_ENV, { messageId: queued.messageId, fetcher: async () => { fetched++; return new Response("{}"); } });
  assert.equal(result.status, "approved_template_required");
  assert.equal(fetched, 0);
});

test("Interakt refusing behind a 200 is a failure, not a delivery", async () => {
  const w = await world();
  await knownLead(w);
  await configureLink(w);
  const queued = await queue(w, CONNECTED_ENV);
  const result = await w.interakt.dispatchInteraktMessage(w.db, CONNECTED_ENV, {
    messageId: queued.messageId,
    fetcher: async () => new Response(JSON.stringify({ result: false, message: "template not found" }), { status: 200 }),
  });
  assert.equal(result.externalDelivery, false);
  assert.match(String(result.reason), /refused the send/);
  const outbox = w.sqlite.prepare("SELECT status,attempt_count FROM communication_outbox WHERE message_id=?").get(queued.messageId);
  assert.equal(outbox.status, "retry_pending", "a refusal is retried by the outbox, not lost");
  assert.equal(Number(outbox.attempt_count), 1);
});

test("an accepted send with no message id is treated as a failure", async () => {
  const w = await world();
  await knownLead(w);
  await configureLink(w);
  const queued = await queue(w, CONNECTED_ENV);
  const result = await w.interakt.dispatchInteraktMessage(w.db, CONNECTED_ENV, {
    messageId: queued.messageId,
    fetcher: async () => new Response(JSON.stringify({ result: true }), { status: 200 }),
  });
  assert.equal(result.externalDelivery, false);
  assert.match(String(result.reason), /without returning a message id/);
});

// ---------------------------------------------------------------------------
// 6. The scheduler sweep is a no-op until Interakt is deliberately switched on.
// ---------------------------------------------------------------------------
test("the dispatch sweep sends nothing while Interakt is not connected", async () => {
  const w = await world();
  await knownLead(w);
  await configureLink(w);
  await queue(w, CONNECTED_ENV);
  let fetched = 0;
  const result = await w.interakt.runInteraktDispatchSweep(w.db, { env: {}, fetcher: async () => { fetched++; return new Response("{}"); } });
  assert.equal(result.configured, false);
  assert.equal(result.dispatched, 0);
  assert.equal(fetched, 0);
});

test("the dispatch sweep drains queued sends once connected", async () => {
  const w = await world();
  await knownLead(w);
  await configureLink(w);
  await queue(w, CONNECTED_ENV);
  const result = await w.interakt.runInteraktDispatchSweep(w.db, {
    env: CONNECTED_ENV,
    fetcher: async () => new Response(JSON.stringify({ result: true, id: "IK-MSG-SWEEP" }), { status: 200 }),
  });
  assert.equal(result.configured, true);
  assert.equal(result.dispatched, 1);
});

// ---------------------------------------------------------------------------
// 7. Operator surfaces: link validation and no full numbers in the ops list.
// ---------------------------------------------------------------------------
test("a customer-facing link must be https and carry no credentials", async () => {
  const w = await world();
  await assert.rejects(() => w.interakt.setInteraktLink(w.db, { linkKey: "website", url: "http://pawspace.in", actorId: "ops" }), /https/);
  await assert.rejects(() => w.interakt.setInteraktLink(w.db, { linkKey: "website", url: "https://u:p@pawspace.in", actorId: "ops" }), /credentials/);
  await assert.rejects(() => w.interakt.setInteraktLink(w.db, { linkKey: "not_a_link", url: "https://pawspace.in", actorId: "ops" }), /Unknown Interakt link/);
});

test("the ops send list never returns a full customer number", async () => {
  const w = await world();
  await knownLead(w);
  await configureLink(w);
  await queue(w, CONNECTED_ENV);
  const rows = await w.interakt.listInteraktSends(w.db, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].phoneLast4, "0222");
  assert.equal(JSON.stringify(rows[0]).includes("9876500222"), false, "no row may carry the full number");
});

test("every link in the solution document has a definition and a purpose", async () => {
  const { INTERAKT_LINKS, INTERAKT_LINK_KEYS } = await import("../lib/interakt-whatsapp-governance.ts");
  for (const required of ["grooming_package_booking", "grooming_subscription", "subscription_renewal", "abandoned_checkout", "pending_session_booking", "website"]) {
    assert.ok(INTERAKT_LINK_KEYS.includes(required), `missing link: ${required}`);
  }
  // Promotional links must run under the marketing purpose (express consent); links about something
  // the customer already bought must not, or a renewal reminder would need a marketing opt-in.
  const purpose = key => INTERAKT_LINKS.find(link => link.key === key).purpose;
  assert.equal(purpose("grooming_package_booking"), "marketing");
  assert.equal(purpose("grooming_subscription"), "marketing");
  assert.equal(purpose("website"), "marketing");
  assert.equal(purpose("subscription_renewal"), "lifecycle");
  assert.equal(purpose("abandoned_checkout"), "lifecycle");
  assert.equal(purpose("pending_session_booking"), "lifecycle");
});
