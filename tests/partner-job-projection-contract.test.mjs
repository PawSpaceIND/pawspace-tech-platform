import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as nodeModule from "node:module";

// lib/* imports its siblings without a file extension, so resolution needs the retry hook the other
// executed suites install. Static imports hoist above it, hence the dynamic import below.
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `export async function resolve(specifier, context, nextResolve) {
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const { projectProviderLifecycleEvent, sanitizeProviderEventDetail } = await import("../lib/grooming-provider-projection.ts");

// ---------------------------------------------------------------------------
// /api/partner-grooming-jobs -> the Partner app's Job type, field for field.
//
// The route projects rather more than the client declared. safetyRequirements and addOns are pulled out
// of the booking's pricing_json, payment carries amountDueNow next to the mode, and occurrenceCount says
// how many visits the package covers. None of those were on the client's `Job` type, so all of them were
// dropped on arrival: a partner drove to a job without the handling requirements recorded against the
// pet and without the figure they collect at the door.
//
// This asserts the CLASS of defect, not just the instance: every key the route emits must be declared by
// the consumer, so adding a field to the route without wiring it fails here.
// ---------------------------------------------------------------------------

const route = readFileSync(new URL("../app/api/partner-grooming-jobs/route.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../app/partner-app/page.tsx", import.meta.url), "utf8");

const OPENERS = "{[(";
const CLOSERS = "}])";

/** The body of the object literal or type literal whose opening brace is at `open`. */
function objectBody(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (OPENERS.includes(character)) depth += 1;
    else if (CLOSERS.includes(character)) {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error("unbalanced object literal");
}

/** Split on separators that sit at nesting depth zero. Covers both `,` (literal) and `;` (type). */
function topLevelSegments(body) {
  const segments = [];
  let depth = 0;
  let current = "";
  for (const character of body) {
    if (OPENERS.includes(character)) depth += 1;
    else if (CLOSERS.includes(character)) depth -= 1;
    if (depth === 0 && (character === "," || character === ";")) { segments.push(current); current = ""; continue; }
    current += character;
  }
  segments.push(current);
  return segments;
}

/**
 * Top-level keys of the object at `open`.
 *
 * The two shapes are written differently: the route uses shorthand properties (`addOns,`) and commas,
 * the type uses `name: T` and semicolons. A key is the text before a segment's first depth-zero colon,
 * or the whole segment when it is a bare identifier - which is exactly what shorthand looks like.
 */
function objectKeys(source, open) {
  const keys = [];
  for (const segment of topLevelSegments(objectBody(source, open))) {
    const stripped = segment.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (!stripped) continue;
    let depth = 0;
    let colon = -1;
    for (let index = 0; index < stripped.length; index += 1) {
      const character = stripped[index];
      if (OPENERS.includes(character)) depth += 1;
      else if (CLOSERS.includes(character)) depth -= 1;
      else if (character === ":" && depth === 0) { colon = index; break; }
    }
    const name = (colon === -1 ? stripped : stripped.slice(0, colon)).trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) keys.push(name);
  }
  return keys;
}

const routeKeys = objectKeys(route, route.indexOf("{", route.indexOf("jobs.push(")));
const declaredKeys = objectKeys(page, page.indexOf("{", page.indexOf("type Job = ")));

test("the extraction found both shapes, so the comparison below means something", () => {
  assert.ok(routeKeys.length >= 20, `expected the route projection's keys, got ${routeKeys.join(",")}`);
  assert.ok(declaredKeys.length >= 20, `expected the Job type's keys, got ${declaredKeys.join(",")}`);
  // Spot-check both spellings the parser has to handle, so a parser regression cannot pass this file.
  assert.ok(routeKeys.includes("bookingId"), "a `name:value` key");
  assert.ok(routeKeys.includes("addOns"), "a shorthand key - the spelling the first version of this test missed");
  assert.ok(declaredKeys.includes("bookingId"));
});

test("every field the route returns for a job is declared by the Partner app", () => {
  const missing = routeKeys.filter((key) => !declaredKeys.includes(key));
  assert.deepEqual(missing, [],
    `the route returns these and the client discards them: ${missing.join(", ")}`);
});

test("the fields that were being dropped are specifically present on both sides", () => {
  for (const key of ["safetyRequirements", "addOns", "occurrenceCount", "subscription", "packageCode", "cityId", "currency", "events"]) {
    assert.ok(routeKeys.includes(key), `${key} must still be returned by the route`);
    assert.ok(declaredKeys.includes(key), `${key} must be declared by the client`);
  }
  assert.match(route, /amountDueNow:Number\(row\.amount_due_now\|\|0\)/);
  assert.match(page, /amountDueNow: number/);
});

test("handling requirements, add-ons and the amount to collect are rendered, not merely typed", () => {
  assert.match(page, /selected\.safetyRequirements\.length/, "declaring a field is not showing it");
  assert.match(page, /Handling requirements/);
  assert.match(page, /selected\.addOns\.length/);
  assert.match(page, /selected\.payment\.amountDueNow > 0/);
  assert.match(page, /collect \$\{money\(selected\.payment\.amountDueNow\)\}/);
  assert.match(page, /selected\.occurrenceCount > 1/, "a multi-visit package must not read as a single visit");
});

test("the projection withholds contact data from the events the timeline now renders", () => {
  // Run the real projection over a row carrying exactly what providers must never receive.
  const projected = projectProviderLifecycleEvent({
    event_type: "provider_on_the_way",
    entity_type: "provider_work_order",
    actor_id: "ops.one@pawspace.in",
    occurred_at: 1_700_000_000_000,
    detail_json: JSON.stringify({
      action: "on_the_way",
      status: "on_the_way",
      staffNote: "called customer on 9876543210 about the gate code",
      customerPhone: "+91 98765 43210",
      customerEmail: "ananya@example.com",
      doorstep: "12 Example Cross, Koramangala",
      distanceMeters: 420,
    }),
  });

  assert.equal(projected.actorId, "provider_or_system", "the real staff actor must never reach a provider");
  assert.notEqual(projected.actorId, "ops.one@pawspace.in");
  assert.equal(projected.eventType, "provider_on_the_way");
  assert.equal(projected.occurredAt, 1_700_000_000_000);

  // Operational state survives; every contact-shaped and free-text key is dropped.
  assert.equal(projected.detail.distanceMeters, 420);
  assert.equal(projected.detail.status, "on_the_way");
  for (const leaked of ["staffNote", "customerPhone", "customerEmail", "doorstep"]) {
    assert.ok(!(leaked in projected.detail), `${leaked} must not reach a provider surface`);
  }

  // Even an allow-listed key is dropped when its VALUE looks like contact data.
  assert.deepEqual(sanitizeProviderEventDetail({ reason: "customer asked us to call 9876543210" }), {},
    "the allow-list is not a bypass for a phone number hidden in a permitted field");
  assert.deepEqual(sanitizeProviderEventDetail({ reason: "traffic delay" }), { reason: "traffic delay" });
});

test("the timeline renders only the event's non-contact fields", () => {
  assert.match(page, /selected\.events\.slice\(0, 5\)/);
  assert.doesNotMatch(page, /event\.detail/,
    "sanitized or not, free-form event detail is not rendered on a partner's phone");
});
