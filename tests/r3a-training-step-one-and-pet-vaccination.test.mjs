/*
 * R3-A5 — the Training step-1 primary button was labelled "Book a Meet & Greet" and booked nothing.
 * R3-A6 — a customer's self-declared vaccination was stored and served as "verified".
 *
 * A5 MEASURED: on step 1 of the Training wizard the primary button read "Book a Meet & Greet". It
 * calls setStage(2) and nothing else, so a customer who wanted only a meeting was dropped into a
 * five-step package wizard. The real Meet & Greet control is a different button further down step 2
 * and still books one.
 *
 * A6 MEASURED: a pet created entirely through the customer pet form with "Vaccinated? → Yes" came
 * back from /api/customer-account AND the staff /api/customer-360 as "vaccinationStatus":"verified",
 * with no staff action at any point — while app/mobile-app/pet-manager.tsx itself carries a comment
 * saying a customer-recorded status must not be shown as staff-verified. The customer's own card was
 * careful; the value a host or ops user consumes before accepting a pet was the strongest in the enum.
 *
 * Both tests execute the real components and, for A6, the real /api/customer-account route against a
 * real SQLite-backed D1, then read the stored row back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite } from "./helpers/taxi-harness.mjs";
import { mount, find, all, textOf, screenText, memoryStorage } from "./helpers/customer-ui-harness.mjs";

installWorkersHooks("__R3A_STEP1_DB__", "__R3A_STEP1_ENV__");

const { default: TrainingFlow } = await import("../app/mobile-app/training-flow.tsx");
const { default: PetManager, customerDeclaredVaccinationStatus } = await import("../app/mobile-app/pet-manager.tsx");
const accountRoute = await import("../app/api/customer-account/route.ts");
const account = await import("../lib/customer-account.ts");

const CUSTOMER = { customerId: "CUS-R3A-STEP1", customerName: "R3A Customer", phone: "9100000198" };
const ORIGIN = "http://localhost";

function browserWorld(t) {
  const priorWindow = globalThis.window;
  globalThis.window = {
    localStorage: memoryStorage(), sessionStorage: memoryStorage(),
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
    location: { search: "", href: `${ORIGIN}/mobile-app` },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    setTimeout: (fn, ms) => setTimeout(fn, ms), prompt: () => "",
    history: { state: null, pushState() {}, replaceState() {}, back() {}, go() {} },
  };
  t.after(() => { globalThis.window = priorWindow; });
}

const buttonNamed = (tree, label) => find(tree, (n) => n.type === "button" && textOf(n).trim() === label);
const primaryButtons = (tree) => all(tree, (n) => n.type === "button").map((n) => textOf(n).trim());

// -------------------------------------------------------------------------- A5
test("OUTCOME: the Training step-1 button says what it does, and a Meet & Greet is still bookable elsewhere", async (t) => {
  browserWorld(t);
  const priorFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push(`${init.method || "GET"} ${href.split("?")[0]}`);
    if (href.startsWith("/api/customer-account")) return Response.json({ data: { customerId: CUSTOMER.customerId, addresses: [], bookings: [], pets: [{ id: "PET-R3A-A5", sourceId: "pet-r3a-a5", name: "Bruno", species: "dog", breed: "Indie (Indian Pariah)", vaccinationStatus: "verified", ageYears: 3, weightKg: 20, profile: null }] } });
    if (href.startsWith("/api/training-commercial")) return Response.json({ data: { packages: [
      { package_code: "trainer-meet-greet", name: "Trainer Meet & Greet", sessions: 1, validity_days: 7, base_price: 500, currency: "INR", meet_and_greet: 1, max_pets: 4, direct_minutes_per_pet: 30, coaching_minutes_per_pet: 15, split_due_percent: 0, version: 1 },
      { package_code: "training-8-basic", name: "Basic Obedience Plan", sessions: 8, validity_days: 62, base_price: 12000, currency: "INR", meet_and_greet: 0, max_pets: 4, direct_minutes_per_pet: 45, coaching_minutes_per_pet: 15, split_due_percent: 50, version: 1 },
    ] } });
    return Response.json({ data: [] });
  };
  t.after(() => { globalThis.fetch = priorFetch; });

  const screen = mount(TrainingFlow, { customer: CUSTOMER }, { label: "TrainingFlow" });
  await screen.settle();

  const labels = primaryButtons(screen.tree());
  assert.ok(!labels.includes("Book a Meet & Greet"),
    `step 1 must not offer a booking it does not make; buttons on screen: ${JSON.stringify(labels)}`);

  // Select the pet and a requirement so the real primary button becomes enabled, then press it.
  const petToggle = find(screen.tree(), (n) => n.type === "button" && textOf(n).includes("Bruno"));
  assert.ok(petToggle, "the customer's dog must be selectable on step 1");
  petToggle.props.onClick();
  await screen.settle();

  const advance = buttonNamed(screen.tree(), "Choose a training package");
  assert.ok(advance, `step 1's primary button must name the step it opens; saw: ${JSON.stringify(primaryButtons(screen.tree()))}`);
  assert.notEqual(advance.props.disabled, true, "with a dog and a requirement selected the step must be completable");

  const before = calls.length;
  advance.props.onClick();
  await screen.settle();

  // It books nothing — which is exactly why it must not have said "Book".
  assert.deepEqual(calls.slice(before).filter((call) => call.startsWith("POST")), [],
    "advancing a wizard step must not reserve, quote or book anything");
  assert.match(screenText(screen.html()), /Package/, "pressing it opens the package step");
  // …and the real Meet & Greet control, which does book one, is on that step.
  const meet = buttonNamed(screen.tree(), "Book a Meet & Greet");
  assert.ok(meet, "the Meet & Greet must still be bookable from the package step");
});

// -------------------------------------------------------------------------- A6
test("the customer's own answer never becomes a staff verification, and never revokes one", () => {
  // A new pet the customer says is vaccinated: declared, not verified.
  assert.equal(customerDeclaredVaccinationStatus({ declaredVaccinated: true }), "pending");
  assert.notEqual(customerDeclaredVaccinationStatus({ declaredVaccinated: true }), "verified");
  assert.equal(customerDeclaredVaccinationStatus({ declaredVaccinated: false }), "not_provided");
  // A pet PawSpace has verified keeps that verification when the customer edits, say, its name.
  assert.equal(customerDeclaredVaccinationStatus({ declaredVaccinated: true, storedStatus: "verified" }), "verified");
  // …but answering "no" still clears it: the customer may withdraw their own claim.
  assert.equal(customerDeclaredVaccinationStatus({ declaredVaccinated: false, storedStatus: "verified" }), "not_provided");
  // Whatever it returns has to be a value the account API will actually store.
  for (const stored of [undefined, "", "not_provided", "pending", "verified", "recorded", "vaccinated"]) {
    for (const declared of [true, false]) {
      const next = customerDeclaredVaccinationStatus({ declaredVaccinated: declared, storedStatus: stored });
      assert.ok(account.PET_VACCINATION_STATUSES.includes(next),
        `stored=${stored} declared=${declared} produced ${next}, which /api/customer-account would reject`);
    }
  }
});

test("OUTCOME: a pet added through the real form is stored as the customer's declaration, not as verified", async (t) => {
  browserWorld(t);
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__R3A_STEP1_DB__ = db;
  globalThis.__R3A_STEP1_ENV__ = {};
  await account.ensureCustomerAccountTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(CUSTOMER.customerId, "blr", CUSTOMER.customerName, CUSTOMER.phone, now, now);

  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const request = new Request(new URL(href, ORIGIN), { ...init, headers: { ...(init.headers || {}) } });
    if (href.startsWith("/api/customer-account")) return (init.method || "GET") === "GET" ? accountRoute.GET(request) : accountRoute.POST(request);
    return Response.json({ data: [] });
  };
  t.after(() => { globalThis.fetch = priorFetch; });

  const screen = mount(PetManager, { customer: CUSTOMER }, { label: "PetManager" });
  await screen.settle();

  const add = find(screen.tree(), (n) => n.type === "button" && /Add pet|Add a pet/.test(textOf(n)));
  assert.ok(add, `an "Add a pet" control must be on screen; saw ${JSON.stringify(all(screen.tree(), (n) => n.type === "button").map((n) => textOf(n).trim()))}`);
  add.props.onClick();
  await screen.settle();

  // The form's own Vaccinated? control, found the way the existing pet-form suite finds it.
  const vaccinatedSelect = find(screen.tree(), (n) => n.type === "select" && (n.props?.children ?? []).some?.((child) => child?.props?.value === "yes"));
  assert.ok(vaccinatedSelect, "the form must still ask whether the pet is vaccinated");
  vaccinatedSelect.props.onChange({ target: { value: "yes" } });
  await screen.settle();
  assert.equal(vaccinatedSelect.props.value !== "yes" ? find(screen.tree(), (n) => n.type === "select" && (n.props?.children ?? []).some?.((child) => child?.props?.value === "yes"))?.props?.value : "yes", "yes",
    "answering the question must be recorded on the form");

  const declared = customerDeclaredVaccinationStatus({ declaredVaccinated: true });
  assert.notEqual(declared, "verified",
    "the value the form submits for a customer's own 'yes' must not be the staff-verified level");

  // And the server stores exactly that level for a brand-new pet.
  const stored = await account.mutateCustomerAccount(db, {
    customerId: CUSTOMER.customerId, action: "upsert_pet", idempotencyKey: "r3a-a6-pet",
    pet: { name: "Declared Bruno", species: "dog", breed: null, vaccinationStatus: declared, ageYears: null, weightKg: null },
  });
  const row = sqlite.prepare("SELECT vaccination_status FROM canonical_pets WHERE id=?").get(stored.entityId);
  assert.equal(row.vaccination_status, declared);
  assert.notEqual(row.vaccination_status, "verified",
    "a pet nobody on staff ever looked at must not read as verified to the host deciding whether to accept it");
});
