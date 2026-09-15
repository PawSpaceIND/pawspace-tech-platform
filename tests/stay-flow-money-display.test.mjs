import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// Display integrity of the Boarding/Sitting money screen (stage 4 of stay-flow).
//
// The governed 50/50 split is computed on the server (lib/stay-split-payments.ts) as
// dueNow = round2(total/2), balance = round2(total - dueNow). A total of Rs 4,893 therefore
// splits into two Rs 2,446.50 instalments, and Rs 244,650 paise is what the gateway is asked
// for. The screen used to round each half to whole rupees on its own, printing
// "Rs 2,447 now / Rs 2,447 due" under "Booking total Rs 4,893" and a pay button for an amount
// nobody is ever charged.
//
// These tests render the REAL StayFlow component and assert on the rendered output. Because
// react-dom/server does not run effects, the component is driven through a tiny synchronous
// hook runtime (React's own dispatcher slot) so that its quote fetches, state updates and
// button clicks really happen, and the final tree is then rendered with react-dom/server.
// ---------------------------------------------------------------------------
installWorkersHooks("__STAY_FLOW_MONEY_DB__");

const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { splitPaymentPlan } = await import("../lib/stay-split-payments.ts");
const { rupeesToPaiseExact } = await import("../lib/financial-lifecycle.ts");
const { default: StayFlow } = await import("../app/mobile-app/stay-flow.tsx");

const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
assert.ok(internals && "H" in internals, "React exposes the dispatcher slot this harness drives");

// --- minimal client runtime -------------------------------------------------
// Real hook semantics for exactly the hooks StayFlow uses: state survives passes, effects run
// after a pass and only when their dependencies change, memos are cached on their deps.
function mount(Component, props) {
  const hooks = [];
  const queue = [];
  let cursor = 0;
  let dirty = false;

  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const slot = () => { const index = cursor++; if (!hooks[index]) hooks[index] = { index }; return hooks[index]; };
  const update = (cell, next) => {
    const value = typeof next === "function" ? next(cell.value) : next;
    if (!Object.is(value, cell.value)) { cell.value = value; dirty = true; }
  };
  const effectSlot = (create, deps) => {
    const cell = slot();
    if (!("deps" in cell) || !sameDeps(cell.deps, deps)) { cell.deps = deps; cell.create = create; queue.push(cell); }
  };
  const dispatcher = {
    useState(initial) {
      const cell = slot();
      if (!("value" in cell)) cell.value = typeof initial === "function" ? initial() : initial;
      return [cell.value, (next) => update(cell, next)];
    },
    useReducer(reducer, initialArg, init) {
      const cell = slot();
      if (!("value" in cell)) cell.value = init ? init(initialArg) : initialArg;
      return [cell.value, (action) => update(cell, (current) => reducer(current, action))];
    },
    useRef(initial) { const cell = slot(); if (!("ref" in cell)) cell.ref = { current: initial }; return cell.ref; },
    useMemo(create, deps) {
      const cell = slot();
      if (!("memo" in cell) || !sameDeps(cell.deps, deps)) { cell.deps = deps; cell.memo = create(); }
      return cell.memo;
    },
    useCallback(fn, deps) { return dispatcher.useMemo(() => fn, deps); },
    useEffect: effectSlot,
    useLayoutEffect: effectSlot,
    useInsertionEffect() { slot(); },
    useImperativeHandle() { slot(); },
    useContext(context) { return context._currentValue; },
    useDebugValue() {},
    useId() { const cell = slot(); return `:r${cell.index}:`; },
    useSyncExternalStore(_subscribe, getSnapshot, getServerSnapshot) { slot(); return (getServerSnapshot ?? getSnapshot)(); },
    useTransition() { slot(); return [false, (callback) => callback()]; },
    useDeferredValue(value) { slot(); return value; },
    useOptimistic(value) { slot(); return [value, () => {}]; },
    useActionState(_action, initial) { slot(); return [initial, () => {}, false]; },
    useEffectEvent(fn) { return fn; },
    use(usable) { return usable; },
  };

  const pass = () => {
    cursor = 0;
    dirty = false;
    const previous = internals.H;
    internals.H = dispatcher;
    try { return Component(props); } finally { internals.H = previous; }
  };
  const drain = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };

  let tree = pass();
  const settle = async () => {
    for (let i = 0; i < 40; i++) {
      for (const cell of queue.splice(0)) {
        if (typeof cell.cleanup === "function") { cell.cleanup(); cell.cleanup = undefined; }
        const result = cell.create();
        if (typeof result === "function") cell.cleanup = result;
      }
      await drain();
      if (!dirty && queue.length === 0) return tree;
      tree = pass();
    }
    throw new Error("StayFlow never reached a stable render");
  };
  return { settle, tree: () => tree, html: () => renderToStaticMarkup(tree) };
}

