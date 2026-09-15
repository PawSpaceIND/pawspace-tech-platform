/*
 * A replacement walker can accept the offer.
 *
 * app/driver/canonical-driver-page.tsx offers a Pet Taxi driver, when the booking sits at
 * `reassignment_offered`, a link to /driver/recovery?bookingId=… labelled "Accept replacement recovery
 * offer →". The Dog Walking workspace had no equivalent. /walker/recovery existed, rendered, called
 * acceptWalkingReplacement and worked - and nothing anywhere in app/, lib/ or worker/ contained its
 * path, so the only way a replacement walker could accept a booking offered to them was to be told the
 * URL by hand. tests/w2d-route-reachability.test.mjs froze it in its baseline as a deep-link target;
 * it is not one, it is a blocked flow.
 *
 * WHAT THIS ASSERTS. Not that the source contains a string - the real page function is executed with
 * the real lifecycle client against a stubbed /api/walking-lifecycle, and the rendered markup is read:
 *
 *   1. In `reassignment_offered`, the accept path is reachable FROM THE WALKER WORKSPACE, carrying the
 *      booking id, and /walker/recovery renders an accept control that posts to /api/walking-recovery.
 *   2. In `assigned` - a walk in flight, no offer standing - the accept path is not on screen at all.
 *      A recovery offer shown when none stands is an invitation to reassign a booking that nobody
 *      offered, so absence is asserted as hard as presence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { mount, find, all, textOf } from "./helpers/customer-ui-harness.mjs";

installWorkersHooks("__W2H_WALKER_DB__");

/*
 * lib/use-query-parameter.ts reads window.location.search through useSyncExternalStore and supplies a
 * getServerSnapshot that returns "". The harness renders the server snapshot, so a page driven by
 * ?bookingId= would render its empty entry screen no matter what URL was set. The hook is therefore
 * replaced with one that reads a global this suite controls: the code under test is the PAGE, not the
 * hook (tests/provider-query-hydration.test.mjs owns the hook), and this is the same technique
 * tests/w2d-hub-links-render.test.mjs uses for next/navigation.
 */
const QUERY_STUB = `data:text/javascript,${encodeURIComponent(
  'export const useQueryParameter=(name)=>(globalThis.__W2H_QUERY__||{})[name]||"";',
)}`;
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith("/use-query-parameter") || specifier.endsWith("/use-query-parameter.ts")) {
      return { url: QUERY_STUB, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const WalkerPage = (await import("../app/walker/page.tsx")).default;
const WalkerRecoveryPage = (await import("../app/walker/recovery/page.tsx")).default;

const BOOKING_ID = "UATD-BK-WALK-1";

/** One canonical walking booking, in whatever lifecycle state the case under test needs. */
const booking = (status) => ({
  id: BOOKING_ID, status, provider_id: "PRV-WALK-1", provider_name: "Replacement walker",
  customer_id: "CUS-1", pets: [{ id: "PET-1", name: "Simba", species: "dog" }],
  sessions: [{ id: "WSN-1", status: "scheduled", scheduled_start: "2026-09-16T07:00:00.000Z", scheduled_end: "2026-09-16T07:30:00.000Z", handover_status: "pending", completion_status: "pending" }],
  sessionPayments: [], events: [],
});

/** Answers the endpoints the walker workspace reads, and records what was POSTed. */
function stubApi(status) {
  const original = globalThis.fetch;
  const posted = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(typeof input === "string" ? input : input?.url ?? input);
    if (init.method === "POST") { posted.push({ url, body: JSON.parse(String(init.body || "{}")) }); return { ok: true, status: 200, text: async () => JSON.stringify({ data: { status: "assigned", remainingSessions: 1 } }), json: async () => ({ data: { status: "assigned", remainingSessions: 1 } }) }; }
    if (url.includes("/api/walking-lifecycle")) {
      const payload = JSON.stringify({ data: [booking(status)] });
      return { ok: true, status: 200, text: async () => payload, json: async () => JSON.parse(payload) };
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: `no stub for ${url}` }), json: async () => ({ error: `no stub for ${url}` }) };
  };
  return { posted, restore: () => { globalThis.fetch = original; } };
}

