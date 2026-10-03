import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1 } from "./helpers/taxi-harness.mjs";

// UAT checklist A4/D12: a customer who reopens the owned recovery URL (/v2/booking?bookingId=) after
// the app was killed, or after the OTP session expired, used to see a load failure with only "Retry
// booking". On a UAT-enabled staging the failure text was the STAFF sign-in copy, because the checkout
// API resolves the actor before its own customer-worded session check. The page now asks the V2 session
// client first and, for a guest, renders the embedded customer OTP login in place: the URL never changes,
// so the exact booking reopens after verification. An ownership refusal for a signed-in customer stays a
// retryable load error, never a sign-in prompt. The payment API/client are untouched.
installWorkersHooks("__V2_BOOKING_GUEST_DB__", "__V2_BOOKING_GUEST_ENV__");

const PAGE = new URL("../app/v2/booking/page.tsx", import.meta.url);
const pageSource = () => readFileSync(PAGE, "utf8");

/** The page's booking-load effect, verbatim, so it runs here without React or a TSX transpiler. */
function bookingLoadEffect() {
  const match = /useEffect\(\(\)=>\{(.*?)\},\[bookingId,attempt\]\);/s.exec(pageSource());
  assert.ok(match, "the booking-load effect must be keyed on [bookingId,attempt]");
  return match[1];
}

async function runEffect({ bookingId, session, projection }) {
  const calls = { identity: [], record: [], error: [], projectionFor: [] };
  // The effect runs in its own realm; share Error so its `instanceof Error` check sees this realm's errors.
  const sandbox = {
    AbortController,
    Error,
    queueMicrotask,
    bookingId,
    setRecord: value => calls.record.push(value),
    setError: value => calls.error.push(value),
    setTrainingReady: () => {},
    setIdentity: value => calls.identity.push(value),
    loadV2CustomerSession: async () => session(),
    loadCustomerConfirmationProjection: async (id, signal) => { calls.projectionFor.push(id); assert.ok(signal instanceof AbortSignal); return projection(); },
  };
  runInNewContext(`(() => {${bookingLoadEffect()}})()`, sandbox);
  await new Promise(resolve => setTimeout(resolve, 20));
  return calls;
}

test("a signed-out (or expired) customer becomes a guest and the owned projection is never requested", async () => {
  const calls = await runEffect({ bookingId: "PS-UAT-GUEST-1", session: () => null, projection: () => { throw new Error("must not be called"); } });
  assert.deepEqual(calls.identity.at(-1), "guest");
  assert.deepEqual(calls.projectionFor, [], "no checkout API read as a guest, so no staff sign-in copy can reach the page");
  assert.deepEqual(calls.error, [""], "a guest is not a load error");
});

test("a signed-in customer loads the exact booking from the URL and the record renders", async () => {
  const record = { bookingId: "PS-UAT-OWNED-1", bookingStatus: "payment_pending" };
  const calls = await runEffect({ bookingId: "PS-UAT-OWNED-1", session: () => ({ subjectType: "customer", subjectId: "C-1" }), projection: () => record });
  assert.equal(calls.identity.at(-1), "customer");
  assert.deepEqual(calls.projectionFor, ["PS-UAT-OWNED-1"], "the recovery URL's own booking id is read, nothing else");
  assert.equal(calls.record.at(-1), record);
});

test("an ownership refusal for a signed-in customer stays a retryable error, never a guest login", async () => {
  const calls = await runEffect({ bookingId: "PS-UAT-OTHER-1", session: () => ({ subjectType: "customer", subjectId: "C-2" }), projection: () => { throw new Error("You can only open your own bookings."); } });
  assert.equal(calls.identity.at(-1), "customer");
  assert.deepEqual(calls.error.at(-1), "You can only open your own bookings.");
  assert.deepEqual(calls.record.filter(Boolean), [], "only the effect's own reset to null, never another customer's record");
});

test("a session read failure that is not a sign-out is reported as a load error", async () => {
  const calls = await runEffect({ bookingId: "PS-UAT-X", session: () => { throw new Error("We could not reach the server."); }, projection: () => { throw new Error("must not be called"); } });
  assert.equal(calls.identity.at(-1), "unknown");
  assert.equal(calls.error.at(-1), "We could not reach the server.");
});

test("the V2 session client turns 401 into a guest and keeps a 403 ownership refusal as an error", async () => {
  const { loadV2CustomerSession } = await import("../lib/v2/customer-experience-client.ts");
  const answers = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => answers.shift();
  try {
    answers.push(new Response(JSON.stringify({ error: "Your staging sign-in has expired. Open /staging-login to sign in again." }), { status: 401 }));
    assert.equal(await loadV2CustomerSession(), null, "401 means guest, whatever the body says");
    answers.push(new Response(JSON.stringify({ data: { subjectType: "customer", subjectId: "C-9" } }), { status: 200 }));
    assert.deepEqual(await loadV2CustomerSession(), { subjectType: "customer", subjectId: "C-9" });
    answers.push(new Response(JSON.stringify({ error: "Permission denied" }), { status: 403 }));
    await assert.rejects(loadV2CustomerSession(), /Permission denied/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("why the gate exists: an anonymous actor on a UAT-enabled staging is refused with the STAFF sign-in copy", async () => {
  globalThis.__V2_BOOKING_GUEST_DB__ = makeD1(freshSqlite());
  // Test-only values at the module's documented floor; not credentials.
  globalThis.__V2_BOOKING_GUEST_ENV__ = { PAWSPACE_UAT_LOGIN: "on", PAWSPACE_UAT_SIGNING_KEY: "x".repeat(32), PAWSPACE_UAT_ACCESS_CODE: "y".repeat(32) };
  const { ensureSecurityTables, resolveActor } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(globalThis.__V2_BOOKING_GUEST_DB__);
  let refusal = null;
  try { await resolveActor(new Request("https://staging.example/api/customer-checkout?bookingId=PS-X")); } catch (error) { refusal = error; }
  assert.ok(refusal instanceof Response && refusal.status === 401);
  assert.match(String((await refusal.json()).error), /staging sign-in has expired/, "this copy must never be what a customer sees on /v2/booking");
});

test("the guest branch renders the embedded customer login in place, before the error branch, without leaving the URL", () => {
  const source = pageSource();
  assert.match(source, /import \{loadV2CustomerSession\} from "\.\.\/\.\.\/\.\.\/lib\/v2\/customer-experience-client";/, "the session comes from the V2 client boundary");
  assert.match(source, /import CustomerLogin from "\.\.\/\.\.\/mobile-app\/customer-login";/, "the same embedded OTP login the Grooming and Taxi guest branches use");
  const guest = source.indexOf('identity==="guest"?<section');
  const errorBranch = source.search(/error\?<section[^>]*><p role="alert">\{error\}<\/p><button onClick=\{\(\)=>setAttempt/);
  assert.ok(guest > 0 && errorBranch > guest, "guest login is decided before a load error is shown");
  assert.match(source, /<CustomerLogin embedded onLoggedIn=\{\(\)=>setAttempt\(x=>x\+1\)\}\/>/, "login reloads the same booking id in place");
  assert.doesNotMatch(source, /staging-login|\/mobile-app"|window\.location|useRouter/, "no redirect: the recovery URL is preserved exactly");
  assert.match(source, /Retry booking/, "the load-error retry is unchanged");
});
