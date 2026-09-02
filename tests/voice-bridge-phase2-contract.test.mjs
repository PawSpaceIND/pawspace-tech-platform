import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const governance = await readFile(new URL("../lib/voice-bridge-governance.ts", import.meta.url), "utf8");
const bridgeRoute = await readFile(new URL("../app/api/communications/voice/bridge/route.ts", import.meta.url), "utf8");
const webhookRoute = await readFile(new URL("../app/api/webhooks/exotel/call-event/route.ts", import.meta.url), "utf8");
const gateway = await readFile(new URL("../lib/api-gateway.ts", import.meta.url), "utf8");

test("masked voice is restricted to explicit active service states", () => {
  assert.match(governance, /ACTIVE_VOICE_SERVICE_STATES\s*=\s*\["assigned",\s*"en_route",\s*"in_progress"\]/);
  assert.match(governance, /provider_work_orders/);
  assert.match(governance, /Masked calling is available only during an active service window/);
});

test("bridge sessions store governed identifiers, not raw phone numbers", () => {
  assert.match(governance, /CREATE TABLE IF NOT EXISTS voice_call_sessions/);
  assert.match(governance, /customer_phone_hash/);
  assert.match(governance, /provider_phone_hash/);
  assert.match(governance, /customer_phone_last4/);
  assert.match(governance, /provider_phone_last4/);
  assert.doesNotMatch(governance, /voice_call_sessions[^\n]+customer_phone TEXT/);
  assert.doesNotMatch(governance, /voice_call_sessions[^\n]+provider_phone TEXT/);
});

test("state machine exposes initiated, bridged, completed and failed only", () => {
  assert.match(governance, /"initiated" \| "bridged" \| "completed" \| "failed"/);
  assert.match(governance, /status='bridged'/);
  assert.match(governance, /status='completed'/);
  assert.match(governance, /status='failed'/);
  assert.match(governance, /ux_voice_call_sessions_active_booking/);
});

test("Exotel request is a two-leg connect with callback subscriptions", () => {
  for (const field of ["From", "To", "CallerId", "StatusCallback", "CustomField"]) assert.match(governance, new RegExp(`${field}:`));
  assert.match(governance, /Calls\/connect\.json/);
  assert.match(governance, /StatusCallbackEvents\[0\].*terminal/);
  assert.match(governance, /StatusCallbackEvents\[1\].*answered/);
  assert.match(governance, /StatusCallbackEvents\[2\].*ringing/);
});

test("only customer/provider ownership can initiate and no notification is fabricated", () => {
  assert.match(governance, /actor\.roleCode === "customer"/);
  assert.match(governance, /actor\.roleCode === "service_provider"/);
  assert.match(governance, /requireCustomerOwnership/);
  assert.match(governance, /requireProviderOwnership/);
  assert.doesNotMatch(governance + bridgeRoute, /booking_customer_notifications|Booking Confirmed|Grooming notification/i);
});

test("webhook reuses the existing signature verifier and is replay-safe", () => {
  assert.match(governance, /verifyVoiceWebhookSignature/);
  assert.match(governance, /provider_event_id TEXT NOT NULL UNIQUE/);
  assert.match(governance, /payloadHash\.slice\(0, 16\)/);
  assert.match(webhookRoute, /recordVoiceBridgeEvent/);
  assert.match(webhookRoute, /readBoundedRequestText/);
});

test("gateway delegates bridge auth to route ownership and webhook auth to signature", () => {
  assert.match(gateway, /url\.pathname==="\/api\/communications\/voice\/bridge"\)return null/);
  assert.match(gateway, /url\.pathname==="\/api\/webhooks\/exotel\/call-event"/);
  assert.match(bridgeRoute, /resolveActor/);
  assert.match(bridgeRoute, /sameOriginWrite/);
});
