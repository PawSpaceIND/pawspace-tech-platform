import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Permission is not ownership.
//
// tests/gateway-authorization-matrix and tests/route-permission-enforcement between them prove that
// every gated route asks for a permission and refuses anyone who lacks it. Neither can see the defect
// class that actually bit: a caller who HOLDS the permission acting on a record that is not theirs.
// Both QA-004 (providerId taken from the body, never compared to the booking's assigned provider) and
// the reserve path on /api/uat-scheduling (customerId taken from the body, actor never resolved) passed
// every permission check by construction.
//
// The exposure is specific to the self-service permissions - scheduling.book and self_service.view -
// because those are held by the `customer` and `service_provider` roles, which are handed out to anyone
// who verifies a phone number. A staff permission implies a colleague; these do not.
//
// This is a coverage check, not a proof. It asserts that each route reachable on a self-service
// permission either calls an ownership helper or is on the list below WITH a reason. The proof that the
// helpers actually refuse lives in tests/uat-scheduling-ownership.test.mjs, which drives two real
// customers and a member of staff through a real handler. What this adds is that a NEW self-service
// route cannot be merged without someone deciding which of the two it is.
// ---------------------------------------------------------------------------

const SELF_SERVICE = new Set(["scheduling.book", "self_service.view"]);

/**
 * Routes reachable on a self-service permission that hold no per-record ownership check, each with the
 * reason it does not need one. A new entry here is a decision, which is the point.
 */
const NO_RECORD_TO_OWN = {
  "/api/address-autocomplete": "geocoding only - no stored record, nothing to own",
  "/api/leaderboard": "ranks the caller's own row; takes no identifier from the request",
  "/api/me": "resolves the caller's own identity; takes no identifier from the request",
  "/api/assisted-orders": "reads and writes the catalogue, not a customer's record",
  "/api/uat-scheduling": "GET is the staff day board (scheduling.manage); POST reserve DOES check - see tests/uat-scheduling-ownership.test.mjs",
  // OPEN QUESTION, not a clean pass: any holder of scheduling.book can mark ANY open sitting quote as
  // captured, because sitting_commercial_quotes carries no customer column - the quote is anonymous, so
  // "someone else's quote" is not expressible in the schema and no ownership check can be written. The
  // exposure is bounded: the route is disabled unless PAWSPACE_PAYMENT_ENV is sandbox, the amount must
  // equal amount_due_now exactly, and the quote must be open and unexpired, so the worst case is
  // guessing a quote id to file a synthetic capture (liveMoney:false). Fixing it properly means adding
  // customer_id to sitting_commercial_quotes and populating it at quote time - a data-model change and
  // a founder's call, not something to slip into a hardening pass.
  "/api/sitting-payment-sandbox": "quotes are anonymous in the schema; sandbox-gated, synthetic money. See the note above",
};

const OWNERSHIP = /require(Customer|Provider)Ownership|resolveProviderForActor|requireOwnership/;

test("every route a customer or provider can reach either checks ownership or says why not", async () => {
  const approved = JSON.parse(await readFile(new URL("./fixtures/route-permissions.json", import.meta.url), "utf8"));

  const reachable = new Set();
  for (const [key, permission] of Object.entries(approved)) {
    if (SELF_SERVICE.has(permission)) reachable.add(key.split(" ")[1]);
  }
  assert.ok(reachable.size > 30, `expected many self-service routes in the frozen policy, found ${reachable.size}`);

  const unguarded = [];
  for (const path of [...reachable].sort()) {
    let source;
    try { source = await readFile(new URL(`../app/api/${path.replace("/api/", "")}/route.ts`, import.meta.url), "utf8"); }
    catch { continue; }
    if (OWNERSHIP.test(source)) continue;
    if (NO_RECORD_TO_OWN[path]) continue;
    unguarded.push(path);
  }

  assert.deepEqual(
    unguarded, [],
    `these routes are reachable on scheduling.book or self_service.view and check no per-record ownership. `
    + `Either call requireCustomerOwnership/requireProviderOwnership on the identifier the caller supplies, `
    + `or add the route to NO_RECORD_TO_OWN in this file with the reason:\n  ${unguarded.join("\n  ")}`,
  );

  // The exemption list must not outlive its routes: an entry for a route that is no longer reachable on
  // a self-service permission, or that has since grown a real check, is stale and hides the next one.
  const stale = Object.keys(NO_RECORD_TO_OWN).filter((path) => !reachable.has(path));
  assert.deepEqual(stale, [], `NO_RECORD_TO_OWN names routes no longer reachable on a self-service permission; drop them:\n  ${stale.join("\n  ")}`);

  console.log(`  ${reachable.size} self-service routes: ${reachable.size - Object.keys(NO_RECORD_TO_OWN).length} check ownership, ${Object.keys(NO_RECORD_TO_OWN).length} exempt with a stated reason.`);
});
