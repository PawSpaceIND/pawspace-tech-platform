import { expect, test } from "@playwright/test";
import { seedOwnedPet } from "../helpers/saved-pet-fixture.mjs";
import { setupJourney, runCompletedJourney, routeCall, sessionCookie } from "../helpers/grooming-journey-harness.mjs";
import { cleanupExpiredReservationLeases, SCHEDULING_RESERVATION_LEASE_MS } from "../../lib/scheduling-reservation-leases";
import { runAutomaticBookingRefundSweep } from "../../lib/automatic-booking-refund";
import { buildCompanyAnalytics } from "../../lib/company-analytics";
import { ensureCanonicalBookingReadModel } from "../../lib/canonical-booking-read-model";

const futureSlot = (daysAhead = 12) => {
  const start = new Date(Date.now() + daysAhead * 86_400_000);
  start.setUTCHours(5, 30, 0, 0);
  return { start: start.toISOString(), end: new Date(start.getTime() + 2 * 60 * 60_000).toISOString() };
};

async function sign(raw: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function reserve(ctx: Awaited<ReturnType<typeof setupJourney>>, input: { groupId: string; customerId: string; petId: string; cookie: string; start: string; end: string }) {
  return routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", {
    clientRequestId: input.groupId,
    customerId: input.customerId,
    petIds: [input.petId],
    serviceCode: "grooming",
    cityId: "blr",
    zoneId: "blr-east",
    serviceAddress: `${input.customerId} concurrency address`,
    servicePincode: "560038",
    scheduledStart: input.start,
    scheduledEnd: input.end,
    preferredProviderId: "groom_arun",
  }, input.cookie);
}

test("01A same-slot concurrency: one reservation wins, two lose, losers create no Razorpay order", async () => {
  const ctx = await setupJourney();
  try {
    const { start, end } = futureSlot(12);
    const actors: Array<{ groupId: string; customerId: string; petId: string; cookie: string; start: string; end: string }> = [];
    // Fixture setup is intentionally sequential because the in-memory D1 adapter uses one SQLite
    // connection. The concurrency under test begins below at the reservation barrier, not during seeding.
    for (const index of [0, 1, 2]) {
      const customerId = `CUST-CONC-${index + 1}`;
      const petId = `PET-CONC-${index + 1}`;
      await seedOwnedPet(ctx.db, customerId, petId, `Dog ${index + 1}`);
      const cookie = await sessionCookie(ctx.db, "customer", customerId, `customer:${customerId}`);
      actors.push({ groupId: `GROOM-CONC-${index + 1}`, customerId, petId, cookie, start, end });
    }

    const originalBatch = ctx.db.batch.bind(ctx.db);
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let serialized: Promise<unknown> = Promise.resolve();
    const runSerialized = (items: Array<{ _sql?: string }>) => {
      const run = serialized.then(() => originalBatch(items as never));
      serialized = run.catch(() => undefined);
      return run as never;
    };
    ctx.db.batch = async (items: Array<{ _sql?: string }>) => {
      const reservationWrite = items.some(item => String(item._sql || "").includes("INSERT INTO scheduling_reservations"));
      // Auth/schema preparation is not the race being certified and the in-memory adapter has one
      // SQLite connection, so serialize those batches. All three requests still rendezvous below at
      // the actual reservation write before any contender is allowed to commit.
      if (!reservationWrite) return runSerialized(items);
      arrivals += 1;
      if (arrivals === actors.length) release();
      await barrier;
      return runSerialized(items);
    };

    const responses = await Promise.all(actors.map(actor => reserve(ctx, actor)));
    expect(responses.map(response => response.status).sort()).toEqual([200, 409, 409]);
    const losers = responses.filter(response => response.status === 409);
    expect(losers).toHaveLength(2);
    for (const loser of losers) expect(loser.body.error).toBe("SLOT_TAKEN");

    const active = ctx.sqlite.prepare("SELECT COUNT(*) count FROM scheduling_reservations WHERE provider_id='groom_arun' AND scheduled_start=? AND scheduled_end=? AND status!='cancelled'").get(start, end) as { count: number };
    expect(Number(active.count)).toBe(1);
    const intents = ctx.sqlite.prepare("SELECT COUNT(*) count FROM payment_intents").get() as { count: number };
    const orderCommands = ctx.sqlite.prepare("SELECT COUNT(*) count FROM financial_outbox WHERE event_type='CREATE_RAZORPAY_ORDER'").get() as { count: number };
    expect(Number(intents.count)).toBe(0);
    expect(Number(orderCommands.count)).toBe(0);
  } finally { ctx.close(); }
});

