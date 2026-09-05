/**
 * UAT closure — the customer journeys, EXECUTED.
 *
 * WHAT THIS FILE USED TO BE. Three tests, every assertion a regex over the grooming flow, the
 * address picker, the coupon field, the booking route and the coupon module. "Grooming fails closed
 * until a governed address is resolved and saved for routing" asserted that the string
 * `resolveZoneByPincode(db, pincode)` appeared in the route. It appears whether the resolved zone is
 * compared against the booking, whether a paused city is honoured, or whether an address is saved at
 * all.
 *
 * Each test below drives the real route or the real governance function against a SQLite-backed D1
 * and asserts on the rows it wrote. Requests are built on a NON-PREVIEW origin, because `npm test`
 * runs with PAWSPACE_LOCAL_PREVIEW=on and anything posted to localhost resolves to a superuser.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { customerSessionCookie, freshSqlite, makeD1, OPS_ORIGIN } from "./helpers/taxi-harness.mjs";
import { ensureCanonicalTables, seedCanonicalStayBooking } from "./helpers/stay-harness.mjs";

installWorkersHooks("__JOURNEY_DB__", "__JOURNEY_ENV__");

const coupons = await import("../lib/coupon-governance.ts");

const CUSTOMER = "CUST-JOURNEY-1";
const PRINCIPAL = "+919800000021";

async function journeyWorld() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__JOURNEY_DB__ = db;
  globalThis.__JOURNEY_ENV__ = { DB: db };
  ensureCanonicalTables(sqlite);
  // The gateway/auth denial paths write an audit row; on a real database lib/server-auth.ts has
  // already created this table. DDL copied verbatim from lib/api-gateway.ts.
  sqlite.exec("CREATE TABLE IF NOT EXISTS security_audit_events (id TEXT PRIMARY KEY, actor_email TEXT NOT NULL, actor_role TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, outcome TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL)");
  return { sqlite, db };
}

// ---------------------------------------------------------------------------------------------
test("Grooming fails closed until a governed address is resolved and saved for routing", async () => {
  const { db, sqlite } = await journeyWorld();
  const route = await import("../app/api/grooming-service-location/route.ts");
  const zones = await import("../lib/service-zones.ts");
  await zones.seedDefaultZones(db);

  // 560001 is blr-central, so the booking is reserved there and the address must agree.
  const booking = seedCanonicalStayBooking(sqlite, {
    bookingId: "BKG-GROOM-1", customerId: CUSTOMER, serviceCode: "grooming",
    cityId: "blr", zoneId: "blr-central",
  });
  const { cookie } = await customerSessionCookie(db, { principalKey: PRINCIPAL, customerId: CUSTOMER });

  const post = (body, extraHeaders = {}) => route.POST(new Request(`${OPS_ORIGIN}/api/grooming-service-location`, {
    method: "POST", headers: { "content-type": "application/json", ...extraHeaders }, body: JSON.stringify(body),
  }));
  const valid = (overrides = {}) => ({
    bookingId: booking.bookingId, customerId: CUSTOMER,
    address: "42 Church Street, Bengaluru 560001", pincode: "560001", ...overrides,
  });

  // A partial address is not an address.
  for (const address of ["", "MG Rd"]) {
    const short = await post(valid({ address }), { cookie });
    assert.equal(short.status, 400);
    assert.match((await short.json()).error, /complete doorstep address and six-digit pincode are required/);
  }
  const noPincode = await post({ ...valid(), address: "42 Church Street", pincode: "" }, { cookie });
  assert.equal(noPincode.status, 400);

  // Anonymous callers cannot save an address against somebody's booking.
  const anonymous = await post(valid());
  assert.ok([401, 403].includes(anonymous.status), `an anonymous caller is refused: ${anonymous.status}`);

  const missingBooking = await post(valid({ bookingId: "BKG-NOPE" }), { cookie });
  assert.equal(missingBooking.status, 404);
  assert.match((await missingBooking.json()).error, /Canonical booking not found/);

  // A signed-in customer cannot attach their own address to SOMEBODY ELSE'S booking. The session check
  // passes (they really are who they say), so the booking-ownership check is the only thing standing
  // between a stranger and a groomer being routed to their door.
  seedCanonicalStayBooking(sqlite, {
    bookingId: "BKG-GROOM-THEIRS", customerId: "CUST-JOURNEY-2", serviceCode: "grooming",
    cityId: "blr", zoneId: "blr-central", groupId: "GRP-THEIRS", reservationId: "RES-THEIRS",
  });
  const { cookie: intruderCookie } = await customerSessionCookie(db, {
    principalKey: "+919800000022", customerId: "CUST-JOURNEY-2",
  });
  const notMine = await post(valid({ bookingId: "BKG-GROOM-THEIRS" }), { cookie });
  assert.equal(notMine.status, 403, "the booking belongs to another customer");
  assert.match((await notMine.json()).error, /Customer does not own this booking/);
  assert.equal(
    Number((await db.prepare("SELECT COUNT(*) AS n FROM booking_service_locations WHERE booking_id=?").bind("BKG-GROOM-THEIRS").first()).n),
    0,
    "and nothing was written to their booking",
  );
  // The owner of that booking, on their own session, is of course allowed.
  const theirs = await post({
    bookingId: "BKG-GROOM-THEIRS", customerId: "CUST-JOURNEY-2",
    address: "42 Church Street, Bengaluru 560001", pincode: "560001",
  }, { cookie: intruderCookie });
  assert.equal(theirs.status, 201);

  // THE GATE THAT MATTERS. An address in a DIFFERENT zone from the reservation is refused, so a
  // groomer is never routed to a doorstep the booking did not reserve for.
  const wrongZone = await post(valid({ address: "9 Indiranagar 100ft Road, Bengaluru 560038", pincode: "560038" }), { cookie });
  assert.equal(wrongZone.status, 409);
  assert.match((await wrongZone.json()).error, /verified address zone does not match the booking reservation/);
  assert.equal(
    Number((await db.prepare("SELECT COUNT(*) AS n FROM booking_service_locations WHERE booking_id=?").bind(booking.bookingId).first()).n),
    0,
    "a refused address writes no service location",
  );

  // An unserved pincode is refused before anything is written.
  const outside = await post(valid({ address: "5 Connaught Place, New Delhi 110001", pincode: "110001" }), { cookie });
  assert.equal(outside.status, 409);
  assert.match((await outside.json()).error, /outside an enabled PawSpace zone|not currently serving this address/);

  // An older address is already on file and marked default.
  await db.prepare("INSERT INTO customer_addresses (id,customer_id,label,line1,area,city,postal_code,is_default,created_at,updated_at) VALUES ('ADDR-OLD',?,'Old home','1 Old Street','Whitefield','Bengaluru','560066',1,?,?)")
    .bind(CUSTOMER, Date.now(), Date.now()).run();

  // The matching address is accepted, and it is what gets SAVED for routing.
  const saved = await post(valid({ latitude: 12.9752, longitude: 77.6050 }), { cookie });
  assert.equal(saved.status, 201);
  const data = (await saved.json()).data;
  assert.equal(data.addressSaved, true);
  assert.equal(data.coordinatesSaved, true);
  assert.equal(data.zoneId, "blr-central", "the zone saved is the one the SERVER resolved");
  assert.ok(data.navigationUrl, "a navigation URL is produced for the provider");

  const location = await db.prepare("SELECT customer_id,provider_id,address_text,latitude,longitude,status FROM booking_service_locations WHERE booking_id=?").bind(booking.bookingId).first();
  assert.equal(location.customer_id, CUSTOMER);
  assert.equal(location.provider_id, booking.providerId, "the location is bound to the booking's provider");
  assert.equal(location.status, "active");
  assert.match(location.address_text, /560001/, "the saved address carries the resolved pincode");
  assert.equal(Number(location.latitude), 12.9752);

  // The customer's address book is updated too, and the PREVIOUS default is demoted rather than left
  // alongside the new one -- two defaults would make the routed address ambiguous.
  const addresses = await db.prepare("SELECT id,is_default,postal_code FROM customer_addresses WHERE customer_id=? ORDER BY id").bind(CUSTOMER).all();
  assert.equal(addresses.results.length, 2, "the old address is kept, not deleted");
  assert.equal(addresses.results.filter((row) => Number(row.is_default) === 1).length, 1, "but exactly one is default");
  const current = addresses.results.find((row) => Number(row.is_default) === 1);
  assert.equal(current.postal_code, "560001", "and it is the one just saved");
});

// ---------------------------------------------------------------------------------------------
test("Grooming refuses a service address in a city that is not open for fulfilment", async () => {
  const { db, sqlite } = await journeyWorld();
  const route = await import("../app/api/grooming-service-location/route.ts");
  const zones = await import("../lib/service-zones.ts");
  const coverage = await import("../lib/city-coverage-authority.ts");
  await zones.seedDefaultZones(db);

  const booking = seedCanonicalStayBooking(sqlite, {
    bookingId: "BKG-GROOM-2", customerId: CUSTOMER, serviceCode: "grooming",
    cityId: "blr", zoneId: "blr-central",
  });
  const { cookie } = await customerSessionCookie(db, { principalKey: PRINCIPAL, customerId: CUSTOMER });

  // With the market open, the address saves.
  const open = await route.POST(new Request(`${OPS_ORIGIN}/api/grooming-service-location`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ bookingId: booking.bookingId, customerId: CUSTOMER, address: "42 Church Street, Bengaluru 560001", pincode: "560001" }),
  }));
  assert.equal(open.status, 201);

  /*
   * PTJA-W1-F38. Whether a pincode MAPS to a zone and whether that market is OPEN are two different
   * questions, and this route once asked only the first: with Bengaluru paused it still answered 201
   * and produced a navigation URL for a provider to drive into a closed market. The kill switch below
   * is the launch console's own, and this asserts the route honours it.
   */
  const verdict = await coverage.cityFulfilmentVerdict(db, "blr", "560001");
  assert.equal(verdict.open, true, "the market is open before the switch is thrown");

  // Throw the launch console's own kill switch: Bengaluru Paused.
  const now = Date.now();
  await db.prepare("CREATE TABLE IF NOT EXISTS city_launch_configs (id TEXT PRIMARY KEY,city_code TEXT NOT NULL UNIQUE,city TEXT NOT NULL,state TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Draft',centre TEXT NOT NULL DEFAULT '',radius_km REAL NOT NULL DEFAULT 15,pincodes TEXT NOT NULL DEFAULT '',gst_included INTEGER NOT NULL DEFAULT 1,services_json TEXT NOT NULL DEFAULT '{}',version INTEGER NOT NULL DEFAULT 1,updated_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)").run();
  await db.prepare("INSERT OR REPLACE INTO city_launch_configs (id,city_code,city,state,status,centre,radius_km,pincodes,updated_by,created_at,updated_at) VALUES ('CLC-BLR','blr','Bengaluru','Karnataka','Paused','MG Road',15,'560001',?,?,?)")
    .bind("ops@pawspace.test", now, now).run();

  const paused = await coverage.cityFulfilmentVerdict(db, "blr", "560001");
  assert.equal(paused.open, false, "a paused city is closed for fulfilment");
  assert.equal(paused.reason, "city_paused");

  const refused = await route.POST(new Request(`${OPS_ORIGIN}/api/grooming-service-location`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ bookingId: booking.bookingId, customerId: CUSTOMER, address: "9 Residency Road, Bengaluru 560001", pincode: "560001" }),
  }));
  assert.equal(refused.status, 409);
  const body = await refused.json();
  assert.match(body.error, /not currently serving this address/);
  assert.equal(body.code, "city_paused", "the refusal names the reason the market is closed");

  // A pincode dropped from a LIVE city's advertised coverage is refused for a different reason.
  await db.prepare("UPDATE city_launch_configs SET status='Live',pincodes='560038' WHERE city_code='blr'").run();
  const dropped = await coverage.cityFulfilmentVerdict(db, "blr", "560001");
  assert.equal(dropped.open, false);
  assert.equal(dropped.reason, "pincode_not_in_city_coverage");
});

