/**
 * The Booking Command Center's list loads. [staging master E2E run 36243387701 row 40; run 36224833520 row 29]
 *
 * MEASURED, row 40: the staff page stayed on "Loading connected booking records…" with "—" in every
 * metric and never showed the Training booking the E2E searched for. The ?q= search is a silent load and
 * `loading` was cleared only by the non-silent first snapshot, which took ~49 s on staging, so the
 * search result - back in about a second - stayed hidden behind it.
 * MEASURED, row 29 (pre-merge): "not found: PS-UAT-MUI1G6RX-471E" with "Total bookings 150" on screen and
 * the searched booking selected. The late 150-row snapshot landed after the search and replaced it:
 * whichever response arrived last won.
 *
 * The page now numbers its loads through app/booking-command-center/load-sequence.ts. The scenarios
 * below drive the real sequencer and apply its decisions the way page.tsx does; the last test pins that
 * page.tsx applies them exactly so.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createBookingLoadSequence } from "../app/booking-command-center/load-sequence.ts";

const SNAPSHOT = ["150 newest bookings"], SEARCH = ["PS-UAT-MUIEU776-D897"], LATER = ["after the change"];

/** The page's list state, changed only as page.tsx changes it from the sequencer's decisions. */
function page() {
  const sequence = createBookingLoadSequence();
  const state = { loading: true, error: "", rows: [], refreshes: 0 };
  function settle(ticket, succeeded, value) {
    const outcome = sequence.settle(ticket, succeeded);
    if (outcome.apply && succeeded) { state.rows = value; state.error = ""; }
    else if (outcome.apply) state.error = value;
    if (outcome.endLoading) state.loading = false;
    outcome.heldRefresh?.();
    return outcome;
  }
  function load(silent) {
    const ticket = sequence.begin(silent);
    if (!silent) state.loading = true;
    state.error = "";
    return { resolve: (rows) => settle(ticket, true, rows), reject: (message) => settle(ticket, false, message) };
  }
  const refreshed = [];
  const streamEvent = () => sequence.streamRefresh(() => { state.refreshes += 1; refreshed.push(load(true)); });
  return { state, load, streamEvent, refreshed };
}

test("row 40: a search result shows while the first snapshot is still loading", () => {
  const p = page();
  p.load(false);
  const search = p.load(true);
  assert.equal(p.state.loading, true);
  search.resolve(SEARCH);
  assert.equal(p.state.loading, false, "a successful silent load ends `loading` too, so the list renders");
  assert.deepEqual(p.state.rows, SEARCH);
});

test("row 29: the late first snapshot does not replace the newer search result", () => {
  const p = page();
  const first = p.load(false), search = p.load(true);
  search.resolve(SEARCH);
  const late = first.resolve(SNAPSHOT);
  assert.equal(late.apply, false, "the older response is dropped");
  assert.deepEqual(p.state.rows, SEARCH);
  assert.equal(p.state.loading, false);
});

test("responses that arrive in order are all applied", () => {
  const p = page();
  const first = p.load(false), search = p.load(true);
  first.resolve(SNAPSHOT);
  assert.deepEqual(p.state.rows, SNAPSHOT);
  assert.equal(p.state.loading, false);
  search.resolve(SEARCH);
  assert.deepEqual(p.state.rows, SEARCH);
});

test("errors: an older failure never hides newer rows; a newer failure shows; data still beats an older error", () => {
  const p = page();
  const older = p.load(true), newer = p.load(true);
  newer.resolve(SEARCH);
  assert.equal(older.reject("Unable to load bookings").apply, false);
  assert.equal(p.state.error, "", "the stale failure is not shown over newer rows");
  assert.deepEqual(p.state.rows, SEARCH);

  p.load(true).reject("Search failed");
  assert.equal(p.state.error, "Search failed", "a failure newer than what is on screen is shown");

  const q = page();
  const first = q.load(false), search = q.load(true);
  search.reject("Search failed");
  assert.equal(q.state.error, "Search failed");
  assert.equal(q.state.loading, true, "a failed silent load leaves the pending first snapshot's `loading` alone");
  first.resolve(SNAPSHOT);
  assert.deepEqual(q.state.rows, SNAPSHOT, "the snapshot still arrives: only a success marks what is on screen");
  assert.equal(q.state.error, "");
  assert.equal(q.state.loading, false);
});

