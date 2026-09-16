import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney, sessionCookie } from "./helpers/grooming-journey-harness.mjs";
import { seedOwnedPet } from "./helpers/saved-pet-fixture.mjs";
import { enterWorkersDbScope } from "./helpers/module-hooks.mjs";

// Local SQLite/D1 integration: real V2 clients, real HTTP handlers and existing domain engines.
// Provider capture below is an explicit deterministic fixture, not a live Razorpay certification.
test("V2 complete local integration: published catalogue -> preview -> one booking -> doorstep -> verified capture -> confirmation", async t => {
  const ctx = await setupJourney(); t.after(() => ctx.close()); enterWorkersDbScope(ctx.db);
  const { db, sqlite } = ctx;
  await seedOwnedPet(db, "CUST-V2", "PET-V2", "Bruno");
  const cookie = await sessionCookie(db, "customer", "CUST-V2", "customer:CUST-V2");
  const routes = {
    "/api/v2/grooming-catalogue": "../app/api/v2/grooming-catalogue/route.ts",
    "/api/service-zone": "../app/api/service-zone/route.ts",
    "/api/live-price-quote": "../app/api/live-price-quote/route.ts",
    "/api/uat-scheduling": "../app/api/uat-scheduling/route.ts",
    "/api/canonical-bookings": "../app/api/canonical-bookings/route.ts",
    "/api/grooming-service-location": "../app/api/grooming-service-location/route.ts",
    "/api/v2/grooming-checkout": "../app/api/v2/grooming-checkout/route.ts",
  };
  const calls = [];
  t.mock.method(globalThis, "fetch", async (path, init = {}) => {
    const url = new URL(String(path), "https://pawspace.test");
    const modulePath = routes[url.pathname];
    assert.ok(modulePath, `No external network permitted: ${url.pathname}`);
    const route = await import(modulePath), method = init.method || "GET";
    const response = await route[method](new Request(url, { ...init, method,
      headers: { ...init.headers, cookie, origin: url.origin } }));
    calls.push({ path: url.pathname, method, status: response.status });
    return response;
  });
  const care = await import("../lib/v2/grooming-client.ts");
  const checkout = await import("../lib/v2/grooming-checkout-client.ts");
  const empty = await care.loadV2GroomingCatalogue();
  assert.equal(empty.packages.length, 0, "unpublished packages must never be silently bookable");
  sqlite.exec("UPDATE service_packages SET active=1 WHERE package_code='dog-basic'");
  const catalogue = await care.loadV2GroomingCatalogue();
  assert.equal(catalogue.packages.length, 1);
  const pkg = catalogue.packages[0], bundle = pkg.bundles[0];
  const coverage = await care.resolveV2GroomingCoverage("560038");
  const isoDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const priced = await care.quoteV2Grooming({ bundle, isoDate, slotIndex: 1, cityId: coverage.cityId, zoneId: coverage.zoneId });
  const address = "21 Indiranagar Main Road, Bengaluru";
  const preview = await care.previewV2Groomers({ customerId: "CUST-V2", petIds: ["PET-V2"], cityId: coverage.cityId, zoneId: coverage.zoneId,
    serviceAddress: address, servicePincode: coverage.pincode, scheduledStart: priced.scheduledStart, scheduledEnd: priced.scheduledEnd });
  assert.ok(preview.providers.length > 0, "local published roster must return an eligible groomer");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations").get().n, 0, "preview must not reserve capacity");
  const pet = { id: "PET-V2", sourceId: "PET-V2", name: "Bruno", species: "dog", vaccinationStatus: "verified" };
  const input = { account: { customerId: "CUST-V2", name: "V2 Integration Customer", primaryPhone: "9000000981", pets: [pet] },
    selectedPets: [pet], pkg, bundle, quote: priced.quote, provider: preview.providers[0], address, pincode: coverage.pincode,
    cityId: coverage.cityId, zoneId: coverage.zoneId, scheduledStart: priced.scheduledStart, scheduledEnd: priced.scheduledEnd };
  const booked = await checkout.createV2GroomingBooking(input);
  assert.equal(booked.status, "payment_pending");
  assert.equal((await checkout.createV2GroomingBooking(input)).bookingId, booked.bookingId);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id='CUST-V2'").get().n, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM booking_payments WHERE customer_id='CUST-V2'").get().n, 1);
  const before = await checkout.loadV2GroomingCheckoutReadiness(booked.bookingId);
  assert.equal(before.locationReady, true); assert.equal(before.confirmation.ready, false);
  assert.equal(before.confirmation.providerId, preview.providers[0].id);
  assert.equal(before.confirmation.totalAmount, priced.quote.price);

  const { ensurePaymentReconciliationTables } = await import("../lib/grooming-payment-reconciliation.ts");
  const { claimPaymentIntent } = await import("../lib/financial-lifecycle.ts");
  const { commitRazorpayCaptureAtomic, executeRazorpayCapturePostCommit } = await import("../lib/razorpay-capture-atomic.ts");
  await ensurePaymentReconciliationTables(db);
  const amountPaise = Math.round(priced.quote.price * 100);
  const intent = await claimPaymentIntent(db, { bookingId: booked.bookingId, customerId: "CUST-V2", paymentId: booked.paymentId,
    idempotencyKey: `v2-integration:${booked.paymentId}`, amountPaise, currency: "INR", environment: "sandbox", commercialSnapshot: {} });
  sqlite.prepare("UPDATE payment_intents SET gateway_order_id='order_v2_fixture' WHERE id=?").run(intent.id);
  const capture = { authority: "provider_api", eventId: "provider-api:capture:pay_v2_fixture", environment: "sandbox", intentId: intent.id,
    bookingId: booked.bookingId, paymentId: booked.paymentId, gatewayOrderId: "order_v2_fixture", gatewayPaymentId: "pay_v2_fixture",
    amountPaise, currency: "INR", payloadHash: "explicit-local-integration-fixture", detail: { testEvidence: "deterministic_fixture_not_live_provider" } };
  const committed = await commitRazorpayCaptureAtomic(db, capture);
  assert.equal((await checkout.loadV2GroomingCheckoutReadiness(booked.bookingId)).confirmation.ready, false,
    "captured money alone must not open success before post-commit booking/work-order convergence");
  const effects = await executeRazorpayCapturePostCommit(db, { outboxId: committed.effectsOutboxId, workerId: "v2-integration" });
  assert.equal(effects.completed, true, JSON.stringify(effects));
  const after = await checkout.loadV2GroomingCheckoutReadiness(booked.bookingId);
  assert.equal(after.confirmation.ready, true, JSON.stringify(after));
  assert.equal(after.confirmation.transactionId, "pay_v2_fixture");
  assert.equal(after.confirmation.scheduledStart, priced.scheduledStart);
  assert.equal(after.confirmation.providerId, preview.providers[0].id);
  const replay = await commitRazorpayCaptureAtomic(db, capture);
  assert.equal(replay.duplicateCapture, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM journal_transactions WHERE source_type='razorpay_capture'").get().n, 1);
  assert.equal((await checkout.createV2GroomingBooking(input)).bookingId, booked.bookingId);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id='CUST-V2'").get().n, 1);
  assert.equal(calls.some(call => call.path === "/api/customer-checkout"), false, "integration fixture did not open an external payment");
});
