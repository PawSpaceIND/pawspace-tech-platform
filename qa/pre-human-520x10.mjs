import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { schedule } from "../backend/dist/scheduling.js";
import {
  capturePayment,
  createPayment,
  createPayout,
  createProviderEarning,
  issueInvoice,
  requestRefund,
} from "../backend/dist/finance.js";

const CUSTOMER_COUNT = 520;
const PROVIDER_COUNT = 10;
const BOOKING_AMOUNT = 1349;
const REFUND_AMOUNT = 100;
const CITY = "blr";
const ZONE = "blr-east";

const providers = Array.from({ length: PROVIDER_COUNT }, (_, index) => ({
  id: `QA-PROV-${String(index + 1).padStart(2, "0")}`,
  cityId: CITY,
  name: `QA Provider ${index + 1}`,
  model: index < 5 ? "full_time" : "commission",
  services: ["grooming"],
  zones: [ZONE],
  live: true,
  rating: 4.8,
  qualityScore: 90,
  capacity: 1,
  travelBufferMinutes: 30,
  maxDailyJobs: 6,
}));

const pets = new Map();
const bookings = [];
const payments = [];
const invoices = [];
const refunds = [];
const earnings = [];
const payouts = [];
const journeyMs = [];

const repository = {
  async listEligibleProviders(cityId, zoneId, serviceCode) {
    return providers.filter(p => p.cityId === cityId && p.zones.includes(zoneId) && p.services.includes(serviceCode) && p.live);
  },
  async listBookings(cityId, providerId) {
    return bookings.filter(b => b.cityId === cityId && (!providerId || b.providerId === providerId));
  },
  async listAvailability(providerId, date) {
    return [{ id: `avail-${providerId}-${date}`, providerId, cityId: CITY, zoneId: ZONE, date, windows: ["09:00-21:00"], source: "qa_roster", updatedAt: new Date().toISOString() }];
  },
  async getPet(id) { return pets.get(id) ?? null; },
  async findPaymentByIdempotencyKey(key) { return payments.find(p => p.idempotencyKey === key) ?? null; },
  async createPayment(payment) { payments.push(payment); return payment; },
  async updatePayment(id, patch) { const item = payments.find(p => p.id === id); if (!item) throw new Error(`missing payment ${id}`); Object.assign(item, patch); return item; },
  async getInvoiceByBooking(bookingId) { return invoices.find(i => i.bookingId === bookingId) ?? null; },
  async createInvoice(invoice) { invoices.push(invoice); return invoice; },
  async listRefunds(paymentId) { return refunds.filter(r => r.paymentId === paymentId); },
  async createRefund(refund) { refunds.push(refund); return refund; },
  async createEarning(earning) { earnings.push(earning); return earning; },
  async listEarnings(providerId) { return earnings.filter(e => e.providerId === providerId); },
  async updateEarning(id, patch) { const item = earnings.find(e => e.id === id); if (!item) throw new Error(`missing earning ${id}`); Object.assign(item, patch); return item; },
  async findPayoutByIdempotencyKey(key) { return payouts.find(p => p.idempotencyKey === key) ?? null; },
  async createPayout(payout) { payouts.push(payout); return payout; },
  async close() {},
};

function isoFor(dayIndex, slotIndex) {
  // 09:00, 12:00, 15:00 and 18:00 IST. Four non-overlapping two-hour Grooming slots per provider/day.
  const utcHours = [3, 6, 9, 12];
  return new Date(Date.UTC(2026, 9, 1 + dayIndex, utcHours[slotIndex], 30, 0, 0)).toISOString();
}

