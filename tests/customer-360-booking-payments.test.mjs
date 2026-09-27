/*
 * Round-2 staging (P2): Customer 360 (/team/sales) showed how MANY bookings a customer had, but not which
 * service, when, or whether it was paid. The selected customer's read now carries each booking's payment
 * state from the canonical payment snapshot, and the page lists the bookings. Executed against the real
 * route, the real booking / stay-split / food schemas, and the real list component.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors, asActor } from "./helpers/execution-harness.mjs";

installWorkersHooks("__C360_PAY_DB__", "__C360_PAY_ENV__");
const route = await import("../app/api/customer-360/route.ts");
const { ensureCustomerAccountTables } = await import("../lib/customer-account.ts");
const { ensureCanonicalBookingCoreTables } = await import("../lib/canonical-booking-core-schema.ts");
const { ensureStayPaymentTables, staySplitScheduleStatement } = await import("../lib/stay-split-payments.ts");
const { ensureFoodGovernanceTables } = await import("../lib/food-governance.ts");

const ASSOCIATE = "c360.associate@pawspace.test";
const NOW = Date.now();

async function seeded() {
  const w = world("__C360_PAY_DB__", "__C360_PAY_ENV__");
  await seedActors(w.sqlite, w.db, [{ id: "U-C360-ASSOC", email: ASSOCIATE, role: "associate" }]);
  await ensureCustomerAccountTables(w.db);
  await ensureCanonicalBookingCoreTables(w.db);
  await ensureStayPaymentTables(w.db);
  await ensureFoodGovernanceTables(w.db);
  w.sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,email,created_at,updated_at) VALUES ('CUS-PAY','blr','Payment Check','+919812345678','pay.check@example.test',?,?)").run(NOW, NOW);
  const booking = w.sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,'CUS-PAY','[]','[]','blr','blr-east',?,'pkg',?,?,'P1',?,?,?,'customer_app',?,'INR','{}','test',?,?)");
  const payment = w.sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,'CUS-PAY',?,?,'INR','upi',?,?,'razorpay_sandbox',?,'{}',?,?)");
  const add = (id, service, pkg, start, status, total) => booking.run(id, `k-${id}`, service, pkg, `g-${id}`, start, start, status, total, NOW, NOW);
  add("B-PAID", "grooming", "Full groom", "2026-07-01T10:00:00.000Z", "completed", 1200);
  payment.run("PAY-PAID", "B-PAID", 1200, 1200, "full", "captured", "pk-paid", NOW, NOW);
  add("B-SPLIT", "boarding", "Deluxe stay", "2026-08-01T10:00:00.000Z", "confirmed", 4000);
  payment.run("PAY-SPLIT", "B-SPLIT", 4000, 2000, "split_50_50", "captured", "pk-split", NOW, NOW);
  add("B-FIRST", "pet_sitting", "Home visit", "2026-09-20T04:30:00.000Z", "pending_payment", 5000);
  payment.run("PAY-FIRST", "B-FIRST", 5000, 2500, "split_50_50", "created", "pk-first", NOW, NOW);
  add("B-DUE", "dog_training", "Puppy basics", "2026-09-10T04:30:00.000Z", "confirmed", 1500);
  payment.run("PAY-DUE", "B-DUE", 1500, 1500, "full", "created", "pk-due", NOW, NOW);
  add("B-REFUND", "grooming", "Bath", "2026-06-01T10:00:00.000Z", "cancelled", 900);
  payment.run("PAY-REFUND", "B-REFUND", 900, 900, "full", "refunded", "pk-refund", NOW, NOW);
  add("B-NONE", "pet_taxi", "Vet run", "2026-05-01T10:00:00.000Z", "draft", 700);
  // Split stays keep what is still owed in their schedule, written the way booking creation writes it.
  await staySplitScheduleStatement(w.db, { bookingId: "B-SPLIT", serviceCode: "boarding", customerId: "CUS-PAY", totalAmount: 4000, paidNowAmount: 2000, balanceAmount: 2000, balanceDueAt: NOW }).run();
  await staySplitScheduleStatement(w.db, { bookingId: "B-FIRST", serviceCode: "pet_sitting", customerId: "CUS-PAY", totalAmount: 5000, paidNowAmount: 2500, balanceAmount: 2500, balanceDueAt: NOW }).run();
  // A food order joins the same timeline; its payment lives in food_order_payments.
  w.sqlite.prepare("INSERT INTO food_orders (id,idempotency_key,customer_id,city_id,zone_id,status,total_amount,created_by,created_at,updated_at) VALUES ('FO-PAID','fk-paid','CUS-PAY','blr','blr-east','delivered',799,'test',?,?)").run(Date.parse("2026-07-20T10:00:00.000Z"), NOW);
  w.sqlite.prepare("INSERT INTO food_order_payments (id,order_id,customer_id,amount,amount_due_now,currency,mode,status,gateway,detail_json,created_at,updated_at) VALUES ('FOP-PAID','FO-PAID','CUS-PAY',799,0,'INR','sandbox_deferred','paid','uat_sandbox','{}',?,?)").run(NOW, NOW);
  return w;
}
const read = async (path) => { const response = await route.GET(asActor(ASSOCIATE, path)); return { status: response.status, body: await response.json() }; };

test("the selected customer's Customer 360 read gives every booking its payment state", async () => {
  await seeded();
  const { status, body } = await read("/api/customer-360?customerId=CUS-PAY");
  assert.equal(status, 200, JSON.stringify(body));
  const [record] = body.data.records;
  const labels = Object.fromEntries(record.bookings.map((booking) => [booking.id, booking.payment?.label]));
  assert.deepEqual(labels, {
    "B-PAID": "Paid",
    "B-SPLIT": "Part paid · ₹2,000 balance due",
    "B-FIRST": "Awaiting payment · ₹2,500 due now, ₹2,500 later",
    "B-DUE": "Awaiting payment · ₹1,500 due",
    "B-REFUND": "Refunded",
    "B-NONE": "No payment recorded",
    "FO-PAID": "Paid",
  });
  const split = record.bookings.find((booking) => booking.id === "B-SPLIT");
  assert.equal(split.payment.stage, "outstanding_balance", "the stage is the one checkout would charge");
  assert.equal(split.payment.outstandingBalance, 2000);
  assert.equal(split.serviceCode, "boarding");
  assert.equal(split.status, "confirmed");
  assert.ok(!JSON.stringify(body).includes("9812345678"), "the associate still gets the masked phone");
});

test("the customer list read stays payment-free, so its fan-out budget is unchanged", async () => {
  await seeded();
  const { status, body } = await read("/api/customer-360");
  assert.equal(status, 200, JSON.stringify(body));
  const record = body.data.records.find((entry) => entry.customerId === "CUS-PAY");
  assert.equal(record.bookings.length, 7);
  assert.ok(record.bookings.every((booking) => !("payment" in booking)));
});

test("/team/sales lists each booking with service, IST date, status and payment state", async () => {
  await seeded();
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { default: CustomerBookings, CustomerBookingList, loadCustomerBookings } = await import("../app/team/sales/customer-bookings.tsx");
  // The component's own loader, answered by the real route as the signed-in associate.
  const requested = [];
  const bookings = await loadCustomerBookings("CUS-PAY", async (url) => { requested.push(String(url)); return route.GET(asActor(ASSOCIATE, String(url))); });
  assert.deepEqual(requested, ["/api/customer-360?customerId=CUS-PAY"]);
  const html = renderToStaticMarkup(createElement(CustomerBookingList, { bookings, payments: "ready" }));
  const text = html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
  // 10:00 UTC is 3:30 pm in India.
  assert.match(text, /Boarding · Deluxe stay 1 Aug 2026, 3:30\spm IST · Confirmed ₹4,000 Part paid · ₹2,000 balance due/);
  assert.match(text, /Dog Training · Puppy basics 10 Sept? 2026, 10:00\sam IST · Confirmed ₹1,500 Awaiting payment · ₹1,500 due/);
  assert.match(text, /Pet Taxi · Vet run 1 May 2026, 3:30\spm IST · Draft ₹700 No payment recorded/);
  assert.match(text, /Pet food .*20 Jul 2026, 3:30\spm IST · Delivered ₹799 Paid/);
  assert.match(html, /data-owed="true"[^>]*>Awaiting payment · ₹1,500 due/, "money still owed stands out");

  // Before the payment read answers, the rows show the bookings from the list read and claim no payment state.
  const listBookings = bookings.map((booking) => { const copy = { ...booking }; delete copy.payment; return copy; });
  const first = renderToStaticMarkup(createElement(CustomerBookings, { customerId: "CUS-PAY", bookings: listBookings }));
  assert.match(first, /Checking payment…/);
  assert.match(first, /Deluxe stay/);
  assert.ok(!first.includes("Part paid"), "no payment claim before the payment read answers");

  const page = readFileSync(new URL("../app/team/sales/page.tsx", import.meta.url), "utf8");
  assert.match(page, /<h3>Bookings<\/h3><CustomerBookings key=\{current\.customerId\} customerId=\{current\.customerId\} bookings=\{current\.bookings\}\/>/, "the selected customer's detail lists the bookings");
});
