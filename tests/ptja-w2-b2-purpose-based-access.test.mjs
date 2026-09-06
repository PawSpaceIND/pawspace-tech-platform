/**
 * Purpose-based access to customer personal data. [PTJA-W2-B2-R01 / C01 / C07]
 *
 * WHAT WAS MEASURED across this audit: phone and name are masked from lower-privileged staff, and email,
 * home address and staff internal notes are not - the platform defines only maskPhone and maskName, and
 * six cross-tenant reads were found returning bereavement pickup addresses, relocation travel dates and
 * competitors' complaint notes on branches written for "staff" but gated on a permission `service_provider`
 * also holds. The open question recorded at the time was who should see what, because an associate
 * arranging a home visit genuinely needs the address.
 *
 * THE APPROVED ANSWER is purpose-based access rather than one global masked/unmasked switch:
 *
 *   role                    phone / email                  home address                      internal notes
 *   sales associate         masked; temporary reveal for    area / pincode only before        sales-safe only
 *                           an ASSIGNED lead                booking
 *   operations associate    reveal for an assigned ACTIVE   full address for an assigned      operational only
 *                           booking                         booking near execution
 *   assigned provider       masked, through relay           full address only inside the      service instructions
 *                                                           operational window                only
 *   manager                 reveal when required, audited   full within team / city scope     by note category
 *   finance                 billing contact only            billing address where required    finance notes only
 *   superuser / compliance  full, audited                    full, audited                     full per policy
 *
 * And four rules that bite hardest:
 *   - full address only AFTER assignment or confirmation and shortly before service
 *   - provider access expires at completion plus a limited dispute window
 *   - every reveal logged with user, reason, booking and time
 *   - complaint, safety, medical, financial and HR notes are separate categories with separate
 *     permissions, and internal notes never reach a customer or provider unless marked shareable
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_ACCESS_DB__", "__PTJA_ACCESS_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-10T06:00:00.000Z");
const SUBJECT = {
  customerId: "CUS-1", name: "Ananya Rao Sharma", phone: "+919900000123", email: "ananya@example.com",
  address: { line1: "221B, 5th Block", area: "Koramangala", city: "Bengaluru", pincode: "560034" },
};

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_ACCESS_DB__ = db;
  globalThis.__PTJA_ACCESS_ENV__ = {};
  const { ensureDataAccessTables } = await import("../lib/purpose-based-access.ts");
  await ensureDataAccessTables(db);
  return { sqlite, db };
}

/** An actor as the platform models one: a role, its permissions, and who they are. */
const actorFor = (roleCode, extra = {}) => ({ email: `${roleCode}@pawspace.test`, roleCode, permissions: [], ...extra });

const view = async (w, input) => {
  const { resolveCustomerDataAccess } = await import("../lib/purpose-based-access.ts");
  return resolveCustomerDataAccess(w.db, { subject: SUBJECT, now: NOW, ...input });
};

// =====================================================================================================
// Contact: phone and email.
// =====================================================================================================

test("R01-1: a sales associate sees a masked phone with no assigned lead", async () => {
  const w = await world();
  const result = await view(w, { actor: actorFor("associate"), purpose: "sales" });
  assert.notEqual(result.contact.phone, SUBJECT.phone, "the real number is not handed over by default");
  assert.match(result.contact.phone, /•/, "it is masked, not omitted - staff still need to recognise a record");
  assert.equal(result.contact.email, "•••@example.com", "email is masked the same way phone always was");
});

