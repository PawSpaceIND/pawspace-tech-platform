import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const lib = await read("../lib/haptik-integration-governance.ts");
const route = await read("../app/api/haptik/route.ts");

test("Haptik integration: the 4 voice-agent APIs, capture-and-request only", () => {
  assert.match(lib, /export async function captureHaptikLead/);   // Capture Details
  assert.match(lib, /export async function captureHaptikCallback/); // Capture Callback Request
  assert.match(lib, /export async function fetchHaptikTimeSlots/);  // Fetch Time Slots
  assert.match(lib, /export async function requestHaptikBooking/);  // Book Appointment
  // leads land in the REAL crm + governed lead pipeline
  assert.match(lib, /INSERT INTO crm_contacts/);
  assert.match(lib, /INSERT INTO lead_work_items/);
  assert.match(lib, /INSERT INTO lead_callbacks/);
  // every write is idempotent (Haptik retries on the same call/session id)
  assert.match(lib, /idempotency_key TEXT NOT NULL UNIQUE/);
  assert.match(lib, /if \(prior\) return \{ duplicatePrevented: true/);
  // "booking" is a GOVERNED request, never an auto-paid booking - no money, no auto-assignment
  assert.match(lib, /status: "booking_requested"/);
  assert.match(lib, /no money moved/i);
  assert.doesNotMatch(lib, /booking_payments|status='captured'|createPaymentOrder/);
});

test("Haptik webhook is fail-closed on HAPTIK_API_KEY and authenticated", () => {
  assert.match(route, /HAPTIK_API_KEY/);
  assert.match(route, /if\(!key\)throw new Response\(JSON\.stringify\(\{error:"Haptik integration is not connected/);
  assert.match(route, /if\(provided!==key\)throw new Response\(JSON\.stringify\(\{error:"Invalid Haptik credentials"\}\),\{status:401\}\)/);
  // routes each action
  for (const a of ["capture_lead", "capture_callback", "fetch_slots", "request_booking"]) assert.match(route, new RegExp(`action==="${a}"`));
});
