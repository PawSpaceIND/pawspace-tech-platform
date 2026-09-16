/**
 * PTJA-P1-F38 / PTJA-P2-F39 — the travelling pet, the preselected dog, and the clock they are shown on.
 *
 * MEASURED IN A BROWSER on an account with two pets (Bruno the dog, AuditCat the cat):
 *   /taxi rendered no pet control at all — {"mentionsBruno":false,"mentionsAuditCat":false}
 *   and every trip bound to the first pet regardless:
 *     POST /api/taxi-bookings -> 201 {... "petIds":["E2E-PET-UI-001"]}  (twice, both Bruno)
 *   /walking loaded with "Choose the dog you want to book this walk for." already showing, on an
 *   account whose only real option was its single dog, and re-asked for a blank "Address Line 1 *"
 *   although the customer had a saved default address.
 *   Both confirmations printed the appointment in the BROWSER's timezone: 11:00 IST read back as
 *   "17/9/2026, 5:30:00 am".
 *
 * WHY THIS FILE RENDERS RATHER THAN READS SOURCE. A source-text assertion ("the file contains
 * selectedPetId") passes against a control that is never rendered, never reaches the request body,
 * and never reaches the confirmation — which is exactly the three-part shape of the defect. So the
 * REAL page components are mounted here and driven: the account arrives over the mocked fetch the
 * page itself issues, the customer's choice goes through the real <select>'s own onChange, the
 * booking goes through the real click handler, and the assertions are on the rendered output and on
 * the request body the page actually sent.
 *
 * react-dom/server cannot do that on its own: it runs no effects, so a page whose pets arrive from
 * `loadCustomerAccount()` never leaves its loading state under renderToStaticMarkup (see the note in
 * tests/ptja-p1-fixture-identity.test.mjs, which had to fall back to source text for exactly this
 * reason), and there is no jsdom in this repository. `mount()` below closes that gap without adding a
 * dependency: it installs a hook dispatcher into React's client internals — the same seam react-dom
 * itself uses — so the component's own useState/useEffect/useMemo run, effects are flushed, state
 * updates re-render, and the committed tree is handed to renderToStaticMarkup for the markup
 * assertions. Nested components (Link, Button, AddressPicker) are rendered by react-dom/server as
 * before.
 */
process.env.TZ = "America/New_York"; // Deliberately NOT IST: see the timezone test at the bottom.

import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PET_SELECTION_DB__");

const React = (await import("react")).default;
const { renderToStaticMarkup } = await import("react-dom/server");
const ReactInternals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

// --------------------------------------------------------------------------------------------
// Minimal client-component harness: real hooks, real effects, real state transitions.
// --------------------------------------------------------------------------------------------
const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

