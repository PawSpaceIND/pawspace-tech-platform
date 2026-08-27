import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./module-hooks.mjs";

installWorkersHooks("__GROOM_GOLDEN_DB__", "__GROOM_GOLDEN_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    _sql: sql,
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => {
      const info = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(info.changes || 0) } };
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  const db = {
    beforeBatch: null,
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      if (typeof db.beforeBatch === "function") await db.beforeBatch(items);
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const item of items) results.push(await item.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
  return db;
}

async function sessionCookie(db, subjectType, subjectId, principalKey) {
  const { upsertIdentityBinding } = await import("../../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: subjectType === "provider" ? "partner_otp" : "customer_otp",
    principalType: "identity_subject", principalKey, subjectType, subjectId,
    verificationState: "verified", actorId: "grooming-golden-journey",
    reason: "authenticated executable grooming journey",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: String(binding.identity_source),
    principalType: String(binding.principal_type), principalKey: String(binding.principal_key),
    subjectType, subjectId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

export async function setupJourney() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=MEMORY;");
  const db = makeD1(sqlite);
  globalThis.__GROOM_GOLDEN_DB__ = db;
  // PAWSPACE_SCHEDULING_ENV declared, as every UAT harness must now: /api/uat-scheduling no longer
  // fabricates provider roster unless the runtime says it is a UAT runtime (PTJA W1-F27). This harness
  // books through the real reserve path with no Ops-published availability, so it says so.
   // PAWSPACE_MEDIA_ENV is declared because media release is now environment-aware: an absent value
  // reads as PRODUCTION, the strict default, where unscanned media stays quarantined. These are the UAT
  // journeys. [PTJA-W3-SC]
 globalThis.__GROOM_GOLDEN_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_SCHEDULING_ENV: "uat", PAWSPACE_MEDIA_ENV: "uat" };

  const { seedDefaultZones } = await import("../../lib/service-zones.ts");
  const { seedProviderCapacityDefaults } = await import("../../lib/provider-capacity-governance.ts");
  const { seedDefaultGroomingPolicy } = await import("../../lib/grooming-policy-governance.ts");
  const { ensureSecurityTables } = await import("../../lib/server-auth.ts");
  await ensureSecurityTables(db);
  await seedDefaultZones(db);
  await seedProviderCapacityDefaults(db);
  await seedDefaultGroomingPolicy(db);
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-GROOM-CLOSURE','closure-admin@pawspace.test','Grooming closure operator','founder','active',?,?)").bind(now,now),
    db.prepare("INSERT OR REPLACE INTO service_zone_mappings (pincode,zone_id,city_id,city,area,created_at) VALUES ('600001','chennai-core','maa','Chennai','George Town',?)").bind(now),
    db.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('groom_maa','maa','Meena R.','full_time','[\"grooming\"]','[\"chennai-core\"]',1,4.9,96,1,30,4,3,'active',1,'2026-08-01',NULL,'journey_seed',?)").bind(now),
    db.prepare("INSERT INTO grooming_commercial_policies (id,policy_code,city_id,zone_id,enforcement_mode,cancellation_cutoff_minutes,refund_percent_before_cutoff,refund_percent_after_cutoff,reschedule_cutoff_minutes,reschedule_allowed_after_cutoff,max_reschedules,reschedule_fee_type,reschedule_fee_value,no_show_refund_percent,multi_pet_max,multi_pet_pricing_mode,change_lock_statuses_json,active,version,effective_from,effective_to,updated_by,updated_at) VALUES ('gpolicy_maa','grooming-default','maa',NULL,'enforce',0,100,100,0,1,2,'none',0,0,4,'catalogue','[\"completed\",\"cancelled\"]',1,1,'2026-08-01',NULL,'journey_seed',?)").bind(now),
  ]);
  return { sqlite, db, close: () => sqlite.close() };
}