test("01B abandoned reservation: five-minute lease cleanup releases capacity for the next customer", async () => {
  const ctx = await setupJourney();
  const db = ctx.db as unknown as D1Database;
  try {
    await ensureCanonicalBookingReadModel(db);
    expect(SCHEDULING_RESERVATION_LEASE_MS).toBe(5 * 60_000);
    const { start, end } = futureSlot(14);
    const a = { customerId: "CUST-TTL-A", petId: "PET-TTL-A", groupId: "GROOM-TTL-A" };
    const b = { customerId: "CUST-TTL-B", petId: "PET-TTL-B", groupId: "GROOM-TTL-B" };
    await seedOwnedPet(ctx.db, a.customerId, a.petId, "A");
    await seedOwnedPet(ctx.db, b.customerId, b.petId, "B");
    const aCookie = await sessionCookie(ctx.db, "customer", a.customerId, `customer:${a.customerId}`);
    const bCookie = await sessionCookie(ctx.db, "customer", b.customerId, `customer:${b.customerId}`);

    const first = await reserve(ctx, { ...a, cookie: aCookie, start, end });
    expect(first.status).toBe(200);
    const lease = ctx.sqlite.prepare("SELECT lease_expires_at FROM scheduling_reservations WHERE group_id=?").get(a.groupId) as { lease_expires_at: number };
    expect(Number(lease.lease_expires_at)).toBeGreaterThan(Date.now());
    expect(Number(lease.lease_expires_at) - Date.now()).toBeLessThanOrEqual(5 * 60_000);

    const cleaned = await cleanupExpiredReservationLeases(db, Number(lease.lease_expires_at) + 1);
    expect(cleaned).toEqual({ groups: 1, reservations: 1 });
    expect((ctx.sqlite.prepare("SELECT status FROM scheduling_reservations WHERE group_id=?").get(a.groupId) as { status: string }).status).toBe("cancelled");
    expect(Number((ctx.sqlite.prepare("SELECT COUNT(*) count FROM canonical_bookings WHERE schedule_group_id=?").get(a.groupId) as { count: number }).count)).toBe(0);

    const second = await reserve(ctx, { ...b, cookie: bCookie, start, end });
    expect(second.status).toBe(200);
    expect(second.body.data.provider.id).toBe("groom_arun");
  } finally { ctx.close(); }
});