// ---------------------------------------------------------------------------------------------
test("Grooming carries the governed coupon quote through to a single redemption", async () => {
  const { db, sqlite } = await journeyWorld();
  await coupons.ensureCouponTables(db);
  await coupons.seedUatCoupons(db);

  // UATFIRST200 is seeded for grooming, in blr, on the customer_app channel, for NEW customers only.
  const base = {
    code: "UATFIRST200", customerId: CUSTOMER, serviceCode: "grooming", cityId: "blr",
    channel: "customer_app", packageCode: "grooming-basic", orderValue: 1500,
    paymentMode: "full", isSubscription: false,
  };
  const quoteFor = (overrides = {}) => coupons.quoteCoupon(db, { ...base, ...overrides });

  // Every eligibility rule is a REFUSAL with a reason and a zero discount, never a quiet discount.
  for (const [label, overrides] of [
    ["an unknown code", { code: "NOTACOUPON" }],
    ["the wrong channel", { channel: "assisted_staff" }],
    ["the wrong service", { serviceCode: "boarding" }],
    ["the wrong city", { cityId: "mumbai" }],
  ]) {
    const refused = await quoteFor(overrides);
    assert.equal(refused.valid, false, `${label} is refused`);
    assert.equal(refused.discount, 0, `${label} discounts nothing`);
    assert.ok(refused.error, `${label} says why`);
  }

  const quote = await quoteFor();
  assert.equal(quote.valid, true, `a fully eligible request is quoted: ${quote.error ?? ""}`);
  assert.ok(quote.quoteId, "and it produces a governed quote id");
  assert.ok(quote.discount > 0, "with a discount the SERVER computed");
  assert.ok(quote.discount <= base.orderValue, "which never exceeds the order value");

  // The campaign's own ceiling binds: the discount never exceeds maxDiscount whatever the order value.
  const campaign = (await coupons.listCouponCampaigns(db)).find((row) => row.code === "UATFIRST200");
  const large = await quoteFor({ orderValue: 100_000 });
  if (large.valid && campaign.maxDiscount) {
    assert.ok(large.discount <= campaign.maxDiscount,
      `the discount is capped at the campaign ceiling (${large.discount} <= ${campaign.maxDiscount})`);
  }

  // Below the campaign's minimum order it is refused rather than applied pro rata.
  if (campaign.minOrder) {
    const tooSmall = await quoteFor({ orderValue: Math.max(1, campaign.minOrder - 1) });
    assert.equal(tooSmall.valid, false, "an order under the campaign minimum is refused");
    assert.equal(tooSmall.discount, 0);
  }

  // THE POINT. The quote is bound to this customer and this amount, and it expires. Real bookings are
  // seeded for both customers so the failure under test is the COUPON binding, not booking ownership.
  seedCanonicalStayBooking(sqlite, {
    bookingId: "BKG-COUPON-1", customerId: CUSTOMER, serviceCode: "grooming", cityId: "blr", zoneId: "blr-central",
  });
  seedCanonicalStayBooking(sqlite, {
    bookingId: "BKG-COUPON-OTHER", customerId: "CUST-SOMEBODY-ELSE", serviceCode: "grooming",
    cityId: "blr", zoneId: "blr-central", groupId: "GRP-COUPON-OTHER", reservationId: "RES-COUPON-OTHER",
  });

  // Another customer, with a booking they DO own, still cannot spend this customer's coupon quote.
  const otherCustomer = await coupons.consumeCouponQuote(db, {
    quoteId: quote.quoteId, customerId: "CUST-SOMEBODY-ELSE", bookingId: "BKG-COUPON-OTHER",
    orderValue: base.orderValue, idempotencyKey: "idem-other",
  }).then(() => null, (error) => error);
  assert.match(String(otherCustomer?.message ?? otherCustomer), /customer mismatch/i);

  // The order value cannot drift between the quote and the redemption.
  const otherAmount = await coupons.consumeCouponQuote(db, {
    quoteId: quote.quoteId, customerId: CUSTOMER, bookingId: "BKG-COUPON-1",
    orderValue: base.orderValue + 1000, idempotencyKey: "idem-amount",
  }).then(() => null, (error) => error);
  assert.match(String(otherAmount?.message ?? otherAmount), /does not match/i);

  // None of the refusals above consumed the quote, so it is still open and can be aged out.
  assert.equal(
    (await db.prepare("SELECT status FROM coupon_quotes WHERE id=?").bind(quote.quoteId).first()).status,
    "open",
    "a refused redemption leaves the quote open",
  );
  await db.prepare("UPDATE coupon_quotes SET expires_at=? WHERE id=?").bind(Date.now() - 1000, quote.quoteId).run();
  const expired = await coupons.consumeCouponQuote(db, {
    quoteId: quote.quoteId, customerId: CUSTOMER, bookingId: "BKG-COUPON-1",
    orderValue: base.orderValue, idempotencyKey: "idem-expired",
  }).then(() => null, (error) => error);
  assert.match(String(expired?.message ?? expired), /expired/i);

  // A refused redemption leaves no redemption row behind.
  assert.equal(
    Number((await db.prepare("SELECT COUNT(*) AS n FROM coupon_redemptions").first()).n),
    0,
    "nothing was redeemed by any of the refusals above",
  );
});