test("a failed first load ends `loading` and shows its error", () => {
  const p = page();
  p.load(false).reject("Unable to load bookings");
  assert.equal(p.state.loading, false);
  assert.equal(p.state.error, "Unable to load bookings");
});

test("a stale response never ends a newer load's `loading`", () => {
  const p = page();
  const first = p.load(false), search = p.load(true);
  search.resolve(SEARCH);
  const refresh = p.load(false); // "↻ Refresh snapshot"
  assert.equal(p.state.loading, true);
  first.resolve(SNAPSHOT);
  assert.equal(p.state.loading, true, "the first snapshot is older than the search on screen: it changes nothing");
  assert.deepEqual(p.state.rows, SEARCH);
  refresh.resolve(LATER);
  assert.equal(p.state.loading, false);
  assert.deepEqual(p.state.rows, LATER);
});

test("stream refreshes wait for the load in flight, then run once", () => {
  const idle = page();
  idle.streamEvent();
  assert.equal(idle.state.refreshes, 1, "with nothing in flight a stream event refreshes at once");

  const p = page();
  const first = p.load(false), search = p.load(true);
  p.streamEvent(); p.streamEvent(); p.streamEvent();
  assert.equal(p.state.refreshes, 0, "no refresh starts while loads are in flight, however many events arrive");
  first.resolve(SNAPSHOT);
  assert.equal(p.state.refreshes, 0, "one load is still in flight");
  search.resolve(SEARCH);
  assert.equal(p.state.refreshes, 1, "one refresh, once nothing is in flight, so a change seen meanwhile is not lost");
  p.streamEvent();
  assert.equal(p.state.refreshes, 1, "that refresh is itself in flight");
  p.refreshed[0].resolve(LATER);
  assert.deepEqual(p.state.rows, LATER);
  assert.equal(p.state.refreshes, 2);
  p.refreshed[1].resolve(LATER);
  assert.equal(p.state.refreshes, 2, "nothing further was held");
});

test("page.tsx applies the sequencer's decisions exactly as above and keeps its wiring", () => {
  const source = readFileSync(new URL("../app/booking-command-center/page.tsx", import.meta.url), "utf8");
  const load = source.slice(source.indexOf("async function load(silent = false) {"), source.indexOf("useEffect(() => { const timer"));
  assert.match(source, /import \{ createBookingLoadSequence \} from "\.\/load-sequence";/);
  assert.match(source, /const sequenceRef = useRef\(createBookingLoadSequence\(\)\);/);
  assert.match(load, /const ticket = sequenceRef\.current\.begin\(silent\);\n\s+if \(!silent\) setLoading\(true\); setError\(""\);/);
  assert.match(load, /const outcome = sequenceRef\.current\.settle\(ticket, loaded !== null\);/);
  assert.match(load, /if \(outcome\.apply && loaded\) \{[^}]*searchedRef\.current = loaded\.serverQuery;[^}]*setBookings\(next\); setError\(""\);/);
  assert.match(load, /\} else if \(outcome\.apply\) setError\(failure\);/);
  assert.match(load, /if \(outcome\.endLoading\) setLoading\(false\);/);
  assert.match(load, /outcome\.heldRefresh\?\.\(\);/);
  assert.equal(load.match(/setBookings\(/g)?.length, 1, "rows change only when the sequencer applies a response");
  assert.equal(load.match(/searchedRef\.current =/g)?.length, 1, "the searched query is recorded only with the rows it produced");
  assert.equal(load.match(/setLoading\(false\)/g)?.length, 1, "`loading` ends only on the sequencer's say-so");
  assert.doesNotMatch(load, /finally/, "no path ends `loading` for a stale response");
  assert.match(source, /const refresh = \(\) => \{ sequenceRef\.current\.streamRefresh\(\(\) => \{ void load\(true\); \}\); \};/);
  assert.match(source, /events\.addEventListener\("booking", refresh\)/);
  assert.equal(source.match(/onClick=\{\(\) => void load\(\)\}/g)?.length, 2, "Refresh snapshot and Try again still reload");
  assert.match(source, /\/api\/booking-command-center\?q=\$\{encodeURIComponent\(serverQuery\)\}/);
});
