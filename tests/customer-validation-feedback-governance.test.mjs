import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, globSync } from "node:fs";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// Validation feedback that reached the customer as a generic failure.
//
// authError only lets a 4xx body through when the response was created by the governed factory; any
// other thrown Response is logged as "ungoverned client error redacted" and replaced with the route's
// own fallback string. Four customer routes threw a plain Response for "no verified customer identity",
// so a signed-out visitor tapping Pay securely was told "Unable to open payment" - which reads as the
// payment system having failed, not as "sign in". Same for a doorstep address whose coordinates could
// not be resolved, and for a Training session lost to a concurrent change.
//
// The redaction itself is correct and stays: a cross-origin block still refuses to explain itself. What
// changes is which of these messages are marked caller-safe. Executed through the real authError.
// ---------------------------------------------------------------------------

const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const auth = await import("../lib/server-auth.ts");
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** What the caller actually receives: authError applied to a thrown value, then its JSON body. */
async function surfaced(thrown, fallback) {
  const response = auth.authError(thrown, fallback);
  return { status: response.status, body: await response.json() };
}

test("an ungoverned 4xx is still redacted to the route's fallback", async () => {
  const { status, body } = await surfaced(new Response("Verified customer identity is required", { status: 401 }), "Unable to open payment");
  assert.equal(status, 401);
  assert.equal(body.error, "Unable to open payment",
    "this is the behaviour that hid the real reason - it is correct in general, which is why the fix is to govern the message rather than to weaken authError");
});

test("a governed 4xx reaches the customer intact", async () => {
  const message = "A verified customer sign-in is required before a payment can be opened. Sign in and try again.";
  const { status, body } = await surfaced(auth.authFailure(message, 401), "Unable to open payment");
  assert.equal(status, 401);
  assert.equal(body.error, message, "the actionable message must survive authError");
  assert.notEqual(body.error, "Unable to open payment");
});

test("a governed 409 validation message reaches the customer intact", async () => {
  const message = "The doorstep address could not be resolved to verified map coordinates. Re-pick the address or move the pin, then save again.";
  const { status, body } = await surfaced(auth.authFailure(message, 409), "Unable to save the service location");
  assert.equal(status, 409);
  assert.equal(body.error, message);
});

test("governed errors are never cached", async () => {
  const response = auth.authFailure("Sign in and try again.", 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("a 5xx is redacted whether or not anyone marked it", async () => {
  const { status, body } = await surfaced(new Error("D1_ERROR: near \"SELCT\""), "Unable to open payment");
  assert.equal(status, 500);
  assert.equal(body.error, "Unable to open payment", "internal failures must never describe themselves");
});

test("NO customer route throws the identity refusal ungoverned any more", () => {
  // Swept by directory rather than by a list, because the first pass fixed only the four routes the
  // frontend audit reached and left seven more carrying the identical defect - including
  // pet-emergency, where a signed-out customer was told "Unable to raise emergency request".
  const routes = globSync("app/api/**/route.ts", { cwd: new URL("../", import.meta.url) });
  assert.ok(routes.length > 100, `expected the api route tree, found ${routes.length}`);

  const ungoverned = routes.filter((path) => /throw new Response\("Verified customer identity is required"/.test(read(path)));
  assert.deepEqual(ungoverned, [],
    `these still redact the sign-in reason behind a generic failure: ${ungoverned.join(", ")}`);

  const governed = routes.filter((path) => /throw authFailure\("A verified customer sign-in is required/.test(read(path)));
  assert.ok(governed.length >= 11,
    `expected every customer-identity refusal to be governed, found ${governed.length}: ${governed.join(", ")}`);
});

test("no customer route lets the request body decide which identity source is consulted", () => {
  // CodeQL (user-controlled bypass of a security check) on 11 routes. Each resolved the platform
  // session ONLY when the body did not name a customer:
  //     session = requestedCustomerId ? null : await resolvePlatformSession(db, request)
  // requireCustomerOwnership ran unconditionally after it and refuses any customer id not bound to the
  // caller, so this was a shape problem rather than an open door - but a request field steering the
  // identity path is worth removing, and the alert blocks the merge.
  const routes = globSync("app/api/**/route.ts", { cwd: new URL("../", import.meta.url) });
  const conditional = routes.filter((path) => /requestedCustomerId\?null:await resolvePlatformSession/.test(read(path)));
  assert.deepEqual(conditional, [],
    `these let user input choose the identity source: ${conditional.join(", ")}`);

  // Every route that resolves an owned customer context must now do all three things.
  const owning = routes.filter((path) => /async function ownedContext/.test(read(path)));
  assert.ok(owning.length >= 11, `expected the owned-context routes, found ${owning.length}`);
  for (const path of owning) {
    const src = read(path);
    assert.match(src, /session=await resolvePlatformSession\(db,request\)/, `${path}: session must always resolve`);
    assert.match(src, /requested\|\|sessionCustomerId/, `${path}: the session is the fallback, not a branch`);
    assert.match(src, /if\(requested&&sessionCustomerId&&requested!==sessionCustomerId\)throw authFailure\("Customer ownership denied",403\)/,
      `${path}: a signed-in customer may name only themselves`);
    assert.match(src, /await requireCustomerOwnership\(db,actor,customerId\)/, `${path}: ownership stays the real boundary`);
  }
});

test("a refusal on a shared GET/POST helper does not claim a write happened", () => {
  // ownedContext backs both verbs in these routes, so "before this can be saved" was wrong on a read.
  for (const path of ["app/api/customer-account/route.ts", "app/api/service-review/route.ts", "app/api/customer-support-case/route.ts"]) {
    const source = read(path);
    assert.match(source, /export async function GET/, path);
    assert.match(source, /export async function POST/, path);
    assert.doesNotMatch(source, /sign-in is required before this can be saved/,
      `${path} serves GET from the same helper, so it must not say the read could not be saved`);
  }
});

test("the doorstep and Training stale-state refusals are governed too", () => {
  assert.match(read("app/api/grooming-service-location/route.ts"), /throw authFailure\("The doorstep address could not be resolved/);
  assert.match(read("app/api/training-sessions/route.ts"), /throw authFailure\("This Training booking changed while the session was being completed/);
});

test("cross-origin blocks stay deliberately unexplained", () => {
  // A CSRF refusal has nothing useful to tell the caller and should not describe the check it failed.
  for (const path of [
    "app/api/payment-order/route.ts",
    "app/api/customer-account/route.ts",
    "app/api/provider-workspace/route.ts",
  ]) {
    assert.match(read(path), /throw new Response\("Cross-origin/, `${path} must keep its cross-origin block ungoverned`);
  }
});