function mount(Component, props = {}) {
  const cells = [];
  const pendingEffects = [];
  let cursor = 0, tree = null, rendering = false, scheduled = false, destroyed = false;

  const cell = (seed) => (cells[cursor] ?? (cells[cursor] = seed()));
  const dispatcher = {
    useState(initial) {
      const slot = cell(() => ({ value: typeof initial === "function" ? initial() : initial }));
      const at = cursor++;
      return [slot.value, (next) => {
        const current = cells[at].value, value = typeof next === "function" ? next(current) : next;
        if (Object.is(value, current)) return;
        cells[at].value = value;
        schedule();
      }];
    },
    useReducer(reducer, initialArg, init) {
      const slot = cell(() => ({ value: init ? init(initialArg) : initialArg }));
      const at = cursor++;
      return [slot.value, (action) => {
        const value = reducer(cells[at].value, action);
        if (Object.is(value, cells[at].value)) return;
        cells[at].value = value;
        schedule();
      }];
    },
    useMemo(factory, deps) {
      const slot = cell(() => ({ first: true, deps: undefined, value: undefined }));
      if (slot.first || !sameDeps(slot.deps, deps)) { slot.value = factory(); slot.deps = deps; slot.first = false; }
      cursor++;
      return slot.value;
    },
    useCallback(fn, deps) { return dispatcher.useMemo(() => fn, deps); },
    useRef(initial) { const slot = cell(() => ({ value: { current: initial } })); cursor++; return slot.value; },
    useEffect(effect, deps) {
      const slot = cell(() => ({ first: true, deps: undefined, cleanup: undefined }));
      if (slot.first || !sameDeps(slot.deps, deps)) {
        slot.deps = deps; slot.first = false;
        pendingEffects.push(() => { if (typeof slot.cleanup === "function") slot.cleanup(); slot.cleanup = effect(); });
      }
      cursor++;
    },
    useLayoutEffect(effect, deps) { dispatcher.useEffect(effect, deps); },
    useContext(context) { return context._currentValue; },
    useId() { return `harness-id-${cursor++}`; },
    useDebugValue() {},
    useTransition() { return [false, (fn) => fn()]; },
    useSyncExternalStore(_subscribe, getSnapshot) { cursor++; return getSnapshot(); },
  };

  function schedule() {
    if (scheduled || destroyed) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; if (!destroyed) render(); });
  }
  function render() {
    if (rendering) throw new Error("re-entrant render in the component harness");
    rendering = true; cursor = 0;
    const previous = ReactInternals.H;
    ReactInternals.H = dispatcher;
    try { tree = Component(props); } finally { ReactInternals.H = previous; rendering = false; }
    for (const run of pendingEffects.splice(0, pendingEffects.length)) run();
  }
  render();

  const api = {
    get tree() { return tree; },
    html: () => renderToStaticMarkup(tree),
    text: () => renderToStaticMarkup(tree).replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim(),
    nodes: () => collect(tree, []),
    find: (predicate) => collect(tree, []).find(predicate) ?? null,
    findAll: (predicate) => collect(tree, []).filter(predicate),
    async flush(turns = 30) { for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0)); },
    unmount() { destroyed = true; for (const slot of cells) if (slot && typeof slot.cleanup === "function") slot.cleanup(); },
  };
  return api;
}

function collect(node, out) {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) { for (const child of node) collect(child, out); return out; }
  if (!node.props) return out;
  out.push(node);
  return collect(node.props.children, out);
}
function elementText(node) {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(elementText).join(" ");
  return node.props ? elementText(node.props.children) : "";
}
const optionsOf = (select) => collect(select.props.children, []).filter((node) => node.type === "option").map((node) => ({ value: node.props.value, label: elementText(node) }));
const petSelect = (screen) => screen.find((node) => node.type === "select" && optionsOf(node).some((option) => /Bruno|AuditCat|Rusty/.test(option.label)));
const clickable = (screen, pattern) => screen.find((node) => typeof node.props?.onClick === "function" && pattern.test(elementText(node)));

// --------------------------------------------------------------------------------------------
// Account fixtures and the endpoints these two pages actually call.
// --------------------------------------------------------------------------------------------
const pet = (id, name, species, breed) => ({ id, sourceId: null, name, species, breed, vaccinationStatus: "verified", ageYears: 3, weightKg: 12, profile: null });
const BRUNO = pet("PET-BRUNO", "Bruno", "dog", "Indie"), AUDITCAT = pet("PET-AUDITCAT", "AuditCat", "cat", "Bengal"), RUSTY = pet("PET-RUSTY", "Rusty", "dog", "Beagle");
const SAVED_ADDRESS = { id: "ADDR-1", label: "Home", line1: "42 Test Road", line2: null, area: "Indiranagar", city: "Bengaluru", postalCode: "560038", isDefault: true };
const account = (pets, addresses = [SAVED_ADDRESS]) => ({
  customerId: "CUST-PET-SELECT", cityId: "blr", name: "Asha K.", primaryPhone: "+919800000901", secondaryPhone: null, email: null,
  memberSince: 1700000000000, addresses, pets, bookings: [],
});

const TAXI_PICKUP = "2026-09-17T11:00:00+05:30";   // 11:00 IST, the instant the browser run booked.
const WALK_START = "2026-09-22T07:00:00+05:30";    // 7:00 AM IST, likewise.

