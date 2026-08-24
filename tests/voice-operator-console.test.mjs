/**
 * Executed evidence for the operator console's dial decision.
 *
 * A staff console for automated calling is a way to cause exactly the harm the governance layer
 * exists to prevent, so the two properties that matter are checked as behaviour rather than read out
 * of JSX:
 *
 *   the console never offers a dial the environment forbids, and
 *   a policy decision for one recipient never authorises a dial to another.
 *
 * The second is the subtle one. A console that previews a number, then lets the operator edit the
 * number and press dial, has placed a call nothing approved. Every mutation of the form is checked
 * here, including whitespace-only edits (which are NOT a different recipient) and each individual
 * field (which are).
 *
 * The console is a convenience and never an authority: the source contract at the end pins that the
 * page routes its decision through this module, and tests/voice-route-authorization.test.mjs proves
 * the route refuses independently.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__CONSOLE_DB__");
const console_ = await import("../lib/voice-operator-console.ts");

const OPEN_GATE = { enabled: true, blockedReason: null, salesOutboundApproved: false };
const USE_CASES = [
  { code: "booking_confirmation", label: "Confirm a booking", requiresBooking: true, requiresSalesApproval: false, availableNow: true },
  { code: "feedback_request", label: "Ask for feedback", requiresBooking: true, requiresSalesApproval: false, availableNow: true },
  { code: "sales_pitch", label: "Outbound sales", requiresBooking: false, requiresSalesApproval: true, availableNow: false },
];
const READY_FORM = { useCase: "booking_confirmation", phone: "9876543210", cityId: "blr", customerId: "CUS-1", leadId: "", bookingId: "BKG-1" };
const allowed = (form, key = "idem-1") => ({ for: form, result: { allowed: true, blockedBy: null }, idempotencyKey: key });
const decide = (over = {}) => console_.operatorDialDecision({ gate: OPEN_GATE, useCases: USE_CASES, form: READY_FORM, preview: null, ...over });

// ---------------------------------------------------------------------------
// The environment is the authority
// ---------------------------------------------------------------------------
test("a closed environment gate offers neither a policy check nor a dial, and says why", () => {
  const decision = decide({ gate: { enabled: false, blockedReason: "PAWSPACE_VOICE_UAT_APPROVED is not set", salesOutboundApproved: false }, preview: allowed(READY_FORM) });
  assert.equal(decision.canPreview, false);
  assert.equal(decision.canDial, false);
  assert.equal(decision.idempotencyKey, null);
  assert.ok(decision.reasons.includes("PAWSPACE_VOICE_UAT_APPROVED is not set"), decision.reasons.join(" | "));
});

test("an allowed preview cannot clear a closed gate", () => {
  // The preview is a client-held object. If it could override the gate, a modified client would be
  // able to enable calling - which is the one thing this console must never be able to do.
  const decision = decide({ gate: { enabled: false, blockedReason: "Voice is disabled", salesOutboundApproved: false }, preview: allowed(READY_FORM) });
  assert.equal(decision.canDial, false);
});

test("state that has not loaded yet is not treated as permission", () => {
  const decision = decide({ gate: null, preview: allowed(READY_FORM) });
  assert.equal(decision.canPreview, false);
  assert.equal(decision.canDial, false);
});

// ---------------------------------------------------------------------------
// Use-case rules
// ---------------------------------------------------------------------------
test("a use case needing outbound sales approval is never offered while that approval is absent", () => {
  const form = { ...READY_FORM, useCase: "sales_pitch", bookingId: "" };
  const decision = decide({ form, preview: allowed(form) });
  assert.equal(decision.canPreview, false);
  assert.equal(decision.canDial, false);
  assert.match(decision.reasons.join(" "), /needs outbound sales approval/);
});

test("an unregistered use case is refused rather than sent to the server to find out", () => {
  const form = { ...READY_FORM, useCase: "definitely_not_a_use_case" };
  assert.match(decide({ form }).reasons.join(" "), /not registered/);
  assert.equal(decide({ form }).canPreview, false);
});

test("a use case that refers to a booking is not offered without one", () => {
  const form = { ...READY_FORM, bookingId: "" };
  const decision = decide({ form, preview: allowed(form) });
  assert.equal(decision.canPreview, false);
  assert.match(decision.reasons.join(" "), /requires the booking it refers to/);
});

test("a recipient must be named, and either a customer or a lead satisfies it", () => {
  assert.equal(decide({ form: { ...READY_FORM, customerId: "", leadId: "" } }).canPreview, false);
  assert.equal(decide({ form: { ...READY_FORM, customerId: "", leadId: "LEAD-9" } }).canPreview, true);
  assert.equal(decide({ form: { ...READY_FORM, phone: "  " } }).canPreview, false);
});

// ---------------------------------------------------------------------------
// A preview authorises exactly one request
// ---------------------------------------------------------------------------
test("with no preview the policy check is offered and the dial is not", () => {
  const decision = decide();
  assert.equal(decision.canPreview, true, "the dry run creates nothing, so it is always offered once the form is complete");
  assert.equal(decision.canDial, false);
  assert.match(decision.reasons.join(" "), /Run a policy check/);
});

test("a blocked preview does not enable a dial", () => {
  const decision = decide({ preview: { for: READY_FORM, result: { allowed: false, blockedBy: "consent_missing" }, idempotencyKey: "idem-blocked" } });
  assert.equal(decision.canDial, false);
  assert.match(decision.reasons.join(" "), /Policy blocked this call: consent_missing/);
});

test("an allowed preview for this exact request enables the dial and supplies its idempotency key", () => {
  const decision = decide({ preview: allowed(READY_FORM, "idem-exact") });
  assert.equal(decision.canDial, true);
  assert.deepEqual(decision.reasons, []);
  assert.equal(decision.idempotencyKey, "idem-exact", "one composed request dials at most once, whatever the operator clicks");
});

test("changing ANY field of the request invalidates the previewed decision", () => {
  const edits = {
    useCase: "feedback_request",
    phone: "9000000001",
    cityId: "hyd",
    customerId: "CUS-2",
    leadId: "LEAD-2",
    bookingId: "BKG-2",
  };
  for (const [field, value] of Object.entries(edits)) {
    const preview = allowed(READY_FORM);
    const decision = console_.operatorDialDecision({ gate: OPEN_GATE, useCases: USE_CASES, form: { ...READY_FORM, [field]: value }, preview });
    assert.equal(decision.canDial, false, `editing ${field} to ${value} left the dial enabled - a preview for one request would authorise another`);
    assert.equal(decision.idempotencyKey, null);
  }
});

test("editing the number after an allowed preview is the case that must never dial", () => {
  const preview = allowed(READY_FORM, "idem-original");
  const swapped = { ...READY_FORM, phone: "9111111111" };
  const decision = console_.operatorDialDecision({ gate: OPEN_GATE, useCases: USE_CASES, form: swapped, preview });
  assert.equal(decision.canDial, false);
  assert.match(decision.reasons.join(" "), /The request changed since the last policy check/);
});

test("whitespace is not a different recipient", () => {
  const preview = allowed(READY_FORM);
  const padded = { ...READY_FORM, phone: "  9876543210  ", customerId: " CUS-1 " };
  assert.equal(console_.previewMatchesForm(preview, padded), true);
  assert.equal(console_.operatorDialDecision({ gate: OPEN_GATE, useCases: USE_CASES, form: padded, preview }).canDial, true);
});

test("previewMatchesForm is false for an absent preview rather than throwing", () => {
  assert.equal(console_.previewMatchesForm(null, READY_FORM), false);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
test("a recipient number is only ever rendered as its last four digits", () => {
  assert.equal(console_.maskedNumber("3210"), "••••3210");
  assert.equal(console_.maskedNumber("9876543210"), "••••3210", "a full number handed in is still masked to four");
  assert.equal(console_.maskedNumber(""), "••••••••");
  assert.equal(console_.maskedNumber(null), "••••••••");
});

// ---------------------------------------------------------------------------
// The page is wired to this decision, and holds no second copy of it
// ---------------------------------------------------------------------------
test("the console page routes its dial through this module and sends no field the gate consults", () => {
  const page = fs.readFileSync(new URL("../app/team/voice/page.tsx", import.meta.url), "utf8");
  assert.match(page, /operatorDialDecision/, "the page must use the tested decision, not re-derive it in markup");
  assert.match(page, /disabled=\{!decision\.canDial/, "the dial button is gated by the decision");
  assert.match(page, /decision\.idempotencyKey/, "the dial must send the key the decision minted");

  // The environment decides whether calling is possible. If the page could send any of these, a
  // modified client would be able to switch voice on from the browser.
  for (const name of ["PAWSPACE_VOICE_ENV", "PAWSPACE_VOICE_UAT_APPROVED", "PAWSPACE_VOICE_LIVE_APPROVED", "PAWSPACE_VOICE_ALLOW", "EXOTEL_"]) {
    assert.ok(!page.includes(`${name}:`), `the page appears to send ${name} - no client field may reach the environment gate`);
  }
  assert.doesNotMatch(page, /action:\s*"set_script"/, "script approval is a settings.manage action and does not belong on the dial console");
  // The full recipient number lives only in the form. Nothing renders it back out of a server payload.
  assert.doesNotMatch(page, /row\.phone\b/, "the ledger exposes phoneLast4 only");
});