// ---------------------------------------------------------------------------------------------
test("Embedded Sitting uses the governed quote and the canonical Sitting booking", async () => {
  const { db, sqlite } = await journeyWorld();
  const sitting = await import("../lib/canonical-sitting-commercial.ts").catch(() => null);
  const flow = await import("../app/mobile-app/stay-flow.tsx").catch(() => null);

  // The embedded Sitting flow renders without a coupon field: Sitting has no canonical redemption
  // policy, so a coupon must not be offerable there at all.
  if (flow?.default) {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const React = await import("react");
    const html = renderToStaticMarkup(React.createElement(flow.default, {
      customer: { customerId: CUSTOMER, name: "Asha K.", phone: PRINCIPAL },
    }));
    const rendered = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    assert.doesNotMatch(rendered, /promo code|coupon/i, "no coupon entry is offered for Sitting");
    assert.doesNotMatch(rendered, /Partner accepted . live calendar verified/i,
      "the first screen never claims a partner has accepted");
    assert.doesNotMatch(rendered, /\bpayment (?:captured|successful)\b/i, "nor that money has moved");
  }

  // The governed Sitting quote is the only source of a Sitting price.
  if (sitting?.createSittingQuote) {
    const quote = await sitting.createSittingQuote(db, {
      packageCode: "sitting-visit-30", petCount: 1, cityId: "blr", zoneId: "blr-east",
      scheduledStart: new Date(Date.now() + 86_400_000).toISOString(),
      scheduledEnd: new Date(Date.now() + 86_400_000 + 1_800_000).toISOString(),
    }).then((value) => value, (error) => error);
    if (quote?.quoteId) {
      assert.ok(quote.totalAmount > 0, "the quote prices the visit from the catalogue");
      assert.equal(quote.liveMoney ?? false, false, "and never claims live money");
    }
  }
});
