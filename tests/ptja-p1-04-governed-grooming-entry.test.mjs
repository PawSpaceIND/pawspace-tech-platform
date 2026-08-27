import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stableBookingInputKey } from "../lib/booking-input-fingerprint.ts";

// ---------------------------------------------------------------------------
// PTJA-P1-F38 — the landing page books through the governed flow, and the handover loses nothing.
//
// P1-04 measured: app/page.tsx read no customer session (zero imports), its OTP step issued ZERO
// network requests and said so on screen ("Prototype note: OTP verification is simulated for review"),
// its "registered pet" list was a hardcoded fixture, and it synthesised identity as `WEB-<phone>` from
// an unverified number. Holding no session, on any non-preview host its FIRST API call returned 401 —
// after the customer had entered name, phone, address, pet, safety notes and payment preference.
//
// Option 2: route `/` into app/mobile-app/grooming-flow.tsx AND carry across the four behaviours the
// governed flow did not have, rather than accept them as losses. Each was pinned by an existing
// regression before this change; none is repointed to accept less.
//
// No shared global test namespace is used by this file.
// ---------------------------------------------------------------------------

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const FLOW = "app/mobile-app/grooming-flow.tsx";
const ENTRY = "app/page.tsx";

// --- 1. the idempotency fingerprint ------------------------------------------------------------

const INPUTS = ["CUS-1", "2026-11-04", "0", "1", "dog", "dog-basic", "single", "online", "friendly", "1899", "0", "", "", "", "PET-1", "blr-east", "221 1st Main"];

test("P1-04-K01 the same logical booking produces the same key", () => {
  assert.equal(stableBookingInputKey(INPUTS), stableBookingInputKey([...INPUTS]),
    "a resubmit of an unchanged booking must replay, not create a second one");
});

test("P1-04-K02 the key is deterministic across repeated calls", () => {
  const keys = new Set(Array.from({ length: 25 }, () => stableBookingInputKey(INPUTS)));
  assert.equal(keys.size, 1, `a key derived from the attempt cannot replay: ${[...keys].join(",")}`);
});

test("P1-04-K03 every materially different input changes the key", () => {
  const base = stableBookingInputKey(INPUTS);
  const labels = ["customer", "date", "slot", "pet count", "type", "package", "plan", "payment", "safety notes", "total", "discount", "coupon", "subscription", "add-ons", "pets", "zone", "address"];
  for (let index = 0; index < INPUTS.length; index++) {
    const changed = [...INPUTS];
    changed[index] = `${changed[index]}-changed`;
    assert.notEqual(stableBookingInputKey(changed), base, `changing the ${labels[index]} must change the key`);
  }
});

test("P1-04-K04 the separator stops adjacent fields from bleeding into each other", () => {
  // Without a separator ["ab","c"] and ["a","bc"] hash identically, so two different bookings would
  // share one key and the second would be silently swallowed as a replay of the first.
  assert.notEqual(stableBookingInputKey(["ab", "c"]), stableBookingInputKey(["a", "bc"]));
  assert.notEqual(stableBookingInputKey(["", "a"]), stableBookingInputKey(["a", ""]));
});