// --- element-tree helpers ---------------------------------------------------
function* walk(node) {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const child of node) yield* walk(child); return; }
  yield node;
  yield* walk(node.props?.children);
}
const textOf = (node) => {
  let out = "";
  const visit = (value) => {
    if (value == null || typeof value === "boolean") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (typeof value === "object") { visit(value.props?.children); return; }
    out += String(value);
  };
  visit(node);
  return out;
};
const find = (tree, predicate) => [...walk(tree)].find(predicate);
const button = (tree, label) => {
  const node = find(tree, (n) => n.type === "button" && textOf(n).includes(label));
  assert.ok(node, `a button labelled "${label}" is on screen`);
  return node;
};
// Plain text of the rendered screen, so assertions read the customer's words, not markup.
const screenText = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&#x2F;/g, "/").replace(/\s+/g, " ").trim();

// --- fixtures ---------------------------------------------------------------
const dateOffset = (days) => { const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() + days); return date.toISOString().slice(0, 10); };
const LOCATION = {
  address: "42 Test Road, Indiranagar, Bengaluru, 560038",
  assignment: { pincode: "560038", cityId: "blr", city: "Bengaluru", zoneId: "blr-east", area: "Indiranagar" },
  zone: { zoneId: "blr-east", serviceAvailable: true },
};
const PETS = [{ id: "pet-1", sourceId: "pet-1", name: "Buddy", species: "dog", breed: "Indie", vaccinationStatus: "verified" }];
const PROVIDER = { id: "prov-1", name: "Meera Rao", model: "commission", rating: 4.8, qualityScore: 90 };
const HOST = {
  providerId: "prov-1", name: "Meera Rao", model: "commission", area: "Indiranagar", rating: 4.8, qualityScore: 90,
  capacity: 3, availableGuestPets: 3, species: ["dog"], oneFamilyOnly: false, medicationSupport: true, residentPets: "none",
  homeVerified: true, kycStatus: "verified", backgroundCheckStatus: "verified", profileVersion: 1, availabilityVerified: true,
};

/** Stands in for the two commercial routes, using the SAME server split arithmetic they use. */
function installFetch(scenario) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const body = init.body ? JSON.parse(init.body) : {};
    const json = (data) => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
    if (href.startsWith("/api/customer-account")) return json({ customerId: "test-customer", pets: PETS });
    if (href.startsWith("/api/boarding-commercial") && (init.method ?? "GET") === "GET") {
      return json({ packages: [], hosts: [HOST], source: "fixture", availabilityMode: "uat_canonical", availabilityVerified: true, liveAvailability: false, liveMoney: false });
    }
    if (href.startsWith("/api/uat-scheduling")) {
      return json({ providers: [PROVIDER], availabilityChecked: true, reserved: false, cityId: "blr", zoneId: "blr-east", scheduledStart: body.scheduledStart, scheduledEnd: body.scheduledEnd });
    }
    if (href.startsWith("/api/boarding-commercial") || href.startsWith("/api/sitting-commercial")) {
      const totalAmount = scenario.total;
      const amountDueNow = body.paymentMode === "split_50_50"
        ? splitPaymentPlan({ totalAmount, scheduledStart: body.scheduledStart }).dueNow
        : totalAmount;
      const shared = {
        quoteId: "Q-TEST-1", packageCode: body.packageCode, packageName: "Fixture package", packageVersion: 1, petCount: body.petCount,
        cityId: "blr", zoneId: "blr-east", scheduledStart: body.scheduledStart, scheduledEnd: body.scheduledEnd,
        basePricePerPet: scenario.unitPrice, totalAmount, amountDueNow, paymentMode: body.paymentMode, expiresAt: Date.now() + 900_000, liveMoney: false,
      };
      return json(href.startsWith("/api/boarding-commercial")
        ? { ...shared, durationHours: scenario.nights * 24, stayUnits: scenario.units }
        : { ...shared, mode: "overnight", billableUnits: scenario.units, extraPetPrice: 0 });
    }
    throw new Error(`unexpected fetch in test: ${href}`);
  };
  return () => { globalThis.fetch = original; };
}

