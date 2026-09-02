import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";

// ---------------------------------------------------------------------------
// The twelve outbound campaigns - real execution of the real audience queries.
//
// The integration shipped three of the solution document's twelve outbound
// journeys. Adding the other nine widens the set of people a bot may telephone,
// which makes the audience query itself the safety-critical part: it decides
// who gets called. So each one is executed against the real schema with rows
// that should and should not qualify.
//
// The invariants that hold across ALL twelve, whatever the campaign:
//   opt_out is never dialled;
//   a campaign that pitches something requires express marketing consent;
//   a cold or partially-migrated database yields an empty audience, not an error.
// ---------------------------------------------------------------------------
installWorkersHooks("__HAPTIK_AUDIENCE_DB__");

const NOW = Date.UTC(2026, 8, 2, 6, 0, 0); // 2026-09-02 11:30 IST - outside quiet hours
const DAY = 86_400_000;
const iso = (at) => new Date(at).toISOString();

async function world() {
  const { sqlite, db, reset } = freshCountingD1();
  globalThis.__HAPTIK_AUDIENCE_DB__ = db;
  const haptik = await import("../lib/haptik-integration-governance.ts");
  const account = await import("../lib/customer-account.ts");
  const customer360 = await import("../lib/customer-360.ts");
  const bookings = await import("../lib/canonical-booking-read-model.ts");
  const wallet = await import("../lib/subscription-wallet.ts");
  const invoice = await import("../lib/sitting-invoice.ts");
  const outbound = await import("../lib/haptik-outbound-governance.ts");
  // Every table from the module that owns it.
  await haptik.ensureHaptikTables(db);
  await account.ensureCustomerAccountTables(db);
  await customer360.ensureCustomer360Tables(db);
  await bookings.ensureCanonicalBookingReadModel(db);
  await wallet.ensureSubscriptionWalletTables(db);
  await invoice.ensureSittingInvoiceTables(db);
  await outbound.ensureHaptikOutboundTables(db);
  reset();
  return { sqlite, db, outbound };
}

function customer(w, id, { phone, name = "Test Customer", marketing = 0, optOut = 0, whatsapp = 0 } = {}) {
  w.sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,?,?,?, 'customer_app','{}',?,?)")
    .run(id, "blr", name, phone, NOW, NOW);
  w.sqlite.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,opt_out,source,updated_by,updated_at) VALUES (?,?,1,?,0,0,?, 'customer','test',?)")
    .run(id, marketing, whatsapp, optOut, NOW);
  return id;
}

function booking(w, id, customerId, { service = "grooming", status = "completed", endAt = NOW - 90 * DAY, amount = 1499 } = {}) {
  w.sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?, '[]','[]','blr','blr-east',?,?,?,?,?,?,?,?, 'customer_app',?, 'INR','{}','test',?,?)")
    .run(id, `idem-${id}`, customerId, service, `${service}_std`, `${service} standard`, `sg-${id}`, "PRV-1", iso(endAt - 3600_000), iso(endAt), status, amount, NOW, NOW);
  return id;
}

function payment(w, id, bookingId, customerId, { status = "created", createdAt = NOW - 3 * 3600_000, amount = 1499 } = {}) {
  w.sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,?,?, 'INR','upi','prepaid',?, 'uat_sandbox',?, '{}',?,?)")
    .run(id, bookingId, customerId, amount, amount, status, `pay-idem-${id}`, createdAt, createdAt);
}

function subscription(w, id, customerId, { status = "active", expiresAt = NOW + 10 * DAY, total = 6, consumed = 2, reserved = 0 } = {}) {
  w.sqlite.prepare("INSERT INTO customer_grooming_subscriptions (id,customer_id,plan_code,service_package_code,total_sessions,sessions_reserved,sessions_consumed,status,started_at,expires_at,source_booking_id,catalogue_version,created_at,updated_at) VALUES (?,?, 'grm_6m','grm_full_groom',?,?,?,?,?,?,?, 'v1',?,?)")
    .run(id, customerId, total, reserved, consumed, status, NOW - 60 * DAY, expiresAt, `SRC-${id}`, NOW, NOW);
}

