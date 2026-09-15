/**
 * DEFECT: a vaccinated pet was shown as "Vaccination not provided", and opening Edit dropped the
 * breed and the vaccination it already had on file.
 *
 * The fixture is the reported row: E2E-PET-UI-001, breed 'indie', vaccination_status 'vaccinated'.
 * /api/customer-account returns those values verbatim, so the whole defect lived in the component's
 * READ of them:
 *   - the card mapped anything outside verified/pending to "Vaccination not provided", although the
 *     platform's own writer (lib/pet-vaccination-governance.ts) stamps 'recorded' for a real
 *     recorded vaccination;
 *   - the edit pre-fill answered "Vaccinated?" only for verified/not_provided; and
 *   - the breed pre-fill used a case-SENSITIVE exact match against DOG_BREEDS, which holds
 *     "Indie (Indian Pariah)", not "indie".
 * Result: a customer could not change a pet's NAME without re-entering breed and vaccination, and
 * vaccination is a booking gate for boarding and sitting.
 *
 * These tests EXECUTE the real component: effects, state, the Edit click and the Save click all run,
 * and the values the form would actually SUBMIT are then put through the shared server-side
 * validator, so "the pre-fill is savable" is proved rather than asserted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { mount, find, all, textOf, screenText } from "./helpers/customer-ui-harness.mjs";

installWorkersHooks("__PET_VACCINATION_UI_DB__");

const { default: PetManager } = await import("../app/mobile-app/pet-manager.tsx");
const { validatePetProfile } = await import("../lib/pet-profile-options.ts");
const { petProfileIssues, PET_VACCINATION_STATUSES } = await import("../lib/customer-account.ts");

const CUSTOMER = { customerId: "E2E-CUS-UI-001", customerName: "UAT Customer", phone: "9000000001" };

/** Exactly what /api/customer-account returns for the reported row. */
const VACCINATED_PET = {
  id: "E2E-PET-UI-001", sourceId: "e2e-pet-ui-001", name: "Bruno", species: "dog",
  breed: "indie", vaccinationStatus: "vaccinated", ageYears: 3, weightKg: 22, profile: null,
};
/** A pet that genuinely has nothing on file - the control that keeps every assertion below non-vacuous. */
const BLANK_PET = {
  id: "E2E-PET-UI-002", sourceId: "e2e-pet-ui-002", name: "Ghost", species: "dog",
  breed: "Direwolf", vaccinationStatus: "not_provided", ageYears: 2, weightKg: 20, profile: null,
};