/** Walks a real customer from stage 1 to the stage-4 money screen. */
async function moneyScreen(scenario) {
  const restore = installFetch(scenario);
  try {
    const app = mount(StayFlow, { mode: scenario.mode, customer: { customerId: "test-customer", customerName: "Test Customer", phone: "9000000000" } });
    await app.settle();

    find(app.tree(), (n) => typeof n.props?.onResolved === "function").props.onResolved(LOCATION);
    await app.settle();

    // Type into the real date inputs, but only when the value actually differs — a browser fires
    // no change event when a field is re-typed with what it already holds.
    const setDate = async (index, value) => {
      const inputs = [...walk(app.tree())].filter((n) => n.type === "input" && n.props?.type === "date");
      assert.equal(inputs.length, 2, "check-in and check-out dates are on screen");
      if (inputs[index].props.value === value) return;
      inputs[index].props.onChange({ target: { value } });
      await app.settle();
    };
    await setDate(0, dateOffset(3));
    await setDate(1, dateOffset(3 + scenario.nights));

    button(app.tree(), scenario.mode === "boarding" ? "See available homes" : "See available sitters").props.onClick();
    await app.settle();
    button(app.tree(), `Continue with ${PROVIDER.name.split(" ")[0]}`).props.onClick();
    await app.settle();
    button(app.tree(), "Review protected booking").props.onClick();
    await app.settle();

    const html = app.html();
    assert.match(html, /Booking total/, "the stage-4 money screen is what rendered");
    return { html, text: screenText(html), tree: app.tree() };
  } finally { restore(); }
}

// Amounts formatted the way the screen formats them, derived from the same server numbers.
const inr = (value) => {
  const paise = Math.round(value * 100);
  const fractional = paise % 100 !== 0;
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: fractional ? 2 : 0, maximumFractionDigits: fractional ? 2 : 0 }).format(paise / 100);
};
/** Every rupee amount the screen printed, in paise, in order. */
const amountsInPaise = (text) =>
  [...text.matchAll(/₹\s?([\d,]+(?:\.\d{1,2})?)/g)].map((match) => Math.round(Number(match[1].replaceAll(",", "")) * 100));

// ---------------------------------------------------------------------------

const HALF_RUPEE_CASES = [
  { name: "Boarding 7 nights ₹4,893", mode: "boarding", nights: 7, total: 4893, units: 7, unitPrice: 699 },
  { name: "Boarding 5 nights ₹3,495", mode: "boarding", nights: 5, total: 3495, units: 5, unitPrice: 699 },
  { name: "Sitting 7 nights ₹5,593", mode: "sitting", nights: 7, total: 5593, units: 7, unitPrice: 799 },
];