function lead(w, id, { service = "grooming", phone, name = "Lead Person", actioned = false, optOut = false, converted = null } = {}) {
  const contactId = `C-${id}`;
  w.sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,stage,owner,source,created_at,updated_at) VALUES (?,?,?, 'New lead','Unassigned','website',?,?)")
    .run(contactId, name, phone, NOW, NOW);
  w.sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,first_action_at,call_attempts,whatsapp_attempts,recycle_cycle,opt_out,converted_booking_id,created_at,updated_at) VALUES (?,?, 'website',?, 'Unassigned','Sales Manager','active','day_1',1,?,?,?,?,0,0,0,?,?,?,?)")
    .run(id, contactId, service, NOW - DAY, NOW, NOW, actioned ? NOW : null, optOut ? 1 : 0, converted, NOW, NOW);
  return id;
}

const audience = (w, campaign, limit = 100) => w.outbound.buildOutboundAudience(w.db, { campaign, limit, at: NOW });

// ---------------------------------------------------------------------------
// 1. All twelve journeys exist, with the consent posture each one deserves.
// ---------------------------------------------------------------------------
test("all twelve outbound journeys from the solution document are defined exactly once", async () => {
  const { HAPTIK_CAMPAIGNS } = await import("../lib/haptik-outbound-governance.ts");
  const expected = [
    "new_lead_followup", "reactivation", "subscription_pitch", "abandoned_checkout", "offer_pitch",
    "subscription_renewal", "pending_session_followup", "dog_training_leads", "winback",
    "boarding_daycare_leads", "dog_walking_leads", "pet_taxi_leads",
  ];
  assert.deepEqual(HAPTIK_CAMPAIGNS.map(c => c.code), expected, "in the document's own order");
  assert.deepEqual(HAPTIK_CAMPAIGNS.map(c => c.useCase), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  // A pitch needs express marketing consent. A call about the customer's own enquiry or their own
  // purchase does not - requiring it there would silence a renewal reminder.
  const consent = code => HAPTIK_CAMPAIGNS.find(c => c.code === code).requiresMarketingConsent;
  for (const pitching of ["reactivation", "subscription_pitch", "offer_pitch", "winback"]) {
    assert.equal(consent(pitching), true, `${pitching} pitches and must require marketing consent`);
  }
  for (const relational of ["new_lead_followup", "abandoned_checkout", "subscription_renewal", "pending_session_followup", "dog_training_leads", "boarding_daycare_leads", "dog_walking_leads", "pet_taxi_leads"]) {
    assert.equal(consent(relational), false, `${relational} is not a pitch`);
  }
});

test("every campaign has an audience builder - none falls through to another campaign's audience", async () => {
  const w = await world();
  const { HAPTIK_CAMPAIGNS } = await import("../lib/haptik-outbound-governance.ts");
  for (const campaign of HAPTIK_CAMPAIGNS) {
    const rows = await audience(w, campaign.code);
    assert.ok(Array.isArray(rows), `${campaign.code} returned no audience array`);
  }
  // A campaign code with no builder must fail loudly rather than silently dialling someone else's list.
  await assert.rejects(() => w.outbound.buildOutboundAudience(w.db, { campaign: "not_a_campaign", at: NOW }), /Unknown outbound campaign/);
});

test("a cold database yields an empty audience for every campaign rather than an error", async () => {
  const { sqlite, db } = freshCountingD1();
  void sqlite;
  globalThis.__HAPTIK_AUDIENCE_DB__ = db;
  const outbound = await import("../lib/haptik-outbound-governance.ts");
  await outbound.ensureHaptikOutboundTables(db);
  const { HAPTIK_CAMPAIGNS } = outbound;
  for (const campaign of HAPTIK_CAMPAIGNS) {
    const rows = await outbound.buildOutboundAudience(db, { campaign: campaign.code, at: NOW });
    assert.deepEqual(rows, [], `${campaign.code} must be cold-DB safe`);
  }
});

// ---------------------------------------------------------------------------
// 2. Use case 4 - abandoned checkout.
// ---------------------------------------------------------------------------
test("abandoned checkout dials an unpaid booking past the window and nothing else", async () => {
  const w = await world();
  customer(w, "CU-ABANDON", { phone: "+919800000001", name: "Abandoned Ann" });
  booking(w, "BK-ABANDON", "CU-ABANDON", { status: "confirmed" });
  payment(w, "PAY-ABANDON", "BK-ABANDON", "CU-ABANDON", { status: "created" });

  // Paid: must not be recovered.
  customer(w, "CU-PAID", { phone: "+919800000002" });
  booking(w, "BK-PAID", "CU-PAID", { status: "confirmed" });
  payment(w, "PAY-PAID", "BK-PAID", "CU-PAID", { status: "captured" });

  // Still inside the window - the customer may be mid-checkout right now.
  customer(w, "CU-FRESH", { phone: "+919800000003" });
  booking(w, "BK-FRESH", "CU-FRESH", { status: "confirmed" });
  payment(w, "PAY-FRESH", "BK-FRESH", "CU-FRESH", { status: "created", createdAt: NOW - 5 * 60_000 });

  // Cancelled booking - there is nothing to recover.
  customer(w, "CU-CANCELLED", { phone: "+919800000004" });
  booking(w, "BK-CANCELLED", "CU-CANCELLED", { status: "cancelled" });
  payment(w, "PAY-CANCELLED", "BK-CANCELLED", "CU-CANCELLED", { status: "failed" });

  const rows = await audience(w, "abandoned_checkout");
  assert.deepEqual(rows.map(r => r.contactId), ["CU-ABANDON"]);
  assert.equal(rows[0].context.bookingId, "BK-ABANDON");
  assert.equal(rows[0].context.amount, 1499);
  assert.equal(rows[0].context.reason, "abandoned_checkout");
});

test("abandoned checkout needs no marketing consent but still obeys opt-out", async () => {
  const w = await world();
  // No preferences row at all - a customer recovering their own checkout must not be excluded by the
  // absence of a marketing opt-in.
  w.sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,?,?,?, 'customer_app','{}',?,?)")
    .run("CU-NOPREF", "blr", "No Preference", "+919800000010", NOW, NOW);
  booking(w, "BK-NOPREF", "CU-NOPREF", { status: "confirmed" });
  payment(w, "PAY-NOPREF", "BK-NOPREF", "CU-NOPREF");

  customer(w, "CU-OPTOUT", { phone: "+919800000011", optOut: 1 });
  booking(w, "BK-OPTOUT", "CU-OPTOUT", { status: "confirmed" });
  payment(w, "PAY-OPTOUT", "BK-OPTOUT", "CU-OPTOUT");

  const rows = await audience(w, "abandoned_checkout");
  assert.deepEqual(rows.map(r => r.contactId), ["CU-NOPREF"], "no preferences row is not an exclusion; opt_out is");
});