test("R01-2: a sales associate assigned to the lead can reveal the contact, and the reveal is logged", async () => {
  const w = await world();
  const result = await view(w, { actor: actorFor("associate"), purpose: "sales",
    assignment: { type: "lead", id: "LEAD-9", assignedTo: "associate@pawspace.test" },
    reveal: { requested: true, reason: "Calling the lead back as promised" } });

  assert.equal(result.contact.phone, SUBJECT.phone, "an assigned rep calling their own lead sees the number");
  assert.equal(result.revealed, true);
  const log = w.sqlite.prepare("SELECT actor_id,reason,subject_id,assignment_id,data_class FROM customer_data_reveals ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(log.actor_id, "associate@pawspace.test");
  assert.match(String(log.reason), /Calling the lead back/);
  assert.equal(log.subject_id, "CUS-1");
  assert.equal(log.assignment_id, "LEAD-9", "the log names which lead justified it");
});

test("R01-3: a reveal without a reason is refused", async () => {
  const w = await world();
  await assert.rejects(() => view(w, { actor: actorFor("associate"), purpose: "sales",
    assignment: { type: "lead", id: "LEAD-9", assignedTo: "associate@pawspace.test" }, reveal: { requested: true, reason: "" } }),
    "a reveal nobody can explain is not a reveal that should happen");
});

test("R01-4: a sales associate cannot reveal a lead assigned to somebody else", async () => {
  const w = await world();
  const result = await view(w, { actor: actorFor("associate"), purpose: "sales",
    assignment: { type: "lead", id: "LEAD-9", assignedTo: "other-rep@pawspace.test" },
    reveal: { requested: true, reason: "curious" } });
  assert.notEqual(result.contact.phone, SUBJECT.phone, "assignment is what justifies the reveal, not the role");
  assert.equal(result.revealed, false);
});

// =====================================================================================================
// Address: the field the audit left open because an associate arranging a home visit needs it.
// =====================================================================================================

test("R01-5: before a booking exists, a sales associate sees area and pincode only", async () => {
  const w = await world();
  const result = await view(w, { actor: actorFor("associate"), purpose: "sales" });
  assert.equal(result.address.line1, null, "the doorstep line is not sales information");
  assert.equal(result.address.area, "Koramangala");
  assert.equal(result.address.pincode, "560034");
  assert.equal(result.address.precision, "area");
});

test("R01-6: an operations associate gets the full address for an assigned booking near execution", async () => {
  const w = await world();
  const result = await view(w, { actor: actorFor("associate"), purpose: "operations",
    assignment: { type: "booking", id: "BK-1", assignedTo: "associate@pawspace.test", status: "confirmed",
      scheduledStart: NOW + 2 * HOUR } });
  assert.equal(result.address.line1, "221B, 5th Block", "somebody sending a groomer to a door needs the door");
  assert.equal(result.address.precision, "full");
});

test("R01-7: the same booking far in the future does not yet open the full address", async () => {
  // "Shortly before service" is the rule. A booking three weeks out does not justify holding somebody's
  // doorstep address on a screen today.
  const w = await world();
  const result = await view(w, { actor: actorFor("associate"), purpose: "operations",
    assignment: { type: "booking", id: "BK-1", assignedTo: "associate@pawspace.test", status: "confirmed",
      scheduledStart: NOW + 21 * 24 * HOUR } });
  assert.equal(result.address.precision, "area", `not yet near execution: ${JSON.stringify(result.address)}`);
});

test("R01-8: an unconfirmed booking does not open the full address however close it is", async () => {
  const w = await world();
  const result = await view(w, { actor: actorFor("associate"), purpose: "operations",
    assignment: { type: "booking", id: "BK-1", assignedTo: "associate@pawspace.test", status: "draft",
      scheduledStart: NOW + HOUR } });
  assert.equal(result.address.precision, "area", "assignment or confirmation is half the rule, not a formality");
});

// =====================================================================================================
// The assigned provider: relay contact, a window that opens and shuts.
// =====================================================================================================

test("R01-9: an assigned provider never gets the raw number - contact goes through the relay", async () => {
  const w = await world();
  const result = await view(w, { actor: actorFor("service_provider", { providerId: "walk_nisha" }), purpose: "service_delivery",
    assignment: { type: "booking", id: "BK-1", assignedTo: "walk_nisha", status: "in_service", scheduledStart: NOW } });
  assert.notEqual(result.contact.phone, SUBJECT.phone);
  assert.equal(result.contact.channel, "relay", "the provider calls through the platform, not the customer's line");
  assert.equal(result.address.precision, "full", "but they do get the address - they have to arrive");
});

test("R01-10: provider access closes after completion plus the dispute window", async () => {
  const w = await world();
  const shortlyAfter = { actor: actorFor("service_provider", { providerId: "walk_nisha" }), purpose: "service_delivery",
    assignment: { type: "booking", id: "BK-1", assignedTo: "walk_nisha", status: "completed",
      scheduledStart: NOW - 2 * HOUR, completedAt: NOW - HOUR } };
  assert.equal((await view(w, shortlyAfter)).address.precision, "full", "the dispute window is still open");

  const longAfter = { ...shortlyAfter, assignment: { ...shortlyAfter.assignment, completedAt: NOW - 60 * 24 * HOUR } };
  const closed = await view(w, longAfter);
  assert.equal(closed.address.precision, "none", "and then it shuts - a finished job is not a standing address book");
  assert.equal(closed.contact.phone, null);
});

// =====================================================================================================
// Notes: separate categories, separate permissions, never leaked outward.
// =====================================================================================================

const NOTES = [
  { id: "N1", category: "sales", body: "Asked about a monthly plan" },
  { id: "N2", category: "operational", body: "Gate code is on the app" },
  { id: "N3", category: "complaint", body: "Complained about the last groomer" },
  { id: "N4", category: "medical", body: "Dog is on seizure medication" },
  { id: "N5", category: "hr", body: "Staff conduct review pending" },
  { id: "N6", category: "operational", body: "Ring the bell twice", shareableWithProvider: true },
];

const notesFor = async (w, actor, purpose, assignment) => {
  const { visibleNotes } = await import("../lib/purpose-based-access.ts");
  return visibleNotes(w.db, { actor, purpose, notes: NOTES, assignment, now: NOW });
};

test("R01-11: each role sees only its own note categories", async () => {
  const w = await world();
  const sales = await notesFor(w, actorFor("associate"), "sales");
  assert.deepEqual(sales.map((note) => note.id), ["N1"], "a sales rep sees sales notes");

  const ops = await notesFor(w, actorFor("associate"), "operations");
  assert.deepEqual(ops.map((note) => note.id).sort(), ["N2", "N6"], "operations sees operational notes");

  const finance = await notesFor(w, actorFor("finance"), "finance");
  assert.deepEqual(finance.map((note) => note.id), [], "and finance sees neither - there are no finance notes here");
});

test("R01-12: complaint, medical and HR notes need their own permission", async () => {
  const w = await world();
  const plain = await notesFor(w, actorFor("manager"), "operations");
  assert.ok(!plain.some((note) => ["complaint", "medical", "hr"].includes(note.category)),
    `sensitive categories are not carried along by seniority alone: ${JSON.stringify(plain.map((n) => n.category))}`);

  const withMedical = await notesFor(w, actorFor("manager", { permissions: ["notes.medical.view"] }), "operations");
  assert.ok(withMedical.some((note) => note.id === "N4"), "a manager granted the medical category sees medical notes");
  assert.ok(!withMedical.some((note) => note.category === "hr"), "and still not HR");
});

test("R01-13a: a provider assigned to a DIFFERENT job sees no notes at all", async () => {
  // Assignment is what justifies the read. Without this the shareable-note rule would hand every
  // provider every customer's service instructions.
  const w = await world();
  const other = await notesFor(w, actorFor("service_provider", { providerId: "walk_nisha" }), "service_delivery",
    { type: "booking", id: "BK-2", assignedTo: "groom_arun", status: "in_service", scheduledStart: NOW });
  assert.deepEqual(other, []);
});

test("R01-13: a provider sees only notes explicitly marked shareable", async () => {
  const w = await world();
  const provider = await notesFor(w, actorFor("service_provider", { providerId: "walk_nisha" }), "service_delivery",
    { type: "booking", id: "BK-1", assignedTo: "walk_nisha", status: "in_service", scheduledStart: NOW });
  assert.deepEqual(provider.map((note) => note.id), ["N6"], "service instructions only, and only the shareable one");
});

test("R01-14: a customer is never shown an internal note", async () => {
  const w = await world();
  const customer = await notesFor(w, actorFor("customer"), "self_service");
  assert.deepEqual(customer, [], "internal notes are internal, including the ones marked shareable with a provider");
});

// =====================================================================================================
// The ends of the ladder.
// =====================================================================================================

test("R01-15: finance sees billing details and nothing else", async () => {
  const w = await world();
  const result = await view(w, { actor: actorFor("finance"), purpose: "finance" });
  assert.equal(result.contact.email, SUBJECT.email, "finance needs a billing contact");
  assert.equal(result.address.precision, "billing", "and a billing address, not a doorstep");
  assert.equal(result.address.line1, null);
});

test("R01-16: compliance sees everything, and the access is logged", async () => {
  // Non-vacuity for every restriction above: if nobody could ever see the data, the platform could not
  // investigate a complaint or answer a regulator.
  const w = await world();
  const result = await view(w, { actor: actorFor("superuser", { permissions: ["*"] }), purpose: "compliance",
    reveal: { requested: true, reason: "Regulatory data subject access request DSAR-14" } });
  assert.equal(result.contact.phone, SUBJECT.phone);
  assert.equal(result.address.line1, "221B, 5th Block");
  const log = w.sqlite.prepare("SELECT actor_id,reason FROM customer_data_reveals ORDER BY created_at DESC LIMIT 1").get();
  assert.match(String(log.reason), /DSAR-14/, "full access is audited access");
});