function stubNetwork(record) {
  const previousFetch = globalThis.fetch, previousWindow = Object.prototype.hasOwnProperty.call(globalThis, "window") ? globalThis.window : undefined;
  globalThis.window = globalThis;
  globalThis.window.scrollTo = () => {};
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url, method = String(init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    record.push({ url, method, body });
    const path = url.split("?")[0];
    if (path === "/api/customer-account") return Response.json({ data: record.account });
    if (path === "/api/service-zone") return Response.json({ data: {
      zone: { zoneId: "blr-east", zoneName: "Bengaluru East", description: "UAT zone", color: "#123456", serviceAvailable: true },
      assignment: { pincode: "560038", zoneId: "blr-east", cityId: "blr", city: "Bengaluru", area: "Indiranagar" },
    } });
    if (path === "/api/taxi-commercial" && method === "GET") return Response.json({ data: {
      routes: [{ route_code: "taxi-blr-east-medium", name: "Bengaluru East · medium UAT route", synthetic_distance_km: 9, estimated_duration_minutes: 35, amount: 700, currency: "INR", max_pets: 1, version: 1 }],
      vehicles: [], source: "uat_catalogue", routeSource: "uat_route_class", productionMapsVerified: false, liveAvailability: false, liveMoney: false,
    } });
    if (path === "/api/taxi-commercial") return Response.json({ data: {
      quoteId: "TQ-PET-SELECT", routeCode: "taxi-blr-east-medium", routeName: "Bengaluru East · medium UAT route", routeVersion: 1,
      originLabel: body.originLabel, destinationLabel: body.destinationLabel, syntheticDistanceKm: 9, estimatedDurationMinutes: 35, petCount: 1,
      scheduledStart: TAXI_PICKUP, scheduledEnd: "2026-09-17T11:35:00+05:30", totalAmount: 700, amountDueNow: 0,
      paymentMode: "sandbox_deferred", expiresAt: Date.now() + 900000, routeSource: "uat_route_class", productionMapsVerified: false, liveMoney: false,
    } });
    if (path === "/api/walking-commercial" && method === "GET") return Response.json({ data: {
      packages: [{ package_code: "walking-30", name: "30-minute walk", duration_minutes: 30, amount_per_walk: 300, currency: "INR", max_pets: 1, version: 1 }],
      source: "uat_catalogue", availabilityMode: "uat", availabilityVerified: true, liveAvailability: false, liveMoney: false,
    } });
    if (path === "/api/walking-commercial") return Response.json({ data: {
      quoteId: "WQ-PET-SELECT", packageCode: body.packageCode, packageName: "30-minute walk", packageVersion: 1, durationMinutes: 30,
      mode: body.mode, petCount: 1, walkCount: body.walkCount, weekdays: body.weekdays ?? [], scheduledStart: WALK_START,
      scheduledEnd: "2026-09-22T07:30:00+05:30", perWalkAmount: 300, totalAmount: 300 * body.walkCount, amountDueNow: 0,
      paymentMode: "pay_after_service", expiresAt: Date.now() + 900000, liveMoney: false,
    } });
    if (path === "/api/uat-scheduling") return Response.json({ data: {
      groupId: body.clientRequestId, provider: { id: "taxi_rahul", name: "Rahul K.", model: "full_time" }, mode: "automatic",
      occurrences: [{ start: body.scheduledStart, end: body.scheduledEnd, occurrenceNumber: 1 }], explanation: [],
    } });
    if (path === "/api/taxi-bookings") return Response.json({ data: {
      bookingId: "PS-UAT-TAXI-TEST-0001", customerId: body.customer.id, petIds: body.pets.map((entry) => entry.sourceId),
      scheduleGroupId: body.scheduleGroupId, workOrderId: "WO-1", paymentId: "PAY-1", status: "confirmed",
      trip: { id: "TRIP-1", originLabel: body.originLabel, destinationLabel: body.destinationLabel, routeCode: body.routeCode,
        syntheticDistanceKm: 9, estimatedDurationMinutes: 35, scheduledStart: TAXI_PICKUP, scheduledEnd: "2026-09-17T11:35:00+05:30",
        status: "scheduled", productionMapsVerified: false },
      duplicatePrevented: false, liveMoney: false,
    } }, { status: 201 });
    if (path === "/api/walking-bookings") return Response.json({ data: {
      totalAmount: body.totalAmount, amountDueNow: 0, packageName: body.packageName, perWalkAmount: 300,
      bookingId: "PS-UAT-WALK-TEST-0001", customerId: body.customer.id, petIds: body.pets.map((entry) => entry.sourceId),
      scheduleGroupId: body.scheduleGroupId, workOrderId: "WO-2", paymentId: "PAY-2", status: "confirmed",
      sessions: [{ id: "WS-1", occurrenceNumber: 1, scheduledStart: WALK_START, scheduledEnd: "2026-09-22T07:30:00+05:30", status: "reserved" }],
      duplicatePrevented: false, liveMoney: false,
    } }, { status: 201 });
    throw new Error(`the page called an endpoint this test does not stub: ${method} ${url}`);
  };
  return () => { globalThis.fetch = previousFetch; if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; };
}