// ---------------------------------------------------------------------------
// 3. Use cases 5 and 9 - the offer pitch and the winback are complements.
// ---------------------------------------------------------------------------
test("the offer pitch dials warm customers and the winback dials dormant ones, never both", async () => {
  const w = await world();
  customer(w, "CU-WARM", { phone: "+919800000021", marketing: 1 });
  booking(w, "BK-WARM", "CU-WARM", { endAt: NOW - 30 * DAY });
  customer(w, "CU-DORMANT", { phone: "+919800000022", marketing: 1 });
  booking(w, "BK-DORMANT", "CU-DORMANT", { endAt: NOW - 400 * DAY });

  const offer = await audience(w, "offer_pitch");
  const winback = await audience(w, "winback");
  assert.deepEqual(offer.map(r => r.contactId), ["CU-WARM"]);
  assert.deepEqual(winback.map(r => r.contactId), ["CU-DORMANT"]);
  // The same customer must never be in both audiences - two different conversations on one day.
  const overlap = offer.filter(o => winback.some(b => b.contactId === o.contactId));
  assert.deepEqual(overlap, [], "the 180-day boundary partitions the two audiences");
});

test("the pitching campaigns dial nobody without express marketing consent", async () => {
  const w = await world();
  customer(w, "CU-NOCONSENT", { phone: "+919800000031", marketing: 0 });
  booking(w, "BK-NOCONSENT", "CU-NOCONSENT", { endAt: NOW - 30 * DAY });
  customer(w, "CU-CONSENT-OPTOUT", { phone: "+919800000032", marketing: 1, optOut: 1 });
  booking(w, "BK-CONSENT-OPTOUT", "CU-CONSENT-OPTOUT", { endAt: NOW - 30 * DAY });

  for (const campaign of ["offer_pitch", "reactivation", "winback", "subscription_pitch"]) {
    const rows = await audience(w, campaign);
    assert.deepEqual(rows, [], `${campaign} must not dial without consent, or over an opt-out`);
  }
});

