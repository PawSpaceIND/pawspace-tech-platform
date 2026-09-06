import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const lib = await read("../lib/haptik-integration-governance.ts");
const route = await read("../app/api/haptik/route.ts");

test("Haptik integration: the 4 voice-agent APIs, capture-and-request only", () => {
  assert.match(lib, /export async function captureHaptikLead/);
  assert.match(lib, /export async function captureHaptikCallback/);
  assert.match(lib, /export async function fetchHaptikTimeSlots/);
  assert.match(lib, /export async function requestHaptikBooking/);
  assert.match(lib, /INSERT INTO crm_contacts/);
  assert.match(lib, /INSERT INTO lead_work_items/);
  assert.match(lib, /import \{ scheduleLeadCallback \} from "\.\/lead-callback-governance"/);
  assert.match(lib, /await scheduleLeadCallback\(db, \{ leadId/);
  assert.doesNotMatch(lib, /INSERT INTO lead_callbacks \(id,lead_id,requested_at/);
  assert.match(lib, /idempotency_key TEXT NOT NULL UNIQUE/);
  assert.match(lib, /if \(prior\) return \{ duplicatePrevented: true/);
  assert.match(lib, /status: "booking_requested"/);
  assert.match(lib, /no money moved/i);
  assert.doesNotMatch(lib, /booking_payments|status='captured'|createPaymentOrder/);
});

test("Haptik webhook is fail-closed and verifies HMAC-SHA1 over the exact raw body", () => {
  assert.match(route, /HAPTIK_WEBHOOK_SECRET\|\|env\.HAPTIK_API_KEY/);
  assert.match(route, /request\.text\(\)/, "the exact raw body must be captured before parsing");
  assert.match(route, /hash:"SHA-1"/);
  assert.match(route, /crypto\.subtle\.sign\("HMAC"/);
  assert.match(route, /x-haptik-signature/);
  assert.match(route, /constantTimeEqual/);
  assert.doesNotMatch(route, /x-haptik-key/);
  assert.doesNotMatch(route, /replace\(\/\^Bearer/);
  for (const a of ["capture_lead", "capture_callback", "fetch_slots", "request_booking"]) assert.match(route, new RegExp(`action==="${a}"`));
});