async function openPage(modulePath, pets, addresses) {
  const record = [];
  record.account = account(pets, addresses);
  const restore = stubNetwork(record);
  const { default: Page } = await import(modulePath);
  const screen = mount(Page);
  await screen.flush();
  return { screen, record, close() { screen.unmount(); restore(); } };
}
const bodyOf = (record, path) => record.filter((call) => call.url.split("?")[0] === path).map((call) => call.body);

// --------------------------------------------------------------------------------------------
// DEFECT 1 (P1) — Pet Taxi booked the customer's FIRST pet, silently.
// --------------------------------------------------------------------------------------------
test("P1-T01 /taxi gives a two-pet household the choice, and books the pet that was chosen", async () => {
  const page = await openPage("../app/taxi/canonical-taxi-page.tsx", [BRUNO, AUDITCAT]);
  try {
    const select = petSelect(page.screen);
    assert.ok(select, "the travelling pet is chosen on the page, not assumed from position 0");
    assert.notEqual(select.props.hidden, true, "and the control is actually on screen");
    const labels = optionsOf(select).map((option) => option.label).join(" | ");
    assert.match(labels, /Bruno/, "both pets on the account are offered");
    assert.match(labels, /AuditCat/);
    const markup = page.screen.html();
    assert.match(markup, /<select[^>]*>[\s\S]*?<option[^>]*value="PET-AUDITCAT"[^>]*>AuditCat/, "the options are in the rendered markup, not merely in the element tree");
    assert.match(page.screen.text(), /Travelling pet/, "and the field is labelled");
    assert.equal(select.props.value, "", "with two pets nothing is chosen for the customer");
    assert.match(page.screen.text(), /Choose the pet travelling on this trip/, "and the page says a choice is outstanding");

    select.props.onChange({ target: { value: AUDITCAT.id } });
    await page.screen.flush();
    assert.equal(petSelect(page.screen).props.value, AUDITCAT.id, "the choice sticks");

    const book = clickable(page.screen, /Confirm trip/);
    assert.ok(book, "the trip can be created");
    assert.equal(book.props.disabled, false, "and is not blocked once a pet is chosen");
    book.props.onClick();
    await page.screen.flush();

    const [booked] = bodyOf(page.record, "/api/taxi-bookings");
    assert.ok(booked, "a canonical booking request was sent");
    assert.deepEqual(booked.pets.map((entry) => entry.sourceId), [AUDITCAT.id], "the request carries the CHOSEN pet");
    assert.deepEqual(booked.pets.map((entry) => entry.name), ["AuditCat"]);
    const [reserved] = bodyOf(page.record, "/api/uat-scheduling");
    assert.deepEqual(reserved.petIds, [AUDITCAT.id], "and so does the scheduling reservation it is bound to");

    const confirmation = page.screen.text();
    assert.match(confirmation, /Trip booking created/, "the confirmation is on screen");
    assert.match(confirmation, /Travelling pet · AuditCat/, "and it names the animal, so a wrong choice is visible");
    assert.doesNotMatch(confirmation, /Bruno/, "the pet that was not chosen appears nowhere on it");
  } finally { page.close(); }
});

test("P1-T02 the pet in the request is the one chosen, not a fixed position in the list", async () => {
  // Non-vacuity for P1-T01: an implementation that always sent the LAST pet would pass it. Choose the
  // first pet explicitly and the first pet must be what travels.
  const page = await openPage("../app/taxi/canonical-taxi-page.tsx", [BRUNO, AUDITCAT]);
  try {
    petSelect(page.screen).props.onChange({ target: { value: BRUNO.id } });
    await page.screen.flush();
    clickable(page.screen, /Confirm trip/).props.onClick();
    await page.screen.flush();
    assert.deepEqual(bodyOf(page.record, "/api/taxi-bookings")[0].pets.map((entry) => entry.sourceId), [BRUNO.id]);
    assert.match(page.screen.text(), /Travelling pet · Bruno/);
    assert.doesNotMatch(page.screen.text(), /AuditCat/);
  } finally { page.close(); }
});

