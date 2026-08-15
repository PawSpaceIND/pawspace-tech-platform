/**
 * P1 — a missing Grooming commercial policy is a configuration refusal, not an outage.
 *
 * Tester 3's Chennai attempt was refused correctly at the commercial boundary — no booking, no payment,
 * no money moved — but the refusal surfaced as HTTP 500. resolveGroomingPolicy threw a BARE Error, and
 * because it was called from outside the governance try/catch in canonical-bookings it reached
 * authError() unclassified, which correctly answers 500 for anything that does not say what it is.
 *
 * The fix is narrow: that ONE throw now says it is a 409, which is what the surrounding commercial
 * contract already returns for every other policy conflict (multi-pet cap, price mismatch, package
 * validation). Nothing else about the classifier changed.
 *
 * This suite pins the fix AND the invariants that must not move with it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__P1POL_DB__", "__P1POL_ENV__");

const { resolveGroomingPolicy } = await import("../lib/grooming-policy-governance.ts");
const { clientStatusOf, clientError } = await import("../lib/http-errors.ts");
const { authError } = await import("../lib/server-auth.ts");

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__P1POL_DB__ = createD1(sqlite);
  globalThis.__P1POL_ENV__ = {};
  return sqlite;
}

test("a city with no active Grooming policy throws a refusal classified 409, not an unclassified error", async () => {
  freshDb();
  // 'maa' is deliberately never configured — Chennai stays commercially blocked.
  await assert.rejects(
    () => resolveGroomingPolicy(globalThis.__P1POL_DB__, "maa", "maa-central"),
    (error) => {
      assert.match(String(error.message), /No active Grooming commercial policy/i, "the reason still reaches the operator");
      assert.equal(clientStatusOf(error), 409, "and it now declares itself a 409 rather than falling through to 500");
      return true;
    },
  );
});

test("that refusal, put through the real authError(), answers 409 — the exact P1 that returned 500", async () => {
  freshDb();
  const error = await resolveGroomingPolicy(globalThis.__P1POL_DB__, "maa", "maa-central").catch((e) => e);
  const response = authError(error);
  assert.equal(response.status, 409, "the configuration refusal is answered as a client conflict");
  const body = await response.json();
  assert.match(String(body.error), /No active Grooming commercial policy/i);
});

test("a configured city is unaffected — Bengaluru still resolves its policy normally", async () => {
  freshDb();
  const policy = await resolveGroomingPolicy(globalThis.__P1POL_DB__, "blr", "blr-east");
  assert.ok(policy, "the seeded Bengaluru policy still resolves");
});

// ---- invariants that must NOT move with this fix -----------------------------------------------
test("INVARIANT: a plain unannotated Error is still a 500 — no blanket 4xx conversion", () => {
  const response = authError(new Error("something genuinely unexpected exploded"));
  assert.equal(response.status, 500, "unclassified failures must stay in the alerting path");
});

test("INVARIANT: an annotated 5xx cannot be laundered into a 4xx", () => {
  const server = Object.assign(new Error("upstream down"), { statusCode: 503 });
  assert.equal(clientStatusOf(server), null, "503 is not in the client set, so it is not honoured");
  assert.equal(authError(server).status, 500, "and it is answered 500, never 503-as-4xx");
});

test("INVARIANT: ownership failures remain 403", () => {
  assert.equal(authError(clientError(403, "Customer ownership denied")).status, 403);
});

test("INVARIANT: existing 400/404/409/422 semantics are unchanged", () => {
  for (const status of [400, 404, 409, 422]) {
    assert.equal(authError(clientError(status, `refused ${status}`)).status, status);
  }
});