test("01C paid cancellation: one refund case, Razorpay Payments refund, exact reversal, one WhatsApp, no analytics double-count", async () => {
  const ctx = await setupJourney();
  const db = ctx.db as unknown as D1Database;
  const originalFetch = globalThis.fetch;
  try {
    const start = futureSlot(16).start;
    const config = {
      customerId: "CUST-COMP-01", customerName: "Compensation Customer", phone: "+919900000901",
      petSourceId: "PET-COMP-01", petName: "Milo", cityId: "blr", zoneId: "blr-east", pincode: "560038",
      latitude: 12.9716, longitude: 77.5946, preferredProviderId: "groom_arun", groupId: "GROOM-COMP-01", start,
      stopAfterCapture: true,
    };
    const runtime = (globalThis as typeof globalThis & { __GROOM_GOLDEN_ENV__: Record<string, unknown> }).__GROOM_GOLDEN_ENV__;
    Object.assign(runtime, {
      PAWSPACE_PAYMENT_ENV: "sandbox",
      PAWSPACE_PAYMENT_LIVE_APPROVED: "false",
      RAZORPAY_KEY_ID_SANDBOX: "rzp_test_concurrency",
      RAZORPAY_KEY_SECRET_SANDBOX: "secret_concurrency",
      RAZORPAY_WEBHOOK_SECRET_SANDBOX: "whsec_concurrency",
    });

    const journey = await runCompletedJourney(ctx, config);
    // The sandbox simulator returns 201 for every accepted simulate_event request. Idempotency is
    // certified by the single persisted capture/ledger posting below, not by changing HTTP status.
    expect(journey.captured.status).toBe(201);
    expect(journey.captureReplay.status).toBe(201);
    const total = Number(journey.total);
    expect(total).toBeGreaterThan(0);

    const cancelled = await routeCall("../../app/api/grooming-booking-change/route.ts", "POST", "/api/grooming-booking-change", {
      bookingId: journey.bookingId,
      customerId: config.customerId,
      action: "cancel",
      reason: "Customer cancelled before service",
    }, journey.customerCookie);
    expect(cancelled.status).toBe(200);

    const casesBefore = ctx.sqlite.prepare("SELECT id,status,amount,gateway_reference,policy_json FROM booking_refund_cases WHERE booking_id=?").all(journey.bookingId) as Array<{ id: string; status: string; amount: number; gateway_reference: string | null; policy_json: string }>;
    expect(casesBefore).toHaveLength(1);
    expect(casesBefore[0].status).toBe("requested");
    expect(Number(casesBefore[0].amount)).toBe(total);

    let refundCalls = 0;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (/\/v1\/payments\/pay_[^/]+\/refund$/.test(url)) {
        refundCalls += 1;
        const body = JSON.parse(String(init?.body || "{}")) as { amount?: number };
        expect(body.amount).toBe(Math.round(total * 100));
        expect(String(new Headers(init?.headers).get("X-Refund-Idempotency") || "")).toContain(casesBefore[0].id);
        return new Response(JSON.stringify({ id: "rfnd_CONCURRENCY_01", entity: "refund", amount: body.amount, currency: "INR", payment_id: `pay_${config.groupId}`, status: "processed" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected external request in concurrency closure test: ${url}`);
    };

    const sweep = await runAutomaticBookingRefundSweep(db, runtime, { limit: 10 });
    expect(sweep.initiated).toBe(1);
    expect(sweep.notified).toBe(1);
    expect(sweep.failed).toBe(0);
    expect(refundCalls).toBe(1);

    const caseAfterSubmit = ctx.sqlite.prepare("SELECT status,gateway_reference,approved_by FROM booking_refund_cases WHERE id=?").get(casesBefore[0].id) as { status: string; gateway_reference: string; approved_by: string };
    expect(caseAfterSubmit.status).toBe("processing");
    expect(caseAfterSubmit.gateway_reference).toBe("rfnd_CONCURRENCY_01");
    expect(caseAfterSubmit.approved_by).toBe("system:automatic-refund-policy");

    const raw = JSON.stringify({
      event: "refund.processed",
      created_at: Math.floor(Date.now() / 1000),
      payload: { refund: { entity: { id: "rfnd_CONCURRENCY_01", payment_id: `pay_${config.groupId}`, amount: Math.round(total * 100), currency: "INR" } } },
    });
    const signature = await sign(raw, "whsec_concurrency");
    const webhook = await import("../../app/api/razorpay-webhook/route");
    const response = await webhook.POST(new Request("https://uat.pawspace.in/api/razorpay-webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-razorpay-signature": signature, "x-razorpay-event-id": "evt_refund_concurrency_01" },
      body: raw,
    }));
    expect(response.status).toBe(200);
    expect((ctx.sqlite.prepare("SELECT status FROM booking_refund_cases WHERE id=?").get(casesBefore[0].id) as { status: string }).status).toBe("processed");

    const ledger = ctx.sqlite.prepare("SELECT event,reversal_reference,amount FROM collection_ledger_postings WHERE payment_id=(SELECT id FROM booking_payments WHERE booking_id=?) ORDER BY created_at").all(journey.bookingId) as Array<{ event: string; reversal_reference: string | null; amount: number }>;
    expect(ledger.filter(row => row.event === "online_payment_captured")).toHaveLength(1);
    const reversals = ledger.filter(row => row.event === "refund_completed");
    expect(reversals).toHaveLength(1);
    expect(reversals[0].reversal_reference).toBe("rfnd_CONCURRENCY_01");
    expect(Number(reversals[0].amount)).toBe(total);

    const messages = ctx.sqlite.prepare("SELECT id FROM communication_messages WHERE template_key='booking_cancelled_refund_processing' AND idempotency_key=?").all(`BOOKING-REFUND-PROCESSING-${casesBefore[0].id}`);
    expect(messages).toHaveLength(1);
    const outbox = ctx.sqlite.prepare("SELECT COUNT(*) count FROM communication_outbox WHERE message_id=?").get((messages[0] as { id: string }).id) as { count: number };
    expect(Number(outbox.count)).toBe(1);

    const analytics = await buildCompanyAnalytics(db, { serviceCode: "grooming" });
    expect(analytics.bookings.cancelled).toBe(1);
    expect(analytics.money.gmv).toBe(0);
    expect(analytics.money.refunds).toBe(total);
    expect(analytics.money.netCollections).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
    ctx.close();
  }
});