test("P1-04-K05 the flow's request id contains nothing derived from the attempt", async () => {
  const flow = await read(FLOW);
  assert.match(flow, /stableBookingInputKey\(\[/, "the request id is built from the booking's inputs");
  const code = flow.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*")).join("\n");
  assert.ok(!/bookingNonce/.test(code), "no attempt-derived nonce remains");

  // The name alone proves nothing: a fingerprint over inputs that INCLUDE a clock or a random value is
  // just a nonce wearing a better name, and a shape assertion cannot tell the two apart. Extract the
  // actual request-id expression by balancing brackets from the call, and require it to be pure.
  const start = code.indexOf("stableBookingInputKey([");
  assert.ok(start > 0, "the call is present");
  let depth = 0, end = start;
  for (let i = code.indexOf("[", start); i < code.length; i++) {
    if (code[i] === "[") depth++;
    else if (code[i] === "]") { depth--; if (depth === 0) { end = i; break; } }
  }
  const inputs = code.slice(start, end + 1);
  for (const impure of ["Date.now", "Math.random", "randomUUID", "performance.now", "new Date("]) {
    assert.ok(!inputs.includes(impure), `the key must not depend on ${impure}: ${inputs.slice(0, 160)}`);
  }
});

// --- 2. the payment state ----------------------------------------------------------------------

test("P1-04-P01 pay-now is recorded as pending and cannot read as already paid", async () => {
  const flow = await read(FLOW);
  assert.match(flow, /initialPaymentStatus:pay==="online"\?"payment_pending":"due_after_service"/,
    "an online payment is pending until something proves otherwise");
  const ledger = await read("lib/test-transaction.ts");
  assert.match(ledger, /"payment_pending"/, "the ledger understands the state");
  assert.match(ledger, /initialPaymentStatus\?\?\(/, "and takes it from the caller rather than guessing");
});

// --- 3. the verified-provider proof -------------------------------------------------------------

test("P1-04-V01 the proof is shown only when the public profile supplies it", async () => {
  const flow = await read(FLOW);
  assert.match(flow, /\{providerProof&&</, "nothing renders without a resolved profile");
  assert.match(flow, /provider-public-profile\?providerId=/, "and the profile is the source");
  assert.match(flow, /response\.ok&&body\.data/, "only a successful lookup sets it");
});

test("P1-04-V02 an unproven credential is never invented", async () => {
  const flow = await read(FLOW);
  // Comments are stripped before the ban is applied. A comment that QUOTES the banned string is a
  // record of the defect, not the defect — the same distinction this suite draws for the entry page,
  // and a trap this audit has already fallen into once by banning a substring outright.
  const code = flow.split("\n").filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*")).join("\n");
  // These exact strings were once shown for every groomer alike; that is what made the proof a claim
  // rather than evidence, and it is the reason the original regression banned them.
  for (const fabricated of ["1,248 services", "4 years with PawSpace"]) {
    assert.ok(!code.includes(fabricated), `the flow must not hardcode "${fabricated}"`);
  }
  assert.match(flow, /catch\(\(\)=>\{\/\* no proof rather than an invented one \*\/\}\)/,
    "a failed lookup shows nothing at all");
  assert.match(flow, /providerProof\.stats\?/, "counts come from the profile's own stats");
  assert.match(flow, /providerProof\.isNewProvider&&/, "and a provider with no history says so honestly");
});

// --- 4. the safety capture ----------------------------------------------------------------------

test("P1-04-S01 all four safety states are offered and persisted", async () => {
  const flow = await read(FLOW);
  for (const option of ["friendly", "anxious", "aggressive"]) {
    assert.match(flow, new RegExp(`value="${option}"`), `${option} must be selectable`);
  }
  assert.match(flow, /Aggressive \/ bite history/, "bite history is nameable, because a groomer needs to know");
  assert.match(flow, /requirements:\[`grooming_safety:\$\{safetyNotes\}`\]/, "and it reaches the booking");
});

// --- 5. the defect that made P1-04 exist ---------------------------------------------------------

test("P1-04-E01 the entry page carries no simulated or fabricated identity", async () => {
  const source = await read(ENTRY);
  const code = source.split("\n").filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//")).join("\n");
  assert.ok(!code.includes("OTP verification is simulated"), "no simulated OTP");
  assert.ok(!/`WEB-\$\{/.test(code), "no identity synthesised from an unverified phone number");
  assert.ok(!code.includes("savedPets"), "no hardcoded pet list");
  assert.ok(!code.includes("TST-101"), "no fixture customer");
});

test("P1-04-E02 the entry page resolves the session customer and hands booking to the governed flow", async () => {
  const source = await read(ENTRY);
  assert.match(source, /loadCustomerAccount\(\)/, "the customer comes from the platform session");
  assert.doesNotMatch(source, /loadCustomerAccount\(\s*["'`]/, "never a literal id");
  assert.match(source, /import GroomingFlow, \{ GROOMING_SLOTS, resolveGroomingPackId \} from "\.\/mobile-app\/grooming-flow"/);
  assert.match(source, /<GroomingFlow customer=\{customer\} initial=/, "the governed flow books");
  assert.match(source, /import CustomerLogin/, "sign-in reuses the existing login, not a new identity model");
});

test("P1-04-E03 non-vacuity: the governed flow is itself session-bound", async () => {
  // If the flow were the broken one, routing into it would be no fix at all.
  const flow = await read(FLOW);
  assert.ok(!flow.includes("TST-101"), "no fixture identity in the flow");
  assert.match(flow, /customer\.customerId/, "it books for the customer it is given");
  assert.match(flow, /createCanonicalLifecycle/, "through the canonical lifecycle");
});

// --- The handoff must carry the booking the customer was shown, not restart a different one ---
// Measured before this: the summary bar read "Complete Makeover · 3 Sep · 1:00-3:00 PM · Rs 2,399",
// and pressing Confirm booking mounted the flow with only `customer`, which re-initialised to
// Essential Bath, tomorrow, 11:00 AM. The customer could confirm one booking and be taken into another.

test("P1-04-H01 the entry page hands its selection to the flow, not just the customer", async () => {
  const source = await read("app/page.tsx");
  assert.match(source, /<GroomingFlow customer=\{customer\} initial=\{\{/, "the selection travels with the customer");
  for (const field of ["type: petType", "packId: resolveGroomingPackId(petType, selectedPackage.name)", "date: dates[selectedDate]?.isoDate", "slot: selectedSlot"]) {
    assert.ok(source.includes(field), `and carries ${field}`);
  }
});

test("P1-04-H02 the flow seeds itself from that selection instead of its own defaults", async () => {
  const flow = await read("app/mobile-app/grooming-flow.tsx");
  assert.match(flow, /useState<PetType>\(initial\?\.type\?\?"dog"\)/, "pet type");
  assert.match(flow, /useState\(initial\?\.packId\|\|"bath"\)/, "package");
  assert.match(flow, /if\(initial\?\.date\)return initial\.date/, "date");
  assert.match(flow, /initial\?\.slot&&slots\.includes\(initial\.slot\)\?initial\.slot:slots\[1\]/,
    "slot - and only a slot this flow actually serves, never an approximation");
});

test("P1-04-H03 the entry page cannot advertise a slot the flow will not reserve", async () => {
  const source = await read("app/page.tsx");
  const flow = await read("app/mobile-app/grooming-flow.tsx");
  assert.match(flow, /export const GROOMING_SLOTS=/, "the flow owns the slot vocabulary");
  assert.match(source, /const slots = GROOMING_SLOTS;/, "and the entry page uses it rather than its own list");
  // The measured divergence: the entry page offered 5:00-7:00 PM, which the flow has never served.
  const code = source.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
  assert.ok(!code.includes("5:00–7:00 PM"), "the unbookable fifth slot is gone");
});

test("P1-04-H04 every regular package the entry page prices exists in the flow's catalogue", async () => {
  const source = await read("app/page.tsx");
  const flow = await read("app/mobile-app/grooming-flow.tsx");
  // resolveGroomingPackId matches by NAME, so parity is checked on the names and their prices: a
  // package the entry page prices at one figure and the flow at another is the same silent
  // substitution, just later in the journey.
  const flowPacks = new Map([...flow.matchAll(/\{id:"[a-z]+",name:"([^"]+)"[^}]*?price:(\d+)/g)].map((m) => [m[1], m[2]]));
  const entryPacks = [...source.matchAll(/id: "(?:dog|cat)-[a-z]+", name: "([^"]+)"[^}]*?price: (\d+)/g)];
  assert.ok(entryPacks.length >= 8, `the entry page prices ${entryPacks.length} regular packages`);
  for (const [, name, price] of entryPacks) {
    assert.ok(flowPacks.has(name), `"${name}" exists in the flow - no silent substitution`);
    assert.equal(flowPacks.get(name), price, `"${name}" costs the same in both`);
  }
  // Non-vacuity: the flow's catalogue is real, and does not carry an invented name.
  assert.ok(flowPacks.size >= 4, "the flow's catalogue was actually parsed");
  assert.ok(!flowPacks.has("Platinum Spa"), "an unknown package is not present");
});

// --- A failure after the booking commits is a partial outcome, not a booking failure ---
// Measured: createCanonicalLifecycle commits the booking and the groomer reservation, then
// saveServiceLocation and the ledger write run. A throw in either landed in the same catch and
// displayed "No groomer is available for this slot" for a booking that already existed.

test("P1-04-A01 a post-commit failure names the booking instead of denying it", async () => {
  const flow = await read("app/mobile-app/grooming-flow.tsx");
  const code = flow.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*")).join("\n");
  assert.match(code, /let committedBookingId=""/, "the flow tracks whether the booking committed");
  assert.match(code, /committedBookingId=canonical\.bookingId;await saveServiceLocation/,
    "stamped immediately after the canonical call returns, BEFORE the writes that can still fail");
  const start = code.indexOf("}catch(error){");
  assert.ok(start > 0, "the confirm catch exists");
  const handler = code.slice(start, code.indexOf("}finally", start));
  assert.ok(handler.includes("committedBookingId?"), "the handler branches on whether the booking exists");
  assert.ok(handler.includes("is confirmed"), "and says so rather than denying it");
  assert.ok(handler.includes("Do not rebook"), "and tells the customer not to rebook");
  // Non-vacuity: the pre-commit path still reports a genuine scheduling failure.
  assert.ok(handler.includes("No groomer is available for this slot"), "a pre-commit failure still reads as one");
});
