/**
 * Haptik wiring: the campaign/audience contract, and the two inbound endpoints.
 *
 * The most valuable test in this file is the first one, and it is a contract test rather than a
 * behavioural one — for a specific reason. buildOutboundAudience() used to be an if-chain with an
 * UNGUARDED final branch that fell through to the subscription_pitch query. Adding a campaign code
 * without a matching branch did not fail; it handed the new campaign the subscription-pitch audience
 * and dialled real customers for a campaign they were never selected for. Going from 3 campaigns to 12
 * would have made that near-certain, and no behavioural test would have caught it, because every
 * campaign would have returned a plausible non-empty audience.
 *
 * So: the registry is asserted to match the campaign list exactly, in both directions, and the
 * fallthrough is asserted to be gone by asking for a campaign that does not exist.
 *
 * The inbound tests then pin the routing decision that actually costs money if it is wrong: which
 * categories become sales pipeline and which do not.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

const createD1 = (sqlite) => ({
  prepare(sql) {
    const bound = [];
    const stmt = {
      bind: (...args) => { bound.push(...args); return stmt; },
      first: async () => sqlite.prepare(sql).get(...bound) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...bound) }),
      run: async () => {
        const info = sqlite.prepare(sql).run(...bound);
        const changes = Number(info.changes ?? 0);
        return { success: true, meta: { changes, rows_written: changes, last_row_id: Number(info.lastInsertRowid ?? 0) } };
      },
    };
    return stmt;
  },
  batch: async (statements) => Promise.all(statements.map((s) => s.run())),
  exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
});

installWorkersHooks("__HWI_DB__", "__HWI_ENV__");

const NOW = Date.UTC(2026, 7, 1);
let sqlite;

async function fresh() {
  sqlite = new DatabaseSync(":memory:");
  const db = createD1(sqlite);
  globalThis.__HWI_DB__ = db;
  globalThis.__HWI_ENV__ = {};
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, primary_phone TEXT NOT NULL, secondary_phone TEXT, email TEXT, area TEXT, pet_names TEXT, pet_summary TEXT, stage TEXT NOT NULL DEFAULT 'New lead', owner TEXT DEFAULT 'Unassigned', source TEXT DEFAULT 'Website', lifetime_value REAL DEFAULT 0, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, source TEXT NOT NULL, service TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', assigned_at INTEGER NOT NULL, first_action_at INTEGER, opt_out INTEGER NOT NULL DEFAULT 0, converted_booking_id TEXT);
  `);
  return db;
}

const inbound = () => import("../lib/haptik-inbound-inquiry.ts");

// ---------------------------------------------------------------------------
// The contract that replaces the fallthrough
// ---------------------------------------------------------------------------
test("every campaign has its own audience builder, and every builder has a campaign", async () => {
  const { HAPTIK_CAMPAIGNS } = await import("../lib/haptik-outbound-governance.ts");
  const { AUDIENCE_BUILDERS } = await import("../lib/haptik-outbound-audiences.ts");

  const codes = HAPTIK_CAMPAIGNS.map((c) => c.code).sort();
  const builders = Object.keys(AUDIENCE_BUILDERS).sort();

  // Asserted in both directions. One direction alone is not enough: campaigns-without-builders is the
  // dangerous case (a campaign borrowing someone else's audience), but builders-without-campaigns means
  // dead code that a later rename will silently resurrect against the wrong list.
  assert.deepEqual(codes, builders, "the campaign list and the audience registry have diverged");
  assert.equal(codes.length, 12, `the LOE needs 12 campaigns, found ${codes.length}`);
  // The nine the LOE added must all be present by name, so a rename cannot quietly drop one.
  for (const required of [
    "abandoned_checkout", "seasonal_offer", "renewal_reminder", "pending_session_followup",
    "training_lead_conversion", "winback", "boarding_sitting_cross_sell", "walking_cross_sell", "taxi_cross_sell",
  ]) assert.ok(codes.includes(required), `${required} is missing from the campaign list`);
});

test("an unknown campaign throws instead of borrowing another campaign's audience", async () => {
  const db = await fresh();
  const { buildOutboundAudience } = await import("../lib/haptik-outbound-governance.ts");
  // This is the exact defect: under the old if-chain this returned the subscription_pitch audience.
  const error = await buildOutboundAudience(db, { campaign: "not_a_real_campaign" }).then(() => null, (e) => e);
  assert.ok(error, "an unknown campaign silently returned an audience");
  assert.match(String(error.message), /Unknown outbound campaign/);
});

test("the builder LOOKUP itself has no fallback - an unmapped code resolves to nothing", async () => {
  const { audienceBuilderFor, AUDIENCE_BUILDERS } = await import("../lib/haptik-outbound-audiences.ts");
  // Pinning the lookup directly, not just via buildOutboundAudience. Going through the public function
  // cannot see this: it rejects an unknown CAMPAIGN before it ever reaches the builder lookup, so a
  // fallback re-added at the lookup would be invisible there. The dangerous case is a code that IS a
  // campaign but has no builder - and the only thing that must happen then is "nothing", never
  // "somebody else's audience".
  assert.equal(audienceBuilderFor("not_a_real_campaign"), null, "the lookup fell back to a default builder");
  assert.equal(audienceBuilderFor(""), null);
  assert.equal(audienceBuilderFor("__proto__"), null, "prototype keys must not resolve to a builder");
  // And a real one must still resolve, or the assertion above would pass on a lookup that always fails.
  assert.equal(typeof audienceBuilderFor("winback"), "function");
  assert.equal(Object.keys(AUDIENCE_BUILDERS).length, 12);
});

test("each campaign's contacts are stamped with its OWN reason, never another campaign's", async () => {
  const db = await fresh();
  const { HAPTIK_CAMPAIGNS, buildOutboundAudience } = await import("../lib/haptik-outbound-governance.ts");
  // Runs every builder against a cold DB. The point is not the row counts - it is that no builder
  // throws on missing tables (they must be cold-DB safe, since the scheduler sweeps all twelve), and
  // that any contact returned carries its own campaign code as `reason`. A borrowed audience shows up
  // here as the wrong reason string.
  for (const c of HAPTIK_CAMPAIGNS) {
    const audience = await buildOutboundAudience(db, { campaign: c.code, limit: 10, at: NOW });
    assert.ok(Array.isArray(audience), `${c.code} did not return an array`);
    for (const contact of audience) {
      assert.equal(contact.context.reason, c.code, `${c.code} returned a contact stamped "${contact.context.reason}"`);
    }
  }
});

test("every campaign that carries a link declares a WhatsApp template", async () => {
  const { HAPTIK_CAMPAIGNS } = await import("../lib/haptik-outbound-governance.ts");
  // The LOE needs a link delivered in 8 of 12 use cases, and a voice call cannot deliver a link. A
  // campaign with no template is voice-only by choice; this asserts the choice was made, not forgotten.
  const withTemplate = HAPTIK_CAMPAIGNS.filter((c) => c.whatsappTemplate);
  assert.ok(withTemplate.length >= 8, `only ${withTemplate.length} campaigns can deliver a link; the LOE needs at least 8`);
  for (const c of withTemplate) {
    assert.match(c.whatsappTemplate, /^ps_[a-z0-9_]+_v\d+$/, `${c.code} template "${c.whatsappTemplate}" is not a versioned template name`);
  }
});

// ---------------------------------------------------------------------------
// Inbound: the 10-category classification
// ---------------------------------------------------------------------------
test("all ten LOE categories classify to themselves", async () => {
  const { classifyInquiry, INQUIRY_CATEGORIES } = await inbound();
  assert.equal(INQUIRY_CATEGORIES.length, 10);
  for (const category of INQUIRY_CATEGORIES) {
    const out = classifyInquiry(category);
    assert.equal(out.category, category);
    assert.equal(out.recognised, true, `${category} was not recognised`);
  }
});

test("the spellings a conversational bot actually produces still classify", async () => {
  const { classifyInquiry } = await inbound();
  for (const [raw, expected] of [
    ["Dog Training", "dog_training"], ["dog-training", "dog_training"], ["training", "dog_training"],
    ["Pet Walking", "pet_walking"], ["walking", "pet_walking"],
    ["vet", "veterinary"], ["Taxi", "pet_taxi"], ["price", "pricing"], ["Complaint", "complaints"],
    ["slots", "availability"], ["daycare", "boarding"],
  ]) {
    const out = classifyInquiry(raw);
    assert.equal(out.category, expected, `"${raw}" classified as ${out.category}, expected ${expected}`);
    assert.equal(out.recognised, true, `"${raw}" should be recognised, not a fallback`);
  }
});

test("an unrecognised category is kept as general and FLAGGED, never silently rewritten", async () => {
  const { classifyInquiry } = await inbound();
  const out = classifyInquiry("aromatherapy_for_iguanas");
  // Accepted rather than refused, because refusing loses the customer's question. But it must be
  // visible: both the flag and the raw value survive, so ops can extend the list deliberately.
  assert.equal(out.category, "general");
  assert.equal(out.recognised, false, "an unmodelled category must be flagged for review");
  assert.equal(out.raw, "aromatherapy_for_iguanas", "the raw value must be preserved for review");
});

// ---------------------------------------------------------------------------
// Inbound: the routing decision that costs money if it is wrong
// ---------------------------------------------------------------------------
test("a service enquiry becomes a sales lead", async () => {
  const db = await fresh();
  const { createHaptikInquiry } = await inbound();
  const result = await createHaptikInquiry(db, {
    idempotencyKey: "INQ-1", phone: "9100000000", name: "Asha", category: "grooming", actorId: "haptik_voice", at: NOW,
  });
  assert.equal(result.category, "grooming");
  assert.equal(result.serviceCode, "grooming");
  assert.equal(result.routedTo, "sales_lead");
  assert.ok(result.leadId, "a grooming enquiry must create pipeline");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM lead_work_items WHERE service='grooming'").get().n, 1);
});

test("pricing, availability and general are logged WITHOUT creating pipeline", async () => {
  const db = await fresh();
  const { createHaptikInquiry } = await inbound();
  // Filing "why is grooming so expensive" as a grooming lead pollutes the pipeline and earns the
  // customer a sales call they never asked for.
  for (const category of ["pricing", "availability", "general"]) {
    const result = await createHaptikInquiry(db, {
      idempotencyKey: `INQ-${category}`, phone: "9100000000", category, actorId: "haptik_voice", at: NOW,
    });
    assert.equal(result.routedTo, "logged_only", `${category} was routed to ${result.routedTo}`);
    assert.equal(result.leadId, null, `${category} created a sales lead`);
    assert.equal(result.serviceCode, null, `${category} acquired a service code`);
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM lead_work_items").get().n, 0, "no pipeline may be created by a non-service enquiry");
});

test("a complaint never becomes a sales lead", async () => {
  const db = await fresh();
  const { createHaptikInquiry } = await inbound();
  const result = await createHaptikInquiry(db, {
    idempotencyKey: "INQ-COMPLAINT", phone: "9100000000", category: "complaints",
    message: "My groomer was late twice", actorId: "haptik_voice", at: NOW,
  });
  // Answering a complaint with a sales call is the worst available outcome.
  assert.equal(result.leadId, null, "a complaint created a sales lead");
  assert.notEqual(result.routedTo, "sales_lead");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM lead_work_items").get().n, 0);
  const stored = sqlite.prepare("SELECT category,status,service_code,handoff_id FROM haptik_inquiries WHERE id=?").get(result.inquiryId);
  assert.equal(String(stored.category), "complaints");
  assert.equal(stored.service_code, null);

  // And the positive half: it must actually REACH a human. "No lead" alone would be satisfied by
  // dropping the complaint entirely, which is worse than mis-filing it.
  assert.equal(result.routedTo, "human_queue", `a complaint was routed to ${result.routedTo}`);
  assert.ok(result.handoffId, "a complaint was not queued to a human");
  assert.equal(String(stored.handoff_id), result.handoffId);
  const queued = sqlite.prepare("SELECT reason,status FROM ai_handoffs WHERE id=?").get(result.handoffId);
  assert.ok(queued, "the handoff row does not exist on the queue agents watch");
  assert.equal(String(queued.reason), "complaint", "the complaint reached the queue under the wrong reason");
});

test("a veterinary question is not sold against - we do not sell veterinary care", async () => {
  const db = await fresh();
  const { createHaptikInquiry } = await inbound();
  const result = await createHaptikInquiry(db, {
    idempotencyKey: "INQ-VET", phone: "9100000000", category: "veterinary", actorId: "haptik_voice", at: NOW,
  });
  assert.equal(result.serviceCode, null, "veterinary must not map to a sellable service");
  assert.equal(result.leadId, null, "a vet question created a sales lead");
});

test("a retried inquiry creates exactly one inquiry, one contact and one lead", async () => {
  const db = await fresh();
  const { createHaptikInquiry } = await inbound();
  const input = { idempotencyKey: "INQ-RETRY", phone: "9100000000", name: "Asha", category: "boarding", actorId: "haptik_voice", at: NOW };

  const first = await createHaptikInquiry(db, input);
  const second = await createHaptikInquiry(db, input);

  assert.equal(first.duplicatePrevented, false);
  assert.equal(second.duplicatePrevented, true, "a voice platform retry created a second inquiry");
  assert.equal(second.inquiryId, first.inquiryId);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM haptik_inquiries").get().n, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM crm_contacts").get().n, 1, "the retry forked a second CRM contact");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM lead_work_items").get().n, 1, "the retry created a second lead");
});

test("a returning caller is matched to their existing contact, not forked", async () => {
  const db = await fresh();
  const { createHaptikInquiry } = await inbound();
  // Stored +91-prefixed, supplied bare: the same handset in two shapes. The LOE's value is that the bot
  // recognises a returning customer, which it cannot do against a duplicate contact.
  sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,created_at,updated_at) VALUES ('CRM-EXISTING','Asha A.','+919100000000',0,0)").run();

  const result = await createHaptikInquiry(db, {
    idempotencyKey: "INQ-RETURN", phone: "9100000000", category: "grooming", actorId: "haptik_voice", at: NOW,
  });

  assert.equal(result.contactId, "CRM-EXISTING", "a returning caller was forked into a new contact");
  assert.equal(result.contactCreated, false);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM crm_contacts").get().n, 1);
});

test("an inquiry without a full phone number is refused as a client error", async () => {
  const db = await fresh();
  const { createHaptikInquiry } = await inbound();
  for (const phone of ["", "12345"]) {
    const error = await createHaptikInquiry(db, { idempotencyKey: `INQ-BAD-${phone}`, phone, category: "grooming", actorId: "haptik_voice" })
      .then(() => null, (e) => e);
    assert.ok(error, `phone "${phone}" was accepted`);
    assert.equal(error.statusCode, 400, "a bad phone number is the caller's fault, not a 500");
  }
  const missingKey = await createHaptikInquiry(db, { idempotencyKey: "", phone: "9100000000", category: "grooming", actorId: "haptik_voice" })
    .then(() => null, (e) => e);
  assert.equal(missingKey.statusCode, 400, "without an idempotency key a retry cannot be deduped");
});

// ---------------------------------------------------------------------------
// Inbound: transfer to an agent
// ---------------------------------------------------------------------------
test("the transfer reasons the bot sends map onto the existing handoff vocabulary", async () => {
  const { transferHaptikToAgent } = await inbound();
  const db = await fresh();
  for (const [raw, expected] of [
    ["customer_requested_human", "customer_requested_human"],
    ["complaint", "complaint"],
    ["refund", "refund_payment_dispute"],
    ["payment_dispute", "refund_payment_dispute"],
    ["safety", "safety"],
  ]) {
    const out = await transferHaptikToAgent(db, { phone: "9100000000", reason: raw, actorId: "haptik_voice", at: NOW })
      .catch((e) => ({ error: e }));
    if (out.error) { assert.fail(`transfer with reason "${raw}" threw: ${out.error.message}`); }
    assert.equal(out.reason, expected, `"${raw}" mapped to ${out.reason}`);
    assert.equal(out.reasonRecognised, true);
  }
});

test("an unmapped transfer reason still reaches a human, and says it was unmapped", async () => {
  const { transferHaptikToAgent } = await inbound();
  const db = await fresh();
  // The customer has already asked for a person. Losing that over an unmapped enum string is the one
  // outcome worse than a slightly mislabelled queue entry - but the gap must be visible.
  const out = await transferHaptikToAgent(db, { phone: "9100000000", reason: "wants_to_speak_to_manager", actorId: "haptik_voice", at: NOW })
    .catch((e) => ({ error: e }));
  assert.ok(!out.error, `an unmapped reason threw: ${out.error?.message}`);
  assert.equal(out.reason, "customer_requested_human", "an unmapped reason must still reach a human");
  assert.equal(out.reasonRecognised, false, "the mapping gap must be reported");
  assert.equal(out.rawReason, "wants_to_speak_to_manager", "the raw reason must be preserved");
});

test("a transfer without a full phone number is a client error", async () => {
  const { transferHaptikToAgent } = await inbound();
  const db = await fresh();
  const error = await transferHaptikToAgent(db, { phone: "999", actorId: "haptik_voice" }).then(() => null, (e) => e);
  assert.ok(error);
  assert.equal(error.statusCode, 400);
});
