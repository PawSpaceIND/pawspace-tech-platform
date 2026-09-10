/*
 * Day-31 wave 5: three small shared primitives that other modules trust absolutely.
 *
 *   sameInstant()      - whether two spellings of a booking window are the same moment
 *   readBoundedText()  - the one bounded reader for every external provider response
 *   groomingReplacementCapacity() - whether a replacement groomer genuinely exists
 *
 * None had a test importing it. These are the kind of function that is obviously right on
 * inspection and wrong at exactly one input, and because they are shared, that one input is wrong
 * everywhere at once. sameInstant() exists precisely because four private copies of the same
 * comparison had already drifted and refused a real customer's booking after the provider's
 * capacity had been committed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__D31W_BND_DB__", "__D31W_BND_ENV__");

const { sameInstant } = await import("../lib/booking-window-instant.ts");
const { readBoundedText, ProviderResponseTooLarge } = await import("../lib/provider-response-bounds.ts");

test("the same moment spelled differently is the same window", async () => {
  /*
   * The measured production failure: app/training/page.tsx builds "...T10:00:00+05:30" while the
   * scheduler stores new Date(v).toISOString() as "...T04:30:00.000Z". Identical instants, and a
   * string comparison refused the booking after the reservation was already committed.
   */
  const pairs = [
    ["2026-10-01T10:00:00+05:30", "2026-10-01T04:30:00.000Z"],
    ["2026-10-01T04:30:00Z", "2026-10-01T04:30:00.000Z"],
    ["2026-10-01T04:30:00.000Z", "2026-10-01T04:30:00.000+00:00"],
    ["2026-10-01T00:00:00-05:00", "2026-10-01T05:00:00.000Z"],
  ];
  for (const [a, b] of pairs) {
    assert.equal(sameInstant(a, b), true, `${a} and ${b} are the same instant`);
    assert.equal(sameInstant(b, a), true, "and the comparison is symmetric");
  }
});

test("different moments are not the same window, including one second apart", async () => {
  for (const [a, b] of [
    ["2026-10-01T04:30:00.000Z", "2026-10-01T04:30:01.000Z"],
    ["2026-10-01T04:30:00.000Z", "2026-10-01T04:30:00.001Z"],
    ["2026-10-01T10:00:00+05:30", "2026-10-01T10:00:00Z"],
    ["2026-10-01T04:30:00.000Z", "2026-10-02T04:30:00.000Z"],
  ]) {
    assert.equal(sameInstant(a, b), false, `${a} and ${b} are different instants`);
  }
});

test("an unreadable window is refused, never read as matching", async () => {
  /*
   * The dangerous direction. If two unparseable values compared equal, a booking whose window
   * nobody can read would sail through the guard that exists to catch exactly that.
   */
  const junk = ["", "   ", "not-a-date", "2026-13-45T00:00:00Z", null, undefined, {}, [], Number.NaN];
  for (const bad of junk) {
    assert.equal(sameInstant(bad, bad), false, `two copies of ${JSON.stringify(bad)} must not count as agreeing`);
    assert.equal(sameInstant(bad, "2026-10-01T04:30:00.000Z"), false);
    assert.equal(sameInstant("2026-10-01T04:30:00.000Z", bad), false);
  }
});

test("a provider response within the ceiling is read whole", async () => {
  const body = JSON.stringify({ ok: true, note: "x".repeat(500) });
  assert.equal(await readBoundedText(new Response(body), 64_000), body);
  assert.equal(await readBoundedText(new Response(""), 64_000), "", "an empty body is a real answer");
});

test("an oversized provider response is refused instead of exhausting the Worker", async () => {
  /*
   * The failure this prevents is not a wrong answer, it is an out-of-memory kill inside a Worker
   * with a hard ceiling - which surfaces as the whole request dying rather than as "the provider
   * misbehaved". Anything that can answer in the provider's place can trigger it.
   */
  const huge = "y".repeat(200_000);
  await assert.rejects(() => readBoundedText(new Response(huge), 1_000), ProviderResponseTooLarge);
  await assert.rejects(() => readBoundedText(new Response(huge), 1_000),
    (error) => { assert.equal(error.maxBytes, 1_000, "the refusal must say what the ceiling was"); return true; });
});

test("the ceiling is measured in BYTES, not characters", async () => {
  /*
   * A multi-byte body is the case a length check gets wrong. Devanagari and emoji are three and
   * four bytes per character, so ten characters of Hindi is thirty bytes - a customer name or a
   * WhatsApp message body in any Indian language goes straight through a .length ceiling.
   */
  const hindi = "नमस्ते";
  const bytes = new TextEncoder().encode(hindi).byteLength;
  assert.ok(bytes > hindi.length, "the fixture must actually be multi-byte");
  await assert.rejects(() => readBoundedText(new Response(hindi), bytes - 1), ProviderResponseTooLarge,
    "a body one byte over the ceiling must be refused even though it is few characters");
  assert.equal(await readBoundedText(new Response(hindi), bytes), hindi, "and exactly at the ceiling it is read");
});

