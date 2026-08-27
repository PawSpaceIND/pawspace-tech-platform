/*
 * A booking's idempotency key must be a FUNCTION OF ITS INPUTS, not of the attempt.
 *
 * app/mobile-app/grooming-flow.tsx built its request id with a random `bookingNonce()`, so every
 * submission produced a different key and the server's replay protection had nothing to match on: a
 * resubmit of the SAME booking - a double-tap that outlived the busy flag, a retried request, a
 * customer pressing back and confirming again - created a second booking rather than replaying the
 * first. The landing page it now serves had the opposite and correct arrangement, a stable fingerprint
 * over the mutable inputs, and that behaviour was pinned by
 * tests/grooming-customer-integrity.test.mjs. Routing `/` into the governed flow without bringing this
 * along would have traded a real protection for a worse one.
 *
 * FNV-1a over the values joined by a UNIT SEPARATOR, exactly as app/page.tsx computed it - the
 * separator is what stops ["ab","c"] and ["a","bc"] hashing alike. Same inputs in, same key out; any
 * material change in, a different key. [PTJA-P1-F38]
 */
export function stableBookingInputKey(values: string[]) {
  let hash = 2166136261;
  for (const character of values.join("\u001f")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
