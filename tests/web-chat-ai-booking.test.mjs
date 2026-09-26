/**
 * PawSpace AI books from the signed-in web chat. It uses the voice specialists' governed flow: the model's
 * proposal becomes a stored, server-quoted offer read back to the customer, and only the customer's
 * separate "yes" books it. An approved coupon (GROOM200 / GROOM400) rides on that offer. Its discount and
 * total come from the coupon engine, and the booking consumes that exact quote.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney } from "./helpers/grooming-journey-harness.mjs";
import { seedOwnedPet } from "./helpers/saved-pet-fixture.mjs";
const sales = await import("../lib/voice-sales-specialists.ts");
const orchestrator = await import("../lib/ai-conversation-orchestrator.ts");
const rollout = await import("../lib/ai-audience-rollout.ts");
const scheduling = await import("../app/api/uat-scheduling/route.ts");
const account = await import("../lib/customer-account.ts");
const coupons = await import("../lib/coupon-governance.ts");
const controlPlane = await import("../lib/ai-first-control-plane.ts");
const webChat = await import("../lib/ai-web-chat-adapter.ts");

const actor = { email: "web-chat-ai@system.pawspace", name: "PawSpace web chat AI", roleCode: "service_web_chat_ai", permissions: ["communications.manage", "customers.manage", "bookings.manage", "scheduling.book"], developmentPreview: false, identitySource: "workspace", principalType: "identity_subject", principalKey: "service:web-chat-ai" };
// A week from today (10:00-12:00 IST), so the suite never books in the past.
const day = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10), start = `${day}T04:30:00.000Z`, end = `${day}T06:30:00.000Z`;

async function world(t) {
  const w = await setupJourney(); t.after(() => w.close());
  await account.ensureCustomerAccountTables(w.db); await orchestrator.ensureAiConversationOrchestrator(w.db);
  const now = Date.now(), customerId = "CUS-CHAT-SALES", threadId = "THREAD-CHAT-SALES", petId = "PET-CHAT-SALES";
  w.sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?, 'blr','Synthetic Chat Buyer','9876500077','test','{}',?,?)").run(customerId, now, now);
  await seedOwnedPet(w.db, customerId, petId, "Bruno");
  w.sqlite.prepare("INSERT INTO communication_threads (id,customer_id,status,assigned_to,created_at,updated_at) VALUES (?,?,'open','ai-orchestrator',?,?)").run(threadId, customerId, now, now);
  await rollout.setAiRolloutStage(w.db, { stage: "staff_only", reason: "Synthetic chat sales proof", actorEmail: actor.email });
  await scheduling.executeGovernedSchedulingRequest(new Request("https://internal.pawspace/api/uat-scheduling", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "preview", clientRequestId: "INIT-PREVIEW", customerId, petIds: [petId], serviceCode: "grooming", serviceAddress: "12 Test Street", servicePincode: "560038", scheduledStart: start, scheduledEnd: end }) }), actor);
  for (const p of w.sqlite.prepare("SELECT id,city_id,zones_json FROM provider_capacity_profiles WHERE live=1 AND status='active'").all()) {
    w.sqlite.prepare("INSERT OR IGNORE INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) VALUES (?,?,?,12.9716,77.5946,0,NULL,'test','test',?)").run(`chat-base-${p.id}`, p.id, "Test base", now);
    for (const zone of JSON.parse(p.zones_json)) for (let day = 0; day < 35; day++) {
      const date = new Date(Date.parse(start) + day * 86400000).toISOString().slice(0, 10);
      w.sqlite.prepare("INSERT OR REPLACE INTO scheduling_availability (id,provider_id,city_id,zone_id,date,windows_json,source,updated_at) VALUES (?,?,?,?,?,'[\"09:00-19:00\"]','roster',?)").run(`${p.id}:${zone}:${date}`, p.id, p.city_id, zone, date, now);
    }
  }
  // The seeded sales campaigns run on fixed dates; open their window around the real clock.
  await coupons.seedUatCoupons(w.db);
  w.sqlite.prepare("UPDATE coupon_campaigns SET valid_from=0, valid_until=? WHERE id LIKE 'sales-coupon-%'").run(Date.now() + 86_400_000);
  globalThis.__GROOM_GOLDEN_ENV__ = { ...globalThis.__GROOM_GOLDEN_ENV__, FORBID_PRODUCTION: "true", PAWSPACE_PAYMENT_ENV: "sandbox", RAZORPAY_KEY_ID_SANDBOX: "rzp_test_chat", RAZORPAY_KEY_SECRET_SANDBOX: "not-real-chat" };
  const orders = []; const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => { assert.equal(String(url), "https://api.razorpay.com/v1/orders"); const body = JSON.parse(init.body); orders.push(body.amount); return Response.json({ id: `order_chat_${orders.length}`, entity: "order", amount: body.amount, amount_paid: 0, amount_due: body.amount, currency: body.currency, receipt: body.receipt, status: "created" }); };
  return { ...w, customerId, threadId, petId, orders };
}
const plan = (w, booking = {}) => [
  { toolCode: "schedule.reserve", arguments: { serviceCode: "grooming", petIds: [w.petId], serviceAddress: "12 Test Street", servicePincode: "560038", scheduledStart: start, scheduledEnd: end } },
  { toolCode: "booking.create", arguments: { petIds: [w.petId], packageCode: "dog-basic", paymentMode: "prepaid", ...booking } },
  { toolCode: "checkout.payment_order.create", arguments: {} },
];
async function chatTurn(w, message, key, provider, channel = "chat") {
  const now = Date.now(), messageId = `MSG-${key}`;
  w.sqlite.prepare(`INSERT INTO communication_messages (id,thread_id,customer_id,provider,channel,direction,purpose,template_key,payload_json,status,idempotency_key,created_by,created_at,updated_at) VALUES (?,?,?,'${channel === "chat" ? "pawspace_web" : "meta_whatsapp"}','${channel}','inbound','transactional','web_app_chat',?,'received',?,'chat-test',?,?)`).run(messageId, w.threadId, w.customerId, JSON.stringify({ text: message }), key, now, now);
  return orchestrator.orchestrateAiTurn(w.db, { actor, threadId: w.threadId, customerId: w.customerId, inputMessageId: messageId, idempotencyKey: key, channel, provider });
}
const salesModel = (actions) => { let calls = 0; return { get calls() { return calls; }, salesService: "grooming", status: "connected", provider: "mock-chat-sales", modelRef: "proof", async generate() { calls++; return { text: "Here is your booking", provider: "mock-chat-sales", modelRef: "proof", latencyMs: 1, actionRequests: actions }; } }; };
const bookings = (w) => w.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='canonical_bookings'").get() ? w.sqlite.prepare("SELECT id,total_amount,pricing_json FROM canonical_bookings WHERE customer_id=?").all(w.customerId) : [];

test("web chat: a GROOM200 offer is read back with the server's discount, and 'yes' books it at that price", async (t) => {
  const w = await world(t), model = salesModel(plan(w, { couponCode: "groom200" }));
  const offered = await chatTurn(w, "Please book Bath & Basic with the GROOM200 offer", "chat-offer", model);
  assert.equal(offered.turn.policyDecision, "customer_confirmation_required");
  const stored = JSON.parse(w.sqlite.prepare("SELECT quote_json FROM voice_sales_offers WHERE thread_id=?").get(w.threadId).quote_json);
  assert.equal(stored.coupon.code, "GROOM200"); assert.equal(stored.coupon.discount, 200);
  assert.equal(stored.coupon.finalAmount, stored.totalAmount - 200);
  const inr = (n) => `INR ${Number(n).toLocaleString("en-IN")}`;
  assert.ok(offered.turn.output.includes(`Coupon GROOM200: INR 200 off ${inr(stored.totalAmount)}.`), offered.turn.output);
  assert.ok(offered.turn.output.includes(`Total ${inr(stored.coupon.finalAmount)}`), offered.turn.output);
  assert.equal(bookings(w).length, 0, "nothing is booked before the customer says yes");

  const confirmed = await chatTurn(w, "Yes", "chat-yes", model);
  assert.equal(confirmed.turn.policyDecision, "customer_confirmed_action_executed");
  assert.equal(model.calls, 1, "the yes books the stored offer; the model is not asked again");
  const [booking] = bookings(w), pricing = JSON.parse(booking.pricing_json);
  assert.equal(booking.total_amount, stored.coupon.finalAmount);
  assert.equal(pricing.couponCode, "GROOM200"); assert.equal(pricing.discount, 200);
  assert.deepEqual(w.orders, [Math.round(stored.coupon.finalAmount * 100)], "the payment order is for the discounted total");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM coupon_redemptions WHERE code='GROOM200' AND customer_id=? AND status='consumed'").get(w.customerId).n, 1);
  assert.ok(confirmed.turn.output.includes(`Pay securely here to confirm it: /v2/booking?bookingId=${booking.id}`), confirmed.turn.output);

  // Nothing is announced until the verified capture marks the payment captured; then exactly once.
  assert.deepEqual(await webChat.announcePaidAiBookings(w.db, { threadId: w.threadId }), { announced: 0 });
  w.sqlite.prepare("UPDATE booking_payments SET status='captured' WHERE booking_id=?").run(booking.id);
  assert.deepEqual(await webChat.announcePaidAiBookings(w.db, { threadId: w.threadId }), { announced: 1 });
  assert.deepEqual(await webChat.announcePaidAiBookings(w.db, {}), { announced: 0 }, "the sweep does not announce it again");
  const offerId = w.sqlite.prepare("SELECT id FROM voice_sales_offers WHERE thread_id=? AND status='completed'").get(w.threadId).id;
  const paid = w.sqlite.prepare("SELECT payload_json FROM communication_messages WHERE idempotency_key=?").get(`ai-booking-paid:${offerId}`);
  assert.match(JSON.parse(paid.payload_json).text, /^Payment received - your .+ booking is confirmed\./);
});

test("WhatsApp: the AI books through the same stored offer, with the WhatsApp coupon channel and a full pay link", async (t) => {
  const w = await world(t), model = salesModel(plan(w, { couponCode: "GROOM200" }));
  const offered = await chatTurn(w, "Book Bath & Basic with GROOM200", "wa-offer", model, "whatsapp");
  assert.equal(offered.turn.policyDecision, "customer_confirmation_required");
  const stored = JSON.parse(w.sqlite.prepare("SELECT quote_json FROM voice_sales_offers WHERE thread_id=?").get(w.threadId).quote_json);
  assert.equal(w.sqlite.prepare("SELECT channel FROM coupon_quotes WHERE id=?").get(stored.coupon.quoteId).channel, "whatsapp");
  const confirmed = await chatTurn(w, "yes", "wa-yes", model, "whatsapp");
  assert.equal(confirmed.turn.policyDecision, "customer_confirmed_action_executed");
  const [booking] = bookings(w);
  assert.ok(confirmed.turn.output.includes(`https://pawspace.in/v2/booking?bookingId=${booking.id}`), confirmed.turn.output);
  assert.equal(booking.total_amount, stored.coupon.finalAmount);
});

test("web chat: an offer the server cannot quote is said back to the customer, not booked or handed off", async (t) => {
  const w = await world(t);
  const invented = await chatTurn(w, "Use SAVE50 please", "chat-invented", salesModel(plan(w, { couponCode: "SAVE50" })));
  assert.equal(invented.turn.policyDecision, "clarification_required");
  assert.match(invented.turn.output, /couldn't prepare that booking yet: That coupon is not an offer PawSpace AI can apply/);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM voice_sales_offers").get().n, 0);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM ai_handoffs").get().n, 0);
  // Used once already: GROOM200 is one per customer, so it is no longer an offer for them.
  w.sqlite.prepare("INSERT INTO coupon_redemptions (id,idempotency_key,quote_id,campaign_id,code,customer_id,booking_id,discount_amount,status,created_at,updated_at) VALUES ('R-USED','K-USED','Q-USED','sales-coupon-groom200','GROOM200',?,'BK-OLD',200,'consumed',1,1)").run(w.customerId);
  const used = await chatTurn(w, "Apply GROOM200", "chat-used", salesModel(plan(w, { couponCode: "GROOM200" })));
  assert.equal(used.turn.policyDecision, "clarification_required");
  assert.equal(bookings(w).length, 0);
});

test("a coupon is refused on voice, and booking.create never takes a coupon quote outside a confirmed offer", async (t) => {
  const w = await world(t);
  await assert.rejects(sales.prepareVoiceSalesOffer(w.db, { actor, threadId: w.threadId, customerId: w.customerId, service: "grooming", turnKey: "voice-coupon", actions: plan(w, { couponCode: "GROOM200" }) }), (e) => e instanceof Response && e.status === 400);
  const quote = await coupons.quoteCoupon(w.db, { code: "GROOM200", customerId: w.customerId, serviceCode: "grooming", cityId: "blr", channel: "website", packageCode: "dog-basic", orderValue: 1899, paymentMode: "full", isSubscription: false });
  assert.equal(quote.valid, true);
  await assert.rejects(controlPlane.executeGovernedConversationTool(w.db, { actor, threadId: w.threadId, customerId: w.customerId, channel: "chat", intent: "booking_create", toolCode: "booking.create", arguments: { scheduleGroupId: "GROUP-NONE", petIds: [w.petId], packageCode: "dog-basic", paymentMode: "prepaid", couponQuoteId: quote.quoteId }, idempotencyKey: "guessed-coupon", customerConfirmed: true }), (e) => e instanceof Response);
  assert.equal(bookings(w).length, 0);
});

test("the chat remembers which service it is selling from what the customer names", () => {
  for (const message of ["I want grooming for Bruno", "Book a bath", "Complete Makeover please"]) assert.equal(webChat.chatSalesServiceNamed(message), "grooming", message);
  for (const message of ["Dog training for my puppy", "Do you have a trainer?"]) assert.equal(webChat.chatSalesServiceNamed(message), "dog_training", message);
  for (const message of ["Yes", "Saturday 10am", "What is my booking status?"]) assert.equal(webChat.chatSalesServiceNamed(message), null, message);
  assert.match(sales.specialistSalesPrompt("grooming", { coupons: true }), /booking\.couponCode/);
  assert.doesNotMatch(sales.specialistSalesPrompt("grooming"), /couponCode/);
});

test("only PawSpace's own pay link is clickable in the chat, and only on PawSpace's side", async () => {
  const { readFile } = await import("node:fs/promises");
  const pane = await readFile(new URL("../app/components/wati-chat/WatiConversation.tsx", import.meta.url), "utf8");
  assert.match(pane, /const PAY_LINK=\/\(\\\/v2\\\/booking\\\?bookingId=\[A-Za-z0-9_-\]\+\)\//);
  assert.match(pane, /message\.side==="pawspace"\?withPayLink\(message\.text\):message\.text/);
  assert.doesNotMatch(pane, /dangerouslySetInnerHTML/);
});