function installFetch(pets) {
  const original = globalThis.fetch;
  const posted = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.startsWith("/api/customer-account") && (init.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ data: { customerId: CUSTOMER.customerId, addresses: [], bookings: [], pets } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href.startsWith("/api/customer-account")) {
      const body = JSON.parse(init.body);
      posted.push(body);
      return new Response(JSON.stringify({ data: { entityId: body.pet.id ?? "new", duplicatePrevented: false } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch in test: ${href}`);
  };
  return { posted, restore: () => { globalThis.fetch = original; } };
}

const breedInput = (tree) => find(tree, (n) => n.type === "input" && n.props?.list === "pet-breed-options");
const vaccinatedSelect = (tree) => find(tree, (n) => n.type === "select" && (n.props?.children ?? []).some?.((child) => child?.props?.value === "yes"));
const alerts = (tree) => all(tree, (n) => n.props?.role === "alert").map(textOf);
const click = (node) => node.props.onClick();
const buttonNamed = (tree, label) => {
  const node = find(tree, (n) => n.type === "button" && textOf(n).trim() === label);
  assert.ok(node, `a button labelled "${label}" is on screen`);
  return node;
};

async function screen(pets) {
  const fetchStub = installFetch(pets);
  const app = mount(PetManager, { customer: CUSTOMER }, { label: "PetManager" });
  await app.settle();
  return { app, ...fetchStub };
}

// ---------------------------------------------------------------------------------------------
test("a recorded vaccination is shown as vaccinated, not as 'Vaccination not provided'", async () => {
  const { app, restore } = await screen([VACCINATED_PET]);
  try {
    const text = screenText(app.html());
    assert.match(text, /Bruno/, "the pet is on screen at all - or nothing below means anything");
    assert.doesNotMatch(text, /Vaccination not provided/, "a vaccinated pet must not be reported as having no vaccination");
    assert.match(text, /Vaccinated/, "the card says what the row actually holds");
  } finally { restore(); }
});

test("the same card still says 'Vaccination not provided' when that is the truth", async () => {
  const { app, restore } = await screen([BLANK_PET]);
  try {
    const text = screenText(app.html());
    assert.match(text, /Ghost/);
    assert.match(text, /Vaccination not provided/, "the honest message must survive - the fix widens the read, it does not blanket-claim vaccination");
  } finally { restore(); }
});

test("'recorded' - what the platform's own vaccination writer stamps - reads as vaccinated too", async () => {
  const { app, restore } = await screen([{ ...VACCINATED_PET, vaccinationStatus: "recorded" }]);
  try {
    assert.doesNotMatch(screenText(app.html()), /Vaccination not provided/);
  } finally { restore(); }
});

test("a pending vaccination is still reported as pending, not as vaccinated", async () => {
  const { app, restore } = await screen([{ ...VACCINATED_PET, vaccinationStatus: "pending" }]);
  try {
    assert.match(screenText(app.html()), /Vaccination pending/);
  } finally { restore(); }
});

// ---------------------------------------------------------------------------------------------
test("Edit pre-fills the stored breed and vaccination, and Save stops demanding them back", async () => {
  const { app, posted, restore } = await screen([VACCINATED_PET]);
  try {
    click(buttonNamed(app.tree(), "Edit"));
    await app.settle();

    assert.equal(breedInput(app.tree()).props.value, "Indie (Indian Pariah)",
      "the stored 'indie' resolves to the catalogue breed instead of opening an empty field");
    assert.equal(vaccinatedSelect(app.tree()).props.value, "yes",
      "the stored vaccination answers the Vaccinated? field");

    // Nothing else is touched - this is the reported journey: open Edit, press Save.
    click(buttonNamed(app.tree(), "Save changes"));
    await app.settle();

    const refusals = alerts(app.tree()).join(" ");
    assert.doesNotMatch(refusals, /Select the pet's breed/, "the breed it already has must not be demanded again");
    assert.doesNotMatch(refusals, /Tell us whether the pet is vaccinated/, "nor the vaccination it already has on file");
    // Temperament is the one field a legacy pet has genuinely never carried, and the component says
    // so in its own comment - it is the only remaining pick, and it is not part of this defect.
    assert.match(refusals, /Select the pet's temperament/, "the one genuinely-new field is still asked for");
    assert.equal(posted.length, 0, "and nothing is written until it is answered");

    find(app.tree(), (n) => n.type === "select" && (n.props?.children ?? []).some?.((child) => Array.isArray(child) && child.some((option) => option?.props?.value === "Friendly")))
      .props.onChange({ target: { value: "Friendly" } });
    await app.settle();
    click(buttonNamed(app.tree(), "Save changes"));
    await app.settle();

    assert.deepEqual(alerts(app.tree()), [], `Save must now go through: ${alerts(app.tree()).join(" | ")}`);
    assert.equal(posted.length, 1, "the save actually reached /api/customer-account");
    assert.equal(posted[0].action, "upsert_pet");
    assert.equal(posted[0].pet.id, VACCINATED_PET.id, "it edits the same pet rather than minting a second one");
    assert.equal(posted[0].pet.profile.breed, "Indie (Indian Pariah)");
    assert.equal(posted[0].pet.profile.vaccinated, true);

    // The values the form submitted are put through the SERVER's own validators, so the pre-fill is
    // proved savable rather than merely non-empty.
    assert.equal(validatePetProfile("dog", posted[0].pet.profile), null, "the pre-filled profile passes the shared server validator");
    assert.deepEqual(petProfileIssues({ name: posted[0].pet.name, species: posted[0].pet.species, vaccinationStatus: posted[0].pet.vaccinationStatus, ageYears: null, weightKg: null }), []);
    assert.ok(PET_VACCINATION_STATUSES.includes(posted[0].pet.vaccinationStatus),
      "the WRITE vocabulary is untouched - only the read was widened");
  } finally { restore(); }
});

test("the validator is not weakened: an off-catalogue breed and an unanswered vaccination still block Save", async () => {
  const { app, posted, restore } = await screen([BLANK_PET]);
  try {
    click(buttonNamed(app.tree(), "Edit"));
    await app.settle();
    assert.equal(breedInput(app.tree()).props.value, "", "'Direwolf' matches no catalogue breed, so it must not be pre-filled as if it did");
    assert.equal(vaccinatedSelect(app.tree()).props.value, "no", "not_provided is a real answer and is still pre-filled");

    click(buttonNamed(app.tree(), "Save changes"));
    await app.settle();
    assert.match(alerts(app.tree()).join(" "), /Select the pet's breed/, "an unknown breed must still be refused");
    assert.equal(posted.length, 0, "nothing is written while the profile is invalid");
  } finally { restore(); }
});

test("a pending pet still has to answer Vaccinated? - the fix never invents an answer", async () => {
  const { app, posted, restore } = await screen([{ ...VACCINATED_PET, vaccinationStatus: "pending" }]);
  try {
    click(buttonNamed(app.tree(), "Edit"));
    await app.settle();
    assert.equal(vaccinatedSelect(app.tree()).props.value, "", "'pending' is a claim awaiting verification, not a yes");
    click(buttonNamed(app.tree(), "Save changes"));
    await app.settle();
    assert.match(alerts(app.tree()).join(" "), /Tell us whether the pet is vaccinated/);
    assert.equal(posted.length, 0);
  } finally { restore(); }
});