test("P1-T03 two pets on one quote are two different bookings, not a replayed one", async () => {
  // The booking route de-duplicates on (customer, idempotencyKey, scheduleGroupId) and returns the
  // PRIOR booking when they repeat. With the key scoped only to the quote, booking a second pet
  // against the same on-screen quote would have replayed the first pet's booking under a
  // confirmation naming the second — the same wrong-pet defect, one step later.
  const page = await openPage("../app/taxi/canonical-taxi-page.tsx", [BRUNO, AUDITCAT]);
  try {
    petSelect(page.screen).props.onChange({ target: { value: BRUNO.id } });
    await page.screen.flush();
    clickable(page.screen, /Confirm trip/).props.onClick();
    await page.screen.flush();
    clickable(page.screen, /Back to Taxi/).props.onClick();
    await page.screen.flush();
    petSelect(page.screen).props.onChange({ target: { value: AUDITCAT.id } });
    await page.screen.flush();
    clickable(page.screen, /Confirm trip/).props.onClick();
    await page.screen.flush();

    const sent = bodyOf(page.record, "/api/taxi-bookings");
    assert.equal(sent.length, 2, "both trips were sent");
    assert.notEqual(sent[0].idempotencyKey, sent[1].idempotencyKey, "and are distinguishable to the replay check");
    assert.notEqual(sent[0].scheduleGroupId, sent[1].scheduleGroupId, "each pet holds its own scheduling group");
    // Nothing else about the request changed: same customer, same quote, same route, one pet each.
    assert.equal(sent[0].customer.id, sent[1].customer.id);
    assert.equal(sent[0].taxiQuoteId, sent[1].taxiQuoteId);
    assert.equal(sent[0].routeCode, sent[1].routeCode);
    for (const request of sent) assert.equal(request.pets.length, 1);
  } finally { page.close(); }
});

test("P1-T04 a one-pet account is not made to confirm a choice it does not have", async () => {
  const page = await openPage("../app/taxi/canonical-taxi-page.tsx", [BRUNO]);
  try {
    assert.equal(petSelect(page.screen).props.value, BRUNO.id, "the only pet is preselected");
    const text = page.screen.text();
    assert.doesNotMatch(text, /Choose the pet travelling on this trip/, "so there is no nag");
    assert.doesNotMatch(text, /Add a pet to your PawSpace account/);
    assert.equal(clickable(page.screen, /Confirm trip/).props.disabled, false, "and the trip can be booked straight away");
  } finally { page.close(); }
});

test("P1-T05 an account with no pet is still told to add one", async () => {
  const page = await openPage("../app/taxi/canonical-taxi-page.tsx", []);
  try {
    assert.match(page.screen.text(), /Add a pet to your PawSpace account before booking a Pet Taxi trip/);
    assert.equal(clickable(page.screen, /Confirm trip/).props.disabled, true);
  } finally { page.close(); }
});

// --------------------------------------------------------------------------------------------
// DEFECT 2 (P2) — /walking did not preselect its only dog, and ignored the saved default address.
// --------------------------------------------------------------------------------------------
test("P2-W01 /walking preselects its only eligible dog and shows no nag", async () => {
  const page = await openPage("../app/walking/page.tsx", [BRUNO, AUDITCAT]); // one DOG; the cat is not walkable
  try {
    assert.equal(petSelect(page.screen).props.value, BRUNO.id, "the only walkable dog is preselected");
    const text = page.screen.text();
    assert.doesNotMatch(text, /Choose the dog you want to book this walk for/, "the alert that greeted every walking run is gone");
    assert.match(text, /Bruno/);
  } finally { page.close(); }
});