// ---------------------------------------------------------------------------
// 4. Use cases 6 and 7 - renewal and unused sessions.
// ---------------------------------------------------------------------------
test("the renewal reminder dials subscriptions inside the window and not those already expired", async () => {
  const w = await world();
  customer(w, "CU-RENEW", { phone: "+919800000041" });
  subscription(w, "SUB-RENEW", "CU-RENEW", { expiresAt: NOW + 10 * DAY });
  customer(w, "CU-FARAWAY", { phone: "+919800000042" });
  subscription(w, "SUB-FARAWAY", "CU-FARAWAY", { expiresAt: NOW + 120 * DAY });
  customer(w, "CU-EXPIRED", { phone: "+919800000043" });
  subscription(w, "SUB-EXPIRED", "CU-EXPIRED", { expiresAt: NOW - 5 * DAY });
  customer(w, "CU-CANCELLED-SUB", { phone: "+919800000044" });
  subscription(w, "SUB-CANCELLED", "CU-CANCELLED-SUB", { status: "cancelled", expiresAt: NOW + 10 * DAY });

  const rows = await audience(w, "subscription_renewal");
  assert.deepEqual(rows.map(r => r.contactId), ["CU-RENEW"]);
  assert.equal(rows[0].context.planCode, "grm_6m");
  assert.equal(rows[0].context.sessionsLeft, 4);
});

test("the pending-session chase ignores sessions the customer has already scheduled", async () => {
  const w = await world();
  customer(w, "CU-UNUSED", { phone: "+919800000051" });
  subscription(w, "SUB-UNUSED", "CU-UNUSED", { total: 6, consumed: 2, reserved: 0 });
  customer(w, "CU-ALL-BOOKED", { phone: "+919800000052" });
  // Four used, two already in the calendar: nothing to chase.
  subscription(w, "SUB-BOOKED", "CU-ALL-BOOKED", { total: 6, consumed: 4, reserved: 2 });
  customer(w, "CU-FINISHED", { phone: "+919800000053" });
  subscription(w, "SUB-FINISHED", "CU-FINISHED", { total: 6, consumed: 6, reserved: 0 });

  const rows = await audience(w, "pending_session_followup");
  assert.deepEqual(rows.map(r => r.contactId), ["CU-UNUSED"]);
  assert.equal(rows[0].context.sessionsLeft, 4);
});

// ---------------------------------------------------------------------------
// 5. Use cases 8, 10, 11, 12 - the service qualification campaigns.
// ---------------------------------------------------------------------------
test("each service-qualification campaign dials only its own open enquiries", async () => {
  const w = await world();
  lead(w, "LEAD-TRAIN", { service: "dog_training", phone: "+919800000061", name: "Training Lead" });
  lead(w, "LEAD-BOARD", { service: "boarding", phone: "+919800000062", name: "Boarding Lead" });
  lead(w, "LEAD-SIT", { service: "pet_sitting", phone: "+919800000063", name: "Sitting Lead" });
  lead(w, "LEAD-WALK", { service: "dog_walking", phone: "+919800000064", name: "Walking Lead" });
  lead(w, "LEAD-TAXI", { service: "pet_taxi", phone: "+919800000065", name: "Taxi Lead" });
  lead(w, "LEAD-GROOM", { service: "grooming", phone: "+919800000066", name: "Grooming Lead" });

  assert.deepEqual((await audience(w, "dog_training_leads")).map(r => r.contactId), ["C-LEAD-TRAIN"]);
  // Boarding, sitting and daycare are one conversation in the document, so one campaign covers them.
  assert.deepEqual((await audience(w, "boarding_daycare_leads")).map(r => r.contactId).sort(), ["C-LEAD-BOARD", "C-LEAD-SIT"]);
  assert.deepEqual((await audience(w, "dog_walking_leads")).map(r => r.contactId), ["C-LEAD-WALK"]);
  assert.deepEqual((await audience(w, "pet_taxi_leads")).map(r => r.contactId), ["C-LEAD-TAXI"]);
  // And the grooming lead belongs to campaign 1, not to any of these.
  assert.deepEqual((await audience(w, "new_lead_followup")).map(r => r.contactId).sort(), ["C-LEAD-BOARD", "C-LEAD-GROOM", "C-LEAD-SIT", "C-LEAD-TAXI", "C-LEAD-TRAIN", "C-LEAD-WALK"]);
});