test("a streamed body is cut off at the ceiling rather than buffered whole", async () => {
  let chunksProduced = 0;
  const stream = new ReadableStream({
    pull(controller) {
      chunksProduced++;
      if (chunksProduced > 200) { controller.close(); return; }
      controller.enqueue(new TextEncoder().encode("z".repeat(1_000)));
    },
  });
  await assert.rejects(() => readBoundedText(new Response(stream), 5_000), ProviderResponseTooLarge);
  assert.ok(chunksProduced < 50,
    `the reader must stop pulling once the ceiling is crossed, not drain the stream (pulled ${chunksProduced})`);
});

test("a nonsensical ceiling refuses rather than reading without limit", async () => {
  for (const maxBytes of [0, -1, Number.NaN, Infinity]) {
    await assert.rejects(() => readBoundedText(new Response("anything"), maxBytes), ProviderResponseTooLarge,
      `a ceiling of ${maxBytes} must not be treated as unlimited`);
  }
});

test("replacement capacity resolves the booking window in IST, not UTC", async () => {
  /*
   * The predicate this builds is matched against a groomer's authored availability windows, which
   * are written in India local time. A 09:30 IST appointment is 04:00Z, so a UTC-derived window
   * would look for "04:00-05:30" in a roster that says "09:30-11:00" and find no replacement at
   * all - on the path that runs when a groomer has already dropped out and a customer is waiting.
   */
  const { groomingReplacementCapacity } = await import("../lib/grooming-replacement-capacity.ts");
  const booking = {
    scheduled_start: "2026-10-01T04:00:00.000Z",   // 09:30 IST
    scheduled_end: "2026-10-01T05:30:00.000Z",     // 11:00 IST
    schedule_group_id: "GRP-1", city_id: "blr", zone_id: "blr-east",
  };
  const { sql, values } = groomingReplacementCapacity(booking, "PRV-REPLACEMENT", "in_house");

  assert.ok(values.includes("2026-10-01"), `the IST date must be bound: ${JSON.stringify(values)}`);
  assert.ok(values.includes("09:30"), "the window must open at the India local start time");
  assert.ok(values.includes("11:00"), "and close at the India local end time");
  assert.equal(values[0], "PRV-REPLACEMENT");
  assert.equal(values[1], "in_house");
  assert.match(sql, /provider_unavailability/, "a replacement must not be someone marked unavailable");
  assert.match(sql, /max_daily_jobs/, "nor someone already at their daily ceiling");
  assert.match(sql, /travel_buffer_minutes/, "nor someone who cannot physically get there in time");
  assert.match(sql, /p\.live=1 AND p\.status='active'/, "nor a deactivated profile");
});

test("a booking whose window crosses IST midnight resolves to the India date", async () => {
  const { groomingReplacementCapacity } = await import("../lib/grooming-replacement-capacity.ts");
  // 19:00Z on 30 Sep is 00:30 IST on 1 Oct - the appointment belongs to 1 October in India.
  const { values } = groomingReplacementCapacity({
    scheduled_start: "2026-09-30T19:00:00.000Z", scheduled_end: "2026-09-30T20:00:00.000Z",
    schedule_group_id: "GRP-2", city_id: "blr", zone_id: "blr-east",
  }, "PRV-1", "in_house");
  assert.ok(values.includes("2026-10-01"), `an after-midnight IST slot belongs to the next India day: ${JSON.stringify(values)}`);
  assert.ok(values.includes("00:30"));
});

test("an unreadable booking window is refused by name, not by a raw date crash", async () => {
  /*
   * This runs inside the assignment transaction on the recovery path. A RangeError of
   * "Invalid time value" surfaces there as an unexplained 500; a named refusal tells whoever is
   * handling the dropped-out groomer what is actually wrong.
   */
  const { groomingReplacementCapacity } = await import("../lib/grooming-replacement-capacity.ts");
  for (const broken of [
    { scheduled_start: null, scheduled_end: "2026-10-01T05:30:00.000Z" },
    { scheduled_start: "2026-10-01T04:00:00.000Z", scheduled_end: undefined },
    { scheduled_start: "not-a-date", scheduled_end: "2026-10-01T05:30:00.000Z" },
    { scheduled_start: "", scheduled_end: "" },
  ]) {
    assert.throws(
      () => groomingReplacementCapacity({ ...broken, schedule_group_id: "GRP-3", city_id: "blr", zone_id: "blr-east" }, "PRV-1", "in_house"),
      /replacement_capacity_unreadable_booking_window/,
      `an unreadable window must be named, not crash: ${JSON.stringify(broken)}`,
    );
  }
});