test("P2-W02 /walking opens on the saved default address instead of a blank address form", async () => {
  const page = await openPage("../app/walking/page.tsx", [BRUNO]);
  try {
    const text = page.screen.text();
    assert.match(text, /Walks start at your saved address/, "the saved address is offered, as /boarding and /sitting do");
    assert.match(text, /42 Test Road, Indiranagar, Bengaluru, 560038/, "and it is the customer's own saved default");
    assert.match(text, /Change Address/, "with the same escape hatch");
    assert.doesNotMatch(text, /Address Line 1/, "the blank typed-address form is not what the page opens on");
    assert.ok(page.record.some((call) => call.url === "/api/service-zone?pincode=560038"), "the saved address is checked against the server, not assumed serviceable");

    clickable(page.screen, /Change Address/).props.onClick();
    await page.screen.flush();
    assert.match(page.screen.text(), /Address Line 1/, "and the typed picker is one tap away");
  } finally { page.close(); }
});

test("P2-W03 /walking with no saved address still opens the address picker", async () => {
  const page = await openPage("../app/walking/page.tsx", [BRUNO], []);
  try {
    assert.match(page.screen.text(), /Address Line 1/);
    assert.doesNotMatch(page.screen.text(), /Walks start at your saved address/);
  } finally { page.close(); }
});

test("P2-W04 two dogs are still an explicit choice, and the chosen one is what is booked", async () => {
  // Non-vacuity for P2-W01: preselection must not have become "always take the first dog".
  const page = await openPage("../app/walking/page.tsx", [BRUNO, RUSTY]);
  try {
    assert.equal(petSelect(page.screen).props.value, "", "with two dogs the customer chooses");
    assert.match(page.screen.text(), /Choose the dog you want to book this walk for/);

    petSelect(page.screen).props.onChange({ target: { value: RUSTY.id } });
    await page.screen.flush();
    clickable(page.screen, /Confirm walk schedule/).props.onClick();
    await page.screen.flush();

    assert.deepEqual(bodyOf(page.record, "/api/walking-bookings")[0].pets.map((entry) => entry.sourceId), [RUSTY.id]);
    assert.match(page.screen.text(), /Rusty's walk schedule is created/);
  } finally { page.close(); }
});

// --------------------------------------------------------------------------------------------
// DEFECT 3 (P2) — the appointment was drawn on the browser's clock.
// --------------------------------------------------------------------------------------------
test("P2-Z00 non-vacuity: this process is NOT in India Standard Time", () => {
  assert.notEqual(new Date().getTimezoneOffset(), -330, "a process already in IST could not detect this defect");
  assert.equal(new Date(TAXI_PICKUP).toLocaleString("en-IN"), "17/9/2026, 1:30:00 am", "an unpinned format here reads 1:30 am");
  assert.equal(new Date(WALK_START).toLocaleString("en-IN"), "21/9/2026, 9:30:00 pm", "and moves the walk to the previous DAY");
});

test("P2-Z01 the /taxi confirmation shows the pickup in IST, whatever clock the browser is on", async () => {
  const page = await openPage("../app/taxi/canonical-taxi-page.tsx", [BRUNO]);
  try {
    petSelect(page.screen).props.onChange({ target: { value: BRUNO.id } }); // explicit, so this test pins the clock alone
    await page.screen.flush();
    clickable(page.screen, /Confirm trip/).props.onClick();
    await page.screen.flush();
    const text = page.screen.text();
    assert.match(text, /17\/9\/2026, 11:00:00 am IST/, "11:00 IST is shown as 11:00 IST and labelled");
    assert.doesNotMatch(text, /1:30:00 am/, "not the browser's local rendering of the same instant");
  } finally { page.close(); }
});

test("P2-Z02 the /walking confirmation shows the reserved walk in IST", async () => {
  const page = await openPage("../app/walking/page.tsx", [BRUNO]);
  try {
    petSelect(page.screen).props.onChange({ target: { value: BRUNO.id } }); // explicit, so this test pins the clock alone
    await page.screen.flush();
    clickable(page.screen, /Confirm walk schedule/).props.onClick();
    await page.screen.flush();
    const text = page.screen.text();
    assert.match(text, /22\/9\/2026, 7:00:00 am IST/, "the 7:00 AM slot is shown as 7:00 AM IST");
    assert.doesNotMatch(text, /21\/9\/2026/, "and not on the previous day, which is what the browser clock produced");
  } finally { page.close(); }
});