async function routeCall(modulePath, method, path, body, cookie = "", origin = "https://uat.pawspace.in") {
  const route = await import(modulePath);
  const request = new Request(`${origin}${path}`, {
    method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : { "oai-authenticated-user-email": "closure-admin@pawspace.test", "oai-authenticated-user-full-name": "Grooming%20closure%20operator", "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8" }) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const response = await route[method](request);
  return { status: response.status, body: await response.json() };
}

export async function runCompletedJourney(ctx, config) {
  const { db, sqlite } = ctx;
  const customerCookie = await sessionCookie(db, "customer", config.customerId, `customer:${config.customerId}`);
  const { resolveZoneByPincode } = await import("../../lib/service-zones.ts");
  const coverage = await resolveZoneByPincode(db, config.pincode);
  if (!coverage) throw new Error(`No service coverage for ${config.pincode}`);

  const start = new Date(config.start), end = new Date(start.getTime() + 2 * 60 * 60_000);
  const schedulePayload = {
    clientRequestId: config.groupId, customerId: config.customerId, petIds: [config.petSourceId],
    serviceCode: "grooming", cityId: config.cityId, zoneId: config.zoneId,
    scheduledStart: start.toISOString(), scheduledEnd: end.toISOString(),
    preferredProviderId: config.preferredProviderId,
  };
  const scheduled = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", schedulePayload, customerCookie);
  const scheduleReplay = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", schedulePayload, customerCookie);
  const provider = scheduled.body.data?.provider;
  if (!provider) throw new Error(`Scheduling failed: ${scheduled.status} ${JSON.stringify(scheduled.body)}`);

  let coupon = null;
  if (config.couponCode) {
    const { quoteCoupon } = await import("../../lib/coupon-governance.ts");
    coupon = await quoteCoupon(db, { code: config.couponCode, customerId: config.customerId, serviceCode: "grooming", cityId: config.cityId, channel: "customer_app", packageCode: "dog-basic", orderValue: 1899, paymentMode: "full", isSubscription: false });
  }
  const total = coupon?.valid ? coupon.finalAmount : 1899;
  const bookingPayload = {
    idempotencyKey: config.groupId, scheduleGroupId: config.groupId,
    customer: { id: config.customerId, name: config.customerName, primaryPhone: config.phone },
    pets: [{ sourceId: config.petSourceId, name: config.petName, species: "dog", breed: "Indie", vaccinationStatus: "vaccinated" }],
    cityId: config.cityId, zoneId: config.zoneId, serviceCode: "grooming", packageCode: "dog-basic", packageName: "client-tampered-name",
    scheduledStart: start.toISOString(), scheduledEnd: end.toISOString(), provider,
    totalAmount: total, amountDueNow: total,
    payment: { method: "upi", mode: "prepaid", status: "created", detail: "sandbox golden journey" },
    pricing: { discount: coupon?.discount || 0, ...(coupon?.quoteId ? { couponCode: config.couponCode, couponQuoteId: coupon.quoteId } : {}) },
  };
  const booked = await routeCall("../../app/api/canonical-bookings/route.ts", "POST", "/api/canonical-bookings", bookingPayload, customerCookie);
  const bookingReplay = await routeCall("../../app/api/canonical-bookings/route.ts", "POST", "/api/canonical-bookings", bookingPayload, customerCookie);
  const bookingId = booked.body.data?.bookingId;
  const location = await routeCall("../../app/api/grooming-service-location/route.ts", "POST", "/api/grooming-service-location", { bookingId, customerId: config.customerId, address: `${config.customerName} service address`, pincode: config.pincode, latitude: config.latitude, longitude: config.longitude }, customerCookie);

  const linked = await routeCall("../../app/api/grooming-payment-sandbox/route.ts", "POST", "/api/grooming-payment-sandbox", { action: "link_order", bookingId, gatewayOrderId: `order_${config.groupId}` });
  const capture = { action: "simulate_event", bookingId, eventType: "payment.captured", eventId: `evt_${config.groupId}`, gatewayPaymentId: `pay_${config.groupId}`, amount: total, currency: "INR" };
  const captured = await routeCall("../../app/api/grooming-payment-sandbox/route.ts", "POST", "/api/grooming-payment-sandbox", capture);
  const captureReplay = await routeCall("../../app/api/grooming-payment-sandbox/route.ts", "POST", "/api/grooming-payment-sandbox", capture);

  if (config.stopAfterCapture) return {
    coverage, scheduled, scheduleReplay, booked, bookingReplay, location, linked, captured, captureReplay,
    bookingId, provider, total, customerCookie, bookingPayload,
  };

  const providerCookie = await sessionCookie(db, "provider", provider.id, `provider:${provider.id}`);
  const jobs = await routeCall("../../app/api/partner-grooming-jobs/route.ts", "GET", `/api/partner-grooming-jobs?providerId=${provider.id}`, null, providerCookie);
  const lifecycle = async (action, extra = {}) => routeCall("../../app/api/grooming-lifecycle/route.ts", "POST", "/api/grooming-lifecycle", { bookingId, action, ...extra }, providerCookie);
  const transitions = [];
  for (const action of ["accept", "on_the_way", "arrived", "start_service"]) transitions.push(await lifecycle(action));
  const invalidEarlyComplete = await lifecycle("complete");

  const media = [];
  for (const purpose of ["before_service", "after_service"]) {
    // The signed-upload boundary [PTJA-W2-B4-M04]: the provider requests a short-lived token bound to
    // one object key, uploads, and the confirmation presents that token together with what the stored
    // object actually is. Review is a separate identity - the provider cookie prepares, staff decides.
    const sha256 = purpose === "before_service" ? "a".repeat(64) : "b".repeat(64);
    const prepared = await routeCall("../../app/api/service-media/route.ts", "POST", "/api/service-media", { bookingId, purpose, mimeType: "image/jpeg", sizeBytes: 128, sha256, fileName: `${purpose}.jpg` }, providerCookie);
    const { id, upload } = prepared.body.data;
    await routeCall("../../app/api/service-media/route.ts", "PATCH", "/api/service-media", { id, action: "confirm_upload", uploadToken: upload.token, storageReference: upload.objectKey, observedSizeBytes: 128, observedSha256: sha256, observedMimeType: "image/jpeg" });
    await routeCall("../../app/api/service-media/route.ts", "PATCH", "/api/service-media", { id, action: "record_scan", scanResult: "clean", reason: `Reviewed the ${purpose.replace("_", " ")} photo` });
    media.push(prepared.body.data.ref);
  }
  const proof = await lifecycle("add_proof", { beforePhotoRef: media[0], afterPhotoRef: media[1], checklist: ["coat", "nails", "ears"], completionNotes: "Completed safely" });
  const completed = await lifecycle("complete");
  const visible = await routeCall("../../app/api/canonical-bookings/route.ts", "GET", "/api/canonical-bookings", null);

  return { coverage, scheduled, scheduleReplay, booked, bookingReplay, location, linked, captured, captureReplay, jobs, transitions, invalidEarlyComplete, proof, completed, visible, bookingId, provider, total,
    persisted: {
      booking: sqlite.prepare("SELECT * FROM canonical_bookings WHERE id=?").get(bookingId),
      pet: sqlite.prepare("SELECT * FROM canonical_pets WHERE customer_id=?").get(config.customerId),
      reservation: sqlite.prepare("SELECT * FROM scheduling_reservations WHERE group_id=? AND status!='cancelled'").get(config.groupId),
      work: sqlite.prepare("SELECT * FROM provider_work_orders WHERE booking_id=?").get(bookingId),
      payment: sqlite.prepare("SELECT * FROM booking_payments WHERE booking_id=?").get(bookingId),
      location: sqlite.prepare("SELECT * FROM booking_service_locations WHERE booking_id=?").get(bookingId),
      address: sqlite.prepare("SELECT * FROM customer_addresses WHERE customer_id=? AND is_default=1").get(config.customerId),
      counts: {
        bookings: sqlite.prepare("SELECT COUNT(*) c FROM canonical_bookings WHERE idempotency_key=?").get(config.groupId).c,
        payments: sqlite.prepare("SELECT COUNT(*) c FROM booking_payments WHERE booking_id=?").get(bookingId).c,
        events: sqlite.prepare("SELECT COUNT(*) c FROM payment_gateway_events WHERE provider='razorpay' AND event_id=?").get(`evt_${config.groupId}`).c,
      },
    },
  };
}

export { routeCall, sessionCookie };
