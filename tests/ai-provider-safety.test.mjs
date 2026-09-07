import test from "node:test";
import assert from "node:assert/strict";
import { installAiHooks, stubFetch, jsonResponse, UAT_AI_ENV } from "./helpers/ai-harness.mjs";

installAiHooks();
const safety = await import("../lib/ai-provider-safety.ts");
const adapter = await import("../lib/ai-provider-adapter.ts");

const answer = text => ({ id: "msg", type: "message", stop_reason: "end_turn", content: [{ type: "text", text }] });

test("external AI sanitizer redacts direct identifiers in plain text", () => {
  const result = safety.sanitizeAiProviderText("Email jane@example.com, phone +91 9876543210, PAN ABCDE1234F, UPI jane@okaxis");
  assert.equal(result.redacted, true);
  assert.ok(!result.text.includes("jane@example.com"));
  assert.ok(!result.text.includes("9876543210"));
  assert.ok(!result.text.includes("ABCDE1234F"));
  assert.ok(!result.text.includes("jane@okaxis"));
  assert.match(result.text, /\[REDACTED\]/);
});

test("structured AI payload removes sensitive fields while preserving non-sensitive service context", () => {
  const result = safety.sanitizeAiProviderText(JSON.stringify({
    customerName: "Jane Doe",
    email: "jane@example.com",
    customerMessage: "I need grooming tomorrow",
    canonicalContext: { area: "Indiranagar", service: "grooming", price: 1149 },
    pet: { petName: "Buddy", vaccinationStatus: "current", breed: "Labrador" },
  }));
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.customerName, safety.EXTERNAL_AI_REDACTION);
  assert.equal(parsed.email, safety.EXTERNAL_AI_REDACTION);
  assert.equal(parsed.canonicalContext.area, safety.EXTERNAL_AI_REDACTION);
  assert.equal(parsed.canonicalContext.service, "grooming");
  assert.equal(parsed.canonicalContext.price, 1149);
  assert.equal(parsed.pet.petName, safety.EXTERNAL_AI_REDACTION);
  assert.equal(parsed.pet.vaccinationStatus, safety.EXTERNAL_AI_REDACTION);
  assert.equal(parsed.pet.breed, "Labrador");
});

test("requestAiDraft sanitizes every outbound prompt at the provider boundary", async () => {
  globalThis.__PAWSPACE_TEST_ENV__ = { ...UAT_AI_ENV };
  const stub = stubFetch(() => jsonResponse(answer("ok")));
  try {
    const result = await adapter.requestAiDraft({
      systemPrompt: "Customer email jane@example.com",
      userPrompt: JSON.stringify({ customerName: "Jane Doe", phone: "+919876543210", customerMessage: "Book grooming" }),
      channel: "chat",
      intent: "booking_create",
    });
    assert.equal(result.connected, true);
    const body = JSON.parse(stub.calls[0].init.body);
    assert.ok(!body.system.includes("jane@example.com"));
    assert.ok(!body.messages[0].content.includes("Jane Doe"));
    assert.ok(!body.messages[0].content.includes("9876543210"));
    assert.match(body.system, /\[REDACTED\]/);
    assert.match(body.messages[0].content, /\[REDACTED\]/);
  } finally { stub.restore(); }
});

test("provider adapter exposes governance_blocked as a terminal failure class", () => {
  assert.equal(adapter.isRetryableAiFailure("governance_blocked"), false);
});