for (const scenario of HALF_RUPEE_CASES) {
  test(`${scenario.name}: the two displayed instalments sum exactly to the displayed total`, async () => {
    const plan = splitPaymentPlan({ totalAmount: scenario.total, scheduledStart: new Date(Date.now() + 5 * 86_400_000).toISOString() });
    assert.notEqual(Math.round(plan.dueNow * 100) % 100, 0, "this case really is a half-rupee split");

    const { text } = await moneyScreen(scenario);

    // The screen's own words, not a recomputation: "₹X now · ₹Y due 24 hours before check-in".
    const split = text.match(/₹\s?([\d,]+(?:\.\d{1,2})?) now · ₹\s?([\d,]+(?:\.\d{1,2})?) due 24/);
    assert.ok(split, `the 50/50 instalment line is on screen: ${text.slice(0, 400)}`);
    const shownNow = Math.round(Number(split[1].replaceAll(",", "")) * 100);
    const shownLater = Math.round(Number(split[2].replaceAll(",", "")) * 100);

    const total = text.match(/Booking total ₹\s?([\d,]+(?:\.\d{1,2})?)/);
    assert.ok(total, "the booking total is on screen");
    const shownTotal = Math.round(Number(total[1].replaceAll(",", "")) * 100);

    assert.equal(shownTotal, scenario.total * 100, "the total shown is the server total");
    assert.equal(shownNow + shownLater, shownTotal, `${shownNow} + ${shownLater} paise must equal the ${shownTotal} paise total printed on the same screen`);
    assert.equal(shownNow, rupeesToPaiseExact(plan.dueNow), "the instalment shown is the server's dueNow to the paisa");
    assert.equal(shownLater, rupeesToPaiseExact(plan.balance), "the balance shown is the server's balance to the paisa");
  });

  test(`${scenario.name}: the pay button asks for exactly what the gateway is charged`, async () => {
    const plan = splitPaymentPlan({ totalAmount: scenario.total, scheduledStart: new Date(Date.now() + 5 * 86_400_000).toISOString() });
    const { tree, text } = await moneyScreen(scenario);
    const pay = [...walk(tree)].find((node) => node.type === "button" && /^Pay ₹/.test(textOf(node)));
    assert.ok(pay, "the pay button is on screen");
    const shown = textOf(pay).match(/₹\s?([\d,]+(?:\.\d{1,2})?)/);
    assert.equal(Math.round(Number(shown[1].replaceAll(",", "")) * 100), rupeesToPaiseExact(plan.dueNow),
      "the button amount must be the amount actually charged in paise");
    assert.match(textOf(pay), new RegExp(`Pay ${inr(plan.dueNow).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    // And no whole-rupee rounding survived anywhere else on the screen either.
    assert.ok(amountsInPaise(text).includes(rupeesToPaiseExact(plan.dueNow)), "the due-now amount appears to the paisa wherever it is printed");
    assert.doesNotMatch(text, new RegExp(`₹\\s?${(Math.ceil(plan.dueNow)).toLocaleString("en-IN")}(?![\\d.,])`), "the rounded-up half-rupee must not appear anywhere");
  });
}

test("an evenly splitting total is still shown in plain whole rupees", async () => {
  const scenario = { mode: "boarding", nights: 7, total: 4886, units: 7, unitPrice: 698 };
  const plan = splitPaymentPlan({ totalAmount: scenario.total, scheduledStart: new Date(Date.now() + 5 * 86_400_000).toISOString() });
  assert.equal(plan.dueNow, 2443);

  const { text } = await moneyScreen(scenario);
  assert.match(text, /Booking total ₹4,886/);
  assert.match(text, /₹2,443 now · ₹2,443 due 24 hours before check-in/);
  assert.doesNotMatch(text, /₹2,443\.00/, "a whole-rupee amount keeps its plain whole-rupee form");
  assert.doesNotMatch(text, /₹4,886\.00/);
  const split = text.match(/₹([\d,]+) now · ₹([\d,]+) due 24/);
  assert.equal(
    Math.round(Number(split[1].replaceAll(",", "")) * 100) + Math.round(Number(split[2].replaceAll(",", "")) * 100),
    scenario.total * 100,
  );
});

test("the Meet & Greet copy on the money screen matches the fee actually applied", async () => {
  // Sitting + the 2-hour home visit is the exact combination that used to claim a ₹500 fee.
  const scenario = { mode: "sitting", nights: 7, total: 5593, units: 7, unitPrice: 799 };
  const { text } = await moneyScreen(scenario);

  assert.match(text, /2-hour sitter Meet & Greet No charge/, "the bill line states the fee that is applied");
  assert.match(text, /Meet & Greet 2 hours · No charge/, "the review line agrees with the bill line");
  assert.doesNotMatch(text, /₹500/, "no ₹500 meeting fee is claimed on a screen that charges none");
  assert.doesNotMatch(text, /meeting fee is collected now/);
  assert.match(text, /No Meet & Greet fee is charged on this booking, so the whole ₹5,593 booking total above is what splits 50\/50\./);

  // The claim has to hold arithmetically: due-now is exactly half the whole total, with no fee
  // added on top of it and nothing held back from the split.
  const split = text.match(/₹\s?([\d,]+(?:\.\d{1,2})?) now · ₹\s?([\d,]+(?:\.\d{1,2})?) due 24/);
  const now = Math.round(Number(split[1].replaceAll(",", "")) * 100);
  assert.equal(now, Math.round(scenario.total * 100) / 2, "due-now is half the whole total — no separate meeting fee is being collected");
});
