/*
 * Day-31 wave 15: the last-mile privacy guard on every external LLM request.
 *
 * lib/ai-provider-safety.ts had no test importing it. sanitizeAiProviderText() is the final thing
 * between PawSpace data and a third-party model provider: structured JSON is scrubbed by field
 * name, then every remaining string is pattern-redacted, so a caller cannot bypass it by sending
 * plain text instead of JSON.
 *
 * Its failure is one-way and permanent. Data that leaves is gone - it is in someone else's request
 * logs and, depending on the provider and the plan, possibly in training data. There is no
 * rollback, so the redaction has to hold against the way people ACTUALLY write things, not the
 * canonical form.
 *
 * The other direction matters too: over-redaction destroys the context the assistant needs, and a
 * booking reference or a price scrubbed as if it were an identifier makes the AI useless.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { sanitizeAiProviderText, EXTERNAL_AI_REDACTION } = await import("../lib/ai-provider-safety.ts");

const leaks = (text) => sanitizeAiProviderText(text).text;

test("an identifier is redacted however a human actually wrote it", async () => {
  /*
   * THE CASE THAT MATTERS. An Aadhaar number is written "1234 5678 9012" in 4-4-4 groups
   * essentially everywhere in India, and a card as "4111 1111 1111 1111". The unbroken form is
   * the LESS common way a person types either, so a digits-only pattern misses the real traffic.
   */
  for (const [label, text, secret] of [
    ["aadhaar in 4-4-4 groups", "my aadhaar is 1234 5678 9012", "1234 5678 9012"],
    ["aadhaar hyphenated", "aadhaar 1234-5678-9012", "1234-5678-9012"],
    ["aadhaar unbroken", "aadhaar 123456789012", "123456789012"],
    ["card in 4-4-4-4 groups", "card 4111 1111 1111 1111", "4111 1111 1111 1111"],
    ["card hyphenated", "card 4111-1111-1111-1111", "4111-1111-1111-1111"],
    ["card unbroken", "card 4111111111111111", "4111111111111111"],
    ["15-digit amex", "amex 3782 822463 10005", "3782 822463 10005"],
  ]) {
    const output = leaks(text);
    assert.ok(!output.includes(secret), `${label} must not reach the provider: ${output}`);
    assert.match(output, /\[REDACTED\]/, `${label} must be replaced, not merely altered`);
  }
});

test("an email, a phone, a PAN, a UPI handle and a credential are all redacted", async () => {
  for (const [label, text, secret] of [
    ["email", "write to rhea.nair@example.com", "rhea.nair@example.com"],
    ["bare Indian mobile", "call 9876543210", "9876543210"],
    ["mobile with country code", "call +91 98765 43210", "98765 43210"],
    ["spaced mobile", "call 98765 43210", "98765 43210"],
    ["PAN", "PAN ABCDE1234F", "ABCDE1234F"],
    ["UPI handle", "pay rhea@okhdfcbank", "rhea@okhdfcbank"],
    ["bearer token", "Authorization: Bearer abc123XYZ_token-value", "abc123XYZ_token-value"],
    ["razorpay key", "key rzp_test_ABC123def456", "rzp_test_ABC123def456"],
  ]) {
    const output = leaks(text);
    assert.ok(!output.includes(secret), `${label} must not reach the provider: ${output}`);
  }
});

test("the categories redacted are reported, so a caller can see what was carried", async () => {
  const result = sanitizeAiProviderText("rhea@example.com on 9876543210 with aadhaar 1234 5678 9012");
  assert.equal(result.redacted, true);
  assert.ok(result.categories.includes("email"));
  assert.ok(result.categories.includes("phone"));
  assert.ok(result.categories.includes("government_id"));
});

test("ordinary customer text survives intact - over-redaction is its own failure", async () => {
  /*
   * The opposite direction. If a booking reference, a price or a date is scrubbed, the assistant
   * loses the context it needs to answer and the customer gets a worse reply than no AI at all.
   */
  for (const text of [
    "Can I move my grooming from Saturday to Sunday?",
    "My booking reference is BK-2026-0915 and the total was Rs 1,499",
    "Milo is a 3 year old golden retriever, quite nervous around clippers",
    "The groomer arrived at 10:30 and finished by 11:45",
    "I paid 2000 for the last session",
    "Please come to flat 402, the gate code is on the notes",
  ]) {
    assert.equal(leaks(text), text, `ordinary text must pass through unchanged: ${text}`);
  }
});

test("a short number is not mistaken for an identifier", async () => {
  /*
   * The boundary of the grouped-digit pattern. Prices, years, quantities and times are all short
   * digit runs and must not be swallowed - over-redaction costs the assistant the context it needs.
   */
  for (const text of [
    "the total is 1499", "2026", "9 sessions", "10:30", "Rs 12,500",
    "invoice 000123", "2026-09-15", "x 12345678901",
  ]) {
    assert.equal(leaks(text), text, `"${text}" is not an identifier`);
  }
  assert.notEqual(leaks("x 123456789012"), "x 123456789012", "twelve digits IS an identifier");
});