test("a lead already actioned, opted out or converted is not dialled again", async () => {
  const w = await world();
  lead(w, "LEAD-OPEN", { service: "dog_training", phone: "+919800000071" });
  lead(w, "LEAD-ACTIONED", { service: "dog_training", phone: "+919800000072", actioned: true });
  lead(w, "LEAD-OPTOUT", { service: "dog_training", phone: "+919800000073", optOut: true });
  lead(w, "LEAD-CONVERTED", { service: "dog_training", phone: "+919800000074", converted: "BK-DONE" });
  const rows = await audience(w, "dog_training_leads");
  assert.deepEqual(rows.map(r => r.contactId), ["C-LEAD-OPEN"]);
});

test("a service enquiry recorded under the older short code is still dialled", async () => {
  const w = await world();
  // Leads created before the service vocabulary settled carry "training"/"walking"/"taxi".
  lead(w, "LEAD-OLD-TRAIN", { service: "training", phone: "+919800000081" });
  lead(w, "LEAD-OLD-WALK", { service: "walking", phone: "+919800000082" });
  lead(w, "LEAD-OLD-TAXI", { service: "taxi", phone: "+919800000083" });
  assert.deepEqual((await audience(w, "dog_training_leads")).map(r => r.contactId), ["C-LEAD-OLD-TRAIN"]);
  assert.deepEqual((await audience(w, "dog_walking_leads")).map(r => r.contactId), ["C-LEAD-OLD-WALK"]);
  assert.deepEqual((await audience(w, "pet_taxi_leads")).map(r => r.contactId), ["C-LEAD-OLD-TAXI"]);
});

// ---------------------------------------------------------------------------
// 6. Dialling itself stays fail-closed and guardrailed across the new campaigns.
// ---------------------------------------------------------------------------
test("no new campaign can dial while Haptik outbound is unconfigured", async () => {
  const w = await world();
  customer(w, "CU-READY", { phone: "+919800000091", marketing: 1 });
  booking(w, "BK-READY", "CU-READY", { endAt: NOW - 30 * DAY });
  const { HAPTIK_CAMPAIGNS } = await import("../lib/haptik-outbound-governance.ts");
  for (const campaign of HAPTIK_CAMPAIGNS) {
    const result = await w.outbound.triggerOutboundCampaign(w.db, {}, { campaign: campaign.code, limit: 10, actorId: "ops@pawspace.in", at: NOW });
    assert.equal(result.connected, false, `${campaign.code} dialled with no credentials`);
    assert.equal(result.dialled, 0);
    assert.match(result.reason, /not connected/);
  }
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM haptik_outbound_calls").get().c), 0);
});

test("the readiness snapshot covers all twelve campaigns", async () => {
  const w = await world();
  const readiness = await w.outbound.outboundReadiness(w.db);
  assert.equal(readiness.length, 12);
  for (const row of readiness) {
    assert.equal(typeof row.ready, "number");
    assert.equal(typeof row.label, "string");
  }
});

test("the scheduler sweep counts every campaign's audience and dials none of them", async () => {
  const w = await world();
  customer(w, "CU-SWEEP", { phone: "+919800000095", marketing: 1 });
  booking(w, "BK-SWEEP", "CU-SWEEP", { endAt: NOW - 400 * DAY });
  const result = await w.outbound.runHaptikOutboundSweep(w.db, { asOf: NOW });
  assert.equal(result.dialled, 0, "the sweep never dials");
  assert.equal(result.readiness.length, 12);
  const winback = result.readiness.find(r => r.campaign === "winback");
  assert.equal(winback.ready, 1, "but it does count who would be called");
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM haptik_outbound_calls").get().c), 0);
});