for (let index = 0; index < CUSTOMER_COUNT; index += 1) {
  const started = performance.now();
  const dayIndex = Math.floor(index / 40); // 13 days * 40 customers = 520.
  const withinDay = index % 40;
  const providerIndex = withinDay % PROVIDER_COUNT;
  const slotIndex = Math.floor(withinDay / PROVIDER_COUNT);
  const customerId = `QA-CUST-${String(index + 1).padStart(4, "0")}`;
  const petId = `QA-PET-${String(index + 1).padStart(4, "0")}`;
  const expectedProvider = providers[providerIndex];
  const start = isoFor(dayIndex, slotIndex);
  const end = new Date(new Date(start).getTime() + 120 * 60 * 1000).toISOString();
  pets.set(petId, {
    id: petId, customerId, legacyIds: [], name: `QA Pet ${index + 1}`,
    species: "dog", breed: "QA", allergies: [], vaccinationStatus: "verified",
    createdAt: start, updatedAt: start,
  });

  const decision = await schedule(repository, {
    cityId: CITY, zoneId: ZONE, serviceCode: "grooming", petIds: [petId],
    scheduledStart: start, scheduledEnd: end, preferredProviderId: expectedProvider.id,
  });
  assert.equal(decision.provider?.id, expectedProvider.id, `customer ${customerId} did not receive preferred eligible provider`);
  assert.equal(decision.occurrences.length, 1);
  assert.ok(decision.evaluations.filter(item => item.eligible).length >= 1);

  const booking = {
    id: `QA-BK-${String(index + 1).padStart(4, "0")}`,
    legacyIds: [], idempotencyKey: `qa-booking-${index + 1}`, cityId: CITY, zoneId: ZONE,
    customerId, petIds: [petId], serviceCode: "grooming", packageCode: "qa-grooming",
    addonCodes: [], scheduledStart: start, scheduledEnd: end, status: "confirmed",
    channel: "qa_certification", totalAmount: BOOKING_AMOUNT, providerId: decision.provider.id,
    assignmentMode: decision.mode, scheduleGroupId: `QA-GRP-${index + 1}`, occurrenceNumber: 1,
    capacityUnits: 1, createdBy: customerId, createdAt: start, updatedAt: start,
  };
  bookings.push(booking);

  const created = await createPayment(repository, {
    booking, customerId, method: "upi", mode: "prepaid",
    idempotencyKey: `qa-payment-${index + 1}`, gatewayOrderId: `qa-order-${index + 1}`,
  });
  assert.equal(created.duplicatePrevented, false);
  const replay = await createPayment(repository, {
    booking, customerId, method: "upi", mode: "prepaid",
    idempotencyKey: `qa-payment-${index + 1}`, gatewayOrderId: `qa-order-${index + 1}`,
  });
  assert.equal(replay.duplicatePrevented, true, `payment replay was not idempotent for ${customerId}`);
  const captured = await capturePayment(repository, created.payment, `qa-gateway-payment-${index + 1}`);
  assert.equal(captured.status, "captured");

  const invoice = await issueInvoice(repository, captured, index % 5 === 0 ? "Outside Karnataka" : "Karnataka", index % 5 === 0);
  const invoiceReplay = await issueInvoice(repository, captured, index % 5 === 0 ? "Outside Karnataka" : "Karnataka", index % 5 === 0);
  assert.equal(invoiceReplay.id, invoice.id, `invoice replay forked for ${customerId}`);
  assert.equal(invoice.grossAmount, BOOKING_AMOUNT);
  assert.equal(Number((invoice.taxableAmount + invoice.cgst + invoice.sgst + invoice.igst).toFixed(2)), BOOKING_AMOUNT);

  if (index % 10 === 0) {
    const refund = await requestRefund(repository, captured, { id: `QA-FIN-MAKER-${index % 2}`, role: "finance" }, REFUND_AMOUNT, "QA partial refund path");
    assert.equal(refund.status, "requested");
  }

  const completedAt = new Date(new Date(end).getTime() + 15 * 60 * 1000).toISOString();
  const earning = await createProviderEarning(repository, booking, {
    baseEarning: 400,
    incentive: index % 20 === 0 ? 50 : 0,
    deductions: index % 30 === 0 ? 10 : 0,
    completedAt,
  });
  assert.equal(earning.providerId, expectedProvider.id);
  journeyMs.push(performance.now() - started);
}

