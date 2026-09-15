/*
 * A verification hold is a business rule, not a platform fault.
 *
 * lib/provider-assignment-eligibility.ts threw plain `Response.json(...)` for every one of its
 * refusals. lib/server-auth.ts `authError` trusts only a Response marked via markGovernedHttpError
 * or an object carrying the GOVERNED_CLIENT_ERROR brand; for anything else it keeps the status but
 * REPLACES the body with the route's generic fallback. So a partner blocked from taking work, or an
 * ops agent refused a hold lift, got "Unable to save provider service rate" — and the sentence
 * naming which check had lapsed, which is the only actionable part, was the part thrown away.
 *
 * This is the same class as the systemic redaction swept out of the money and partner engines. It
 * executes the real engine, throws the real refusal, and pushes it through the real authError.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";

installWorkersHooks("__ASSIGNMENT_REFUSAL_DB__");

const FALLBACK = "Unable to complete this provider action";

/** Push a real thrown refusal through the real authError, exactly as a route's catch block does. */
async function throughAuthError(run) {
  const { authError } = await import("../lib/server-auth.ts");
  try {
    await run();
  } catch (error) {
    const response = authError(error, FALLBACK);
    return { status: response.status, body: await response.json() };
  }
  throw new Error("the engine did not refuse - this test needs a refusal to measure");
}

async function world() {
  const harness = freshCountingD1();
  globalThis.__ASSIGNMENT_REFUSAL_DB__ = harness.db;
  enterWorkersDbScope(harness.db);
  return harness;
}

test("ASSIGN-REFUSE-1: a missing reason on a hold lift keeps its own 400 and its own sentence", async () => {
  await world();
  const { clearProviderVerificationHold } = await import("../lib/provider-assignment-eligibility.ts");
  const result = await throughAuthError(() => clearProviderVerificationHold(globalThis.__ASSIGNMENT_REFUSAL_DB__, {
    providerId: "PRV-HOLD-1", actorId: "ops@pawspace.in", reason: "x",
  }));
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "A clear reason is required to lift a verification hold");
  assert.notEqual(result.body.error, FALLBACK, "the route fallback means authError discarded the reason");
});

test("ASSIGN-REFUSE-2: a hold that cannot be lifted keeps its own 409 and names the blocker", async () => {
  await world();
  const { clearProviderVerificationHold } = await import("../lib/provider-assignment-eligibility.ts");
  const result = await throughAuthError(() => clearProviderVerificationHold(globalThis.__ASSIGNMENT_REFUSAL_DB__, {
    providerId: "PRV-NOBODY", actorId: "ops@pawspace.in", reason: "documents re-verified today",
  }));
  assert.equal(result.status, 409, "an unmet precondition is a business rule, not a fault");
  assert.equal(result.body.error,
    "This provider's mandatory verification is still not current, so the hold cannot be lifted",
    "the operator needs the reason the lift was refused, which the generic fallback removed");
  assert.notEqual(result.body.error, FALLBACK);
});

test("ASSIGN-REFUSE-3: every refusal in the engine is marked, so none can silently go back to a 500 body", async () => {
  // The guard against the fix regressing one throw at a time: a bare `throw Response.json(` here is
  // exactly what shipped, and is invisible at runtime until an operator reads the wrong message.
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync("lib/provider-assignment-eligibility.ts", "utf8"));
  const bare = [...source.matchAll(/throw Response\.json\(/g)];
  assert.deepEqual(bare.map(() => "unmarked refusal"), [],
    "wrap it in markGovernedHttpError so authError keeps the body, not just the status");
  const marked = [...source.matchAll(/markGovernedHttpError\(Response\.json\(/g)];
  assert.equal(marked.length, 5, "the engine has five refusals; all five must stay marked");
});