/** Render the REAL walker workspace at ?bookingId=…, in the given booking state. */
async function renderWalker(status) {
  globalThis.__W2H_QUERY__ = { bookingId: BOOKING_ID };
  const api = stubApi(status);
  try {
    const rendered = mount(WalkerPage, {}, { label: `/walker (${status})` });
    await rendered.settle();
    return { html: rendered.html(), tree: rendered.tree(), posted: api.posted };
  } finally { api.restore(); }
}

const RECOVERY_HREF = `/walker/recovery?bookingId=${encodeURIComponent(BOOKING_ID)}`;

test("W2H-WALKER-1: a walker offered a replacement booking can reach the accept screen from their workspace", async () => {
  const offered = await renderWalker("reassignment_offered");

  // The whole point: the accept path is ON SCREEN, and it carries the booking it refers to. Without
  // the id /walker/recovery renders "Open with a canonical bookingId" and accepts nothing.
  assert.ok(offered.html.includes(`href="${RECOVERY_HREF}"`),
    "a walker whose booking sits at reassignment_offered must be offered the accept path, with the booking id");

  const link = find(offered.tree, (node) => node?.props?.href === RECOVERY_HREF);
  assert.ok(link, "the accept path is a real link element in the rendered tree, not a string in the markup");
  assert.match(textOf(link), /Accept replacement recovery offer/,
    "it must read as accepting the offer, the same wording the Pet Taxi driver workspace uses");

  // The workspace is still the workspace: the offer does not replace the schedule it refers to.
  assert.match(offered.html, /CANONICAL DOG WALKING/, "the offer is shown inside the walker workspace, not instead of it");
});

test("W2H-WALKER-2: and the destination it reaches really accepts the replacement", async () => {
  /*
   * The outcome, not the link. A reachable link to a screen that cannot accept is still a blocked
   * flow, so /walker/recovery is rendered from the same booking id and its control is clicked: the
   * assertion is that POST /api/walking-recovery went out for THIS booking and the walker was told the
   * remaining schedule is theirs.
   */
  globalThis.__W2H_QUERY__ = { bookingId: BOOKING_ID };
  const api = stubApi("reassignment_offered");
  try {
    const rendered = mount(WalkerRecoveryPage, {}, { label: "/walker/recovery" });
    await rendered.settle();
    const accept = all(rendered.tree(), (node) => node?.type === "button").find((node) => /Accept remaining walk schedule/.test(textOf(node)));
    assert.ok(accept, "/walker/recovery offers the accept control");
    assert.equal(accept.props.disabled, false, "and it is usable, not disabled, for a booking that carries an id");
    await accept.props.onClick();
    await rendered.settle();
    assert.deepEqual(api.posted.map((call) => call.url), ["/api/walking-recovery"],
      "accepting must call the walking recovery endpoint and nothing else");
    assert.equal(api.posted[0].body.bookingId, BOOKING_ID, "for the booking the walker was offered");
    assert.match(rendered.html(), /Replacement accepted/, "and the walker is told the remaining schedule is theirs");
  } finally { api.restore(); }
});

test("W2H-WALKER-3: no offer standing, no accept path", async () => {
  // `assigned` is a walk already accepted and in flight - the state a walker is in most of the time.
  const assigned = await renderWalker("assigned");
  assert.ok(!assigned.html.includes("/walker/recovery"),
    "a walker with no replacement offer must not be shown a way to accept one");
  assert.equal(find(assigned.tree, (node) => typeof node?.props?.href === "string" && node.props.href.startsWith("/walker/recovery")), undefined,
    "not as a link element either");
  // The control that IS legitimate in this state still renders, so the case is not passing because
  // the page failed to render at all.
  assert.ok(assigned.html.includes("/walker/proof?bookingId="), "the walk-in-flight workspace still renders its own route & proof link");
});