// At the busiest instant, all ten providers are occupied. A conflicting 521st request must not be assigned.
const first = bookings[0];
const collision = await schedule(repository, {
  cityId: CITY, zoneId: ZONE, serviceCode: "grooming", petIds: [first.petIds[0]],
  scheduledStart: first.scheduledStart, scheduledEnd: first.scheduledEnd,
  preferredProviderId: first.providerId,
});
assert.equal(collision.provider, null, "fully occupied ten-provider slot accepted an 11th simultaneous booking");
assert.equal(collision.mode, "manual_review");

// A pending refund reserves balance immediately; a second request cannot exceed remaining captured funds.
const refundedPayment = payments.find(p => refunds.some(r => r.paymentId === p.id));
assert.ok(refundedPayment);
await assert.rejects(
  () => requestRefund(repository, refundedPayment, { id: "QA-FIN-MAKER-OVER", role: "finance" }, BOOKING_AMOUNT - REFUND_AMOUNT + 0.01, "QA refund ceiling probe"),
  /Refund exceeds refundable balance/,
);

const payoutAsOf = "2026-12-01T00:00:00.000Z";
for (const provider of providers) {
  const key = `qa-payout-${provider.id}`;
  const firstPayout = await createPayout(repository, { providerId: provider.id, cityId: CITY, idempotencyKey: key, asOf: payoutAsOf });
  assert.equal(firstPayout.duplicatePrevented, false);
  const replayPayout = await createPayout(repository, { providerId: provider.id, cityId: CITY, idempotencyKey: key, asOf: payoutAsOf });
  assert.equal(replayPayout.duplicatePrevented, true, `payout replay forked for ${provider.id}`);
}

const providerDistribution = Object.fromEntries(providers.map(provider => [provider.id, bookings.filter(b => b.providerId === provider.id).length]));
const invoiceNumbers = invoices.map(invoice => invoice.invoiceNumber);
const invoiceNumberDuplicates = invoiceNumbers.length - new Set(invoiceNumbers).size;
const paymentIds = new Set(payments.map(payment => payment.id));
const gross = Number(invoices.reduce((sum, invoice) => sum + invoice.grossAmount, 0).toFixed(2));
const tax = Number(invoices.reduce((sum, invoice) => sum + invoice.cgst + invoice.sgst + invoice.igst, 0).toFixed(2));
const refunded = Number(refunds.reduce((sum, refund) => sum + refund.amount, 0).toFixed(2));
const earningTotal = Number(earnings.reduce((sum, earning) => sum + earning.netPayable, 0).toFixed(2));
const payoutTotal = Number(payouts.reduce((sum, payout) => sum + payout.amount, 0).toFixed(2));
const sortedLatency = [...journeyMs].sort((a, b) => a - b);
const p95 = sortedLatency[Math.ceil(sortedLatency.length * 0.95) - 1] ?? 0;

const summary = {
  baselinePurpose: "isolated pre-human certification; no production or staging writes",
  customers: CUSTOMER_COUNT,
  providers: PROVIDER_COUNT,
  bookings: bookings.length,
  providerDistribution,
  payments: payments.length,
  uniquePaymentIds: paymentIds.size,
  invoices: invoices.length,
  uniqueInvoiceNumbers: new Set(invoiceNumbers).size,
  invoiceNumberDuplicates,
  refunds: refunds.length,
  earnings: earnings.length,
  payouts: payouts.length,
  gross,
  tax,
  refunded,
  earningTotal,
  payoutTotal,
  journeyP95Ms: Number(p95.toFixed(3)),
  collisionBlocked: collision.provider === null,
};
await writeFile("qa/pre-human-520x10-summary.json", JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

assert.equal(bookings.length, 520);
assert.equal(payments.length, 520);
assert.equal(paymentIds.size, 520);
assert.equal(invoices.length, 520);
assert.equal(refunds.length, 52);
assert.equal(earnings.length, 520);
assert.equal(payouts.length, 10);
assert.deepEqual(Object.values(providerDistribution), Array(10).fill(52));
assert.equal(gross, 701480);
assert.equal(refunded, 5200);
assert.equal(payoutTotal, earningTotal, "provider payout queue does not reconcile to eligible earnings");
assert.equal(invoiceNumberDuplicates, 0, `invoice numbering collided ${invoiceNumberDuplicates} time(s) under the 520-customer run`);
