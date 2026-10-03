import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as card from "../app/booking-command-center/reschedule-card.ts";

const { rescheduleRequestCard } = card;
// Synthetic rows using the status strings lib/grooming-reschedule-payment.ts writes. They are inputs to a
// presentation helper only; no status here is treated as proof that a payment was or was not captured.
const request = (status, extra = {}) => ({ id: `RS-${status}`, status, difference_amount: 250, to_start: "2026-10-10T10:00:00+05:30", ...extra });
const UNPAID_SHAPED = ["quoted", "awaiting_payment", "expired", "cancelled"];
const CAPTURE_SHAPED = ["paid", "applying", "applied", "refund_requested", "refunded"];
const AMBIGUOUS = ["move_failed"];

test("the card is a count of requests, so every request counts whatever its status", () => {
  const unpaid = UNPAID_SHAPED.map(status => request(status));
  assert.deepEqual(rescheduleRequestCard(unpaid), { label: "Reschedule requests", count: 4, emptyCopy: "No reschedule request" });
  const mixed = [...unpaid, ...CAPTURE_SHAPED.map(status => request(status)), ...AMBIGUOUS.map(status => request(status))];
  assert.equal(rescheduleRequestCard(mixed).count, mixed.length);
  assert.equal(rescheduleRequestCard(CAPTURE_SHAPED.map(status => request(status))).count, CAPTURE_SHAPED.length);
  assert.equal(rescheduleRequestCard([request("unknown_future_status")]).count, 1);
});

test("the label never calls the number a payment count, and the empty copy never claims a paid reschedule", () => {
  for (const requests of [[], [request("quoted")], [request("expired"), request("cancelled")], [request("paid")]]) {
    const result = rescheduleRequestCard(requests);
    assert.equal(result.label, "Reschedule requests");
    assert.doesNotMatch(result.label, /payment/i);
    assert.equal(result.emptyCopy, "No reschedule request");
    assert.doesNotMatch(result.emptyCopy, /paid/i);
  }
});

test("a booking without the optional request list shows zero, not an error", () => {
  for (const requests of [undefined, null, []]) assert.equal(rescheduleRequestCard(requests).count, 0);
});

test("the helper stays presentation-only: no status classification or payment metadata is exported", () => {
  assert.deepEqual(Object.keys(card).sort(), ["rescheduleRequestCard"]);
  assert.deepEqual(Object.keys(rescheduleRequestCard([request("paid"), request("expired")])).sort(), ["count", "emptyCopy", "label"]);
  const source = readFileSync(new URL("../app/booking-command-center/reschedule-card.ts", import.meta.url), "utf8");
  for (const status of [...UNPAID_SHAPED, ...CAPTURE_SHAPED, ...AMBIGUOUS]) assert.doesNotMatch(source, new RegExp(`["'\`]${status}["'\`]`), `${status} must not be classified in the helper`);
});

test("page.tsx renders the card from the helper and keeps the latest request's own status wording", () => {
  const page = readFileSync(new URL("../app/booking-command-center/page.tsx", import.meta.url), "utf8");
  assert.match(page, /import \{ rescheduleRequestCard \} from "\.\/reschedule-card";/);
  assert.doesNotMatch(page, /Reschedule payments/, "the count is of requests, not payments");
  assert.doesNotMatch(page, /No paid reschedule/, "an empty list is no request, not no paid request");
  const cardMarkup = page.match(/<article><span>\{card\.label\}<\/span><b>\{card\.count\}<\/b><p>\{[^]*?\}<\/p><\/article>/);
  assert.ok(cardMarkup, "the Payments-tab card shows the helper's label and count");
  assert.match(cardMarkup[0], /rescheduleStatus\(selected\.rescheduleRequests\[0\]\.status\)/, "latest request status wording kept");
  assert.match(cardMarkup[0], /money\(selected\.rescheduleRequests\[0\]\.difference_amount\)/, "latest request amount kept");
  assert.match(cardMarkup[0], /when\(selected\.rescheduleRequests\[0\]\.to_start\)/, "latest request time kept");
  assert.match(cardMarkup[0], /: card\.emptyCopy\}/, "empty copy comes from the helper");
  assert.match(page, /\(card => .*\)\(rescheduleRequestCard\(selected\.rescheduleRequests\)\)/, "the helper is applied inside the rendered markup only");
  for (const words of ['quoted: "Price shown, not paid"', 'expired: "Hold lapsed, not paid"', 'cancelled: "Booking cancelled"', 'applied: "Paid and moved"']) assert.ok(page.includes(words), `status wording retained: ${words}`);
});