test("an identifier sent as a NUMBER is redacted, not just one sent as a string", async () => {
  /*
   * sanitizeValue() only ever pattern-checked strings, so an identifier serialised as a JSON
   * number went straight through: {"idNumber":123456789012} reached the provider in clear while
   * {"idNumber":"123456789012"} - the identical value - was redacted. The field-name layer caught
   * it only when the key happened to be in SENSITIVE_KEYS, and "idNumber" is not.
   */
  for (const [label, payload, secret] of [
    ["aadhaar as a number", { idNumber: 123456789012 }, "123456789012"],
    ["card as a number", { cardNumber: 4111111111111111 }, "4111111111111111"],
    ["under an innocuous key", { reference: 4111111111111111 }, "4111111111111111"],
    ["inside an array", { ids: [123456789012, 4111111111111111] }, "123456789012"],
  ]) {
    const output = leaks(JSON.stringify(payload));
    assert.ok(!output.includes(secret), `${label} must not reach the provider: ${output}`);
  }
  assert.equal(
    leaks(JSON.stringify({ idNumber: 123456789012 })),
    leaks(JSON.stringify({ idNumber: "123456789012" })),
    "the same value must be treated the same way whether it is typed as a number or a string",
  );
});

test("a timestamp survives - redacting those would cost the assistant every 'when'", async () => {
  /*
   * The deliberate trade in treating long numbers as identifiers. An epoch-millisecond timestamp
   * is 13 digits, and is real context. Aadhaar is 12 digits (below the epoch window) and card PANs
   * are 14-19 (above it), so both are still caught.
   */
  for (const payload of [
    { createdAt: 1789069362898 }, { scheduledAt: 1789069362898, completedAt: 1789072962898 },
    { totalAmount: 1499, sessions: 10, rating: 4.5, durationMinutes: 90 },
  ]) {
    const serialised = JSON.stringify(payload);
    assert.equal(leaks(serialised), serialised, `ordinary numeric context must survive: ${serialised}`);
  }
});

test("a sensitive FIELD is redacted by its name, whatever it contains", async () => {
  /*
   * The structured layer. A customer name or an address carries no pattern to match on, so field
   * names are the only thing that can catch them.
   */
  const payload = JSON.stringify({
    customerName: "Rhea Nair", primaryPhone: "9876543210", address: "42 Ranga Rao Road",
    pincode: "560004", petName: "Milo", medicalNotes: "on medication for anxiety",
    bookingId: "BK-2026-0915", serviceCode: "grooming",
  });
  const output = leaks(payload);
  for (const secret of ["Rhea Nair", "9876543210", "42 Ranga Rao Road", "560004", "Milo", "on medication for anxiety"]) {
    assert.ok(!output.includes(secret), `${secret} must not reach the provider: ${output}`);
  }
  assert.match(output, /grooming/, "the service code is context the assistant needs, not PII");
});

test("nesting cannot be used to smuggle a sensitive field past the boundary", async () => {
  const nested = JSON.stringify({
    booking: { customer: { profile: { email: "rhea@example.com", customerName: "Rhea Nair" } } },
    history: [{ notes: "called about a refund" }, { phone: "9876543210" }],
  });
  const output = leaks(nested);
  for (const secret of ["rhea@example.com", "Rhea Nair", "called about a refund", "9876543210"]) {
    assert.ok(!output.includes(secret), `${secret} must not survive nesting: ${output}`);
  }
});

test("a deeply nested payload is truncated rather than followed forever", async () => {
  let deep = { value: "rhea@example.com" };
  for (let i = 0; i < 40; i++) deep = { nested: deep };
  const output = leaks(JSON.stringify(deep));
  assert.ok(!output.includes("rhea@example.com"), "depth must not be a way past the guard");
  assert.match(output, /\[REDACTED\]/);
});

test("an empty or absent input is handled without throwing", async () => {
  for (const input of ["", "   ", null, undefined]) {
    const result = sanitizeAiProviderText(input);
    assert.equal(typeof result.text, "string");
    assert.equal(result.redacted, false, `${String(input)} contains nothing to redact`);
    assert.deepEqual(result.categories, []);
  }
});

test("the replacement token is a constant, not an ad-hoc string", async () => {
  assert.equal(EXTERNAL_AI_REDACTION, "[REDACTED]");
  assert.match(leaks("rhea@example.com"), new RegExp(EXTERNAL_AI_REDACTION.replace(/[[\]]/g, "\\$&")),
    "every redaction must use the same token, so a log search finds all of them");
});
