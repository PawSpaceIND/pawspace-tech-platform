/*
 * "The server found the customer and the screen showed nothing."
 *
 * Two defects on /crm, both in the gap between what the API serves and what the page renders, and
 * both invisible to a source-text test. These run the REAL route against real SQLite, take its real
 * response, and push it through the REAL functions app/crm/page.tsx renders with.
 *
 * 1. SEARCH BY NAME OR FULL PHONE RETURNED NOTHING.
 *    Search moved to the server so a lead outside the newest 100 could be found at all - the server
 *    searches name, phone, email, pet and id on the RAW stored values. The page then re-filtered the
 *    result client-side against `${c.name} ${c.phone} ${c.pets} ${c.id}`, but those fields arrive
 *    MASKED for display: "A•••• L• B•" and "+91 ••••••0011". A masked string cannot contain the text
 *    it was masked to hide, so every row the server had just matched was dropped before render.
 *    Measured in-browser: the API returned 2 contacts for "Audit", the screen rendered 0. A pet name
 *    (never masked) and the last four digits (they survive masking) still worked, which is why this
 *    looked intermittent rather than broken.
 *
 * 2. THE "Follow-up due" SEGMENT.
 *    The dropdown label is display text; crm_contacts.stage is stored data. Every production writer
 *    of a follow-up contact - app/api/revenue-crm's seed pass, scripts/uat-demo-seed.sql - stores
 *    "Follow-up", while app/admin's customer model spells the same state "Follow-up due". stage is
 *    free text with no CHECK constraint, so either spelling can reach this screen and the segment
 *    must accept both; matching only the label would make it permanently empty.
 *
 * Masking is not the defect and is not relaxed here: these tests also assert that what reaches the
 * screen is still the masked phone and email, never the raw ones.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__CRM_RENDER_DB__", "__CRM_RENDER_ENV__");

/** The same minimal D1 shim the other real-execution CRM suites use. */
function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => { const out = []; for (const item of statements) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

/*
 * A live CRM API over an in-memory database whose schema the ROUTE creates, so these fixtures cannot
 * drift from production DDL: the first GET runs the route's own ensureTables.
 */
async function crmApi() {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__CRM_RENDER_DB__ = makeD1(sqlite);
  globalThis.__CRM_RENDER_ENV__ = {};
  const route = await import("../app/api/crm/route.ts");
  await route.GET(new Request("http://localhost/api/crm"));
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,status TEXT,total_amount REAL,created_at INTEGER)");
  let clock = 1;
  const add = ({ id, name, phone, email = null, pets = "Pet", petSummary = "Profile incomplete", stage = "New lead", lifetime = 0 }) =>
    sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,secondary_phone,email,area,pet_names,pet_summary,stage,owner,source,lifetime_value,next_action,opportunity,created_at,updated_at) VALUES (?,?,?,NULL,?,'Bengaluru',?,?,?,'Neha','uat_seed',?,'Call today','Grooming',?,?)")
      .run(id, name, phone, email, pets, petSummary, stage, lifetime, clock, clock++);
  /* Lifetime value is COMPUTED by the route from recognised bookings, so a High value fixture has to
   * own a real booking - the stored crm_contacts.lifetime_value column is overwritten. */
  const book = (customerId, amount) =>
    sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,status,total_amount,created_at) VALUES (?,?,'completed',?,?)")
      .run(`BK-${customerId}`, customerId, amount, clock++);
  const search = async (term) => {
    const url = `http://localhost/api/crm${term ? `?search=${encodeURIComponent(term)}` : ""}`;
    const response = await route.GET(new Request(url));
    assert.equal(response.status, 200, "the CRM read must succeed for these fixtures");
    return (await response.json()).contacts;
  };
  return { add, book, search };
}

const page = await import("../app/crm/page.tsx");
const { maskName, maskPhone } = await import("../lib/platform-security.ts");
const React = (await import("react")).default;
const { renderToStaticMarkup } = await import("react-dom/server");

/*
 * Exactly what CrmPage does with a response: map every served row through toContact, narrow by
 * segment, and hand the result to CustomerRows. No re-implementation - these are the page's own
 * functions, imported from the page.
 */
function screen(served, segment = "All customers") {
  const contacts = served.map(page.toContact);
  const rendered = page.visibleContacts(contacts, segment);
  const html = renderToStaticMarkup(React.createElement(page.CustomerRows, {
    contacts: rendered, selectedId: rendered[0]?.id ?? "", onSelect: () => {},
  }));
  return { rendered, html, text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() };
}

async function auditFixture() {
  const api = await crmApi();
  api.add({ id: "CU-7B73", name: "Audit Lead Alpha", phone: "9876500011", email: "alpha@example.com", pets: "Bruno" });
  api.add({ id: "CU-7B74", name: "Audit Lead Beta", phone: "9876500022", email: "beta@example.com", pets: "Bruno" });
  api.add({ id: "CU-9001", name: "Someone Else", phone: "9000000000", pets: "Zara" });
  return api;
}

test("CRM-R1: a contact the server matched by NAME is rendered, not discarded", async () => {
  const api = await auditFixture();
  const served = await api.search("Audit");
  assert.equal(served.length, 2, "the server matched both contacts on the raw name");

  const { rendered, text } = screen(served);
  assert.equal(rendered.length, 2, "the screen rendered 0 of these 2 while a client text filter ran");
  assert.match(text, /CU-7B73|A•/, "the matched rows really are in the markup");
  assert.ok(text.includes(maskName("Audit Lead Alpha")), "and they are drawn with the masked display name");

  /* Why any client-side text filter over a served row is wrong, stated as an executable fact rather
   * than as a claim in a comment: the served fields no longer contain the term the server matched. */
  for (const row of rendered) {
    assert.equal(`${row.name} ${row.phone} ${row.pets} ${row.id}`.toLowerCase().includes("audit"), false,
      "the masked row cannot contain the search term, so re-filtering on it can only ever discard matches");
  }
});

test("CRM-R2: a FULL phone number search reaches the screen", async () => {
  const api = await auditFixture();
  const served = await api.search("9876500011");
  assert.equal(served.length, 1, "the server matched the stored number");

  const { rendered, text } = screen(served);
  assert.equal(rendered.length, 1, "a full 10-digit search rendered nothing before this fix");
  assert.equal(rendered[0].id, "CU-7B73");
  assert.ok(text.includes(maskPhone("9876500011")), "the row shows the masked number");
  assert.equal(text.includes("9876500011"), false, "and never the raw one");
});

test("CRM-R3: the searches that accidentally still worked keep working", async () => {
  // A pet name is never masked and the last four digits survive masking, so these two were the only
  // searches that ever reached the screen. They must not regress into the fix.
  const api = await auditFixture();
  assert.equal(screen(await api.search("Bruno")).rendered.length, 2, "pet name");
  assert.equal(screen(await api.search("0011")).rendered.length, 1, "last four digits");
  assert.equal(screen(await api.search("cu-7b73")).rendered.length, 1, "customer id");
  assert.equal(screen(await api.search("nobody-by-that-name")).rendered.length, 0, "a term nobody matches still shows nothing");
});

test("CRM-R4: the Follow-up due segment matches contacts actually stored with that stage", async () => {
  const api = await crmApi();
  // "Follow-up" is what app/api/revenue-crm and scripts/uat-demo-seed.sql actually write; "Follow-up
  // due" is app/admin's spelling of the same state. stage is free text, so both can arrive here.
  api.add({ id: "CU-F1", name: "Follow Up One", phone: "9811100001", stage: "Follow-up" });
  api.add({ id: "CU-F2", name: "Follow Up Two", phone: "9811100002", stage: "Follow-up due" });
  api.add({ id: "CU-N1", name: "New Lead One", phone: "9811100003", stage: "New lead" });
  api.add({ id: "CU-H1", name: "High Value", phone: "9811100004", stage: "Active customer" });
  api.book("CU-H1", 40000);
  const served = await api.search("");

  const followUp = screen(served, "Follow-up due");
  assert.deepEqual(followUp.rendered.map((row) => row.id).sort(), ["CU-F1", "CU-F2"],
    "the segment compared the dropdown label against a stage no writer stores, so it matched nothing");
  assert.match(followUp.text, /Follow-up/, "and the rows it selects really render");

  assert.equal(screen(served, "All customers").rendered.length, 4, "All customers narrows nothing");
  assert.deepEqual(screen(served, "High value").rendered.map((row) => row.id), ["CU-H1"],
    "the other segments are unchanged");
});

test("CRM-R5: masking still applies to the phone and email the screen displays", async () => {
  const api = await crmApi();
  api.add({ id: "CU-M1", name: "Masked Person", phone: "9876512345", email: "masked.person@example.com" });
  const [served] = await api.search("");

  assert.equal(served.revealed, false, "a list is not a reveal - no reason, no record, no audit row");
  assert.equal(served.primary_phone, maskPhone("9876512345"), "the served number is masked by policy");
  assert.equal(served.email, "•••@example.com", "and so is the address");
  assert.equal(served.name, maskName("Masked Person"), "the route's own name mask is unchanged");

  const { text } = screen([served]);
  assert.equal(text.includes("9876512345"), false, "no raw number reaches the rendered row");
  assert.equal(text.includes("Masked Person"), false, "and no raw name either");
  assert.ok(text.includes(maskPhone("9876512345")), "what staff see is the masked number");
});

/*
 * The four tests above run the real functions the screen renders with. This one pins them TO the
 * screen: react-dom/server renders a component's initial state and does not run effects, so the
 * component's own `contacts` state - the thing the fetched rows land in - is out of reach of an
 * executable test, and a second text filter reintroduced inside CrmPage would not fail any of them.
 * Same role CRM-5 plays in tests/crm-lead-visibility.test.mjs: behaviour is proved by execution, and
 * this keeps the executed code on the render path.
 */
test("CRM-R6: the rendered list is exactly visibleContacts - nothing filters on text downstream", () => {
  const crmPage = readFileSync(new URL("../app/crm/page.tsx", import.meta.url), "utf8");
  assert.match(crmPage, /const filtered=useMemo\(\(\)=>visibleContacts\(contacts,segment\),\[contacts,segment\]\)/,
    "the row list must be the predicate these tests execute, not one the component builds for itself");
  assert.doesNotMatch(crmPage, /\$\{c\.name\}[\s\S]{0,40}\.toLowerCase\(\)\.includes\(/,
    "a client text filter over served rows matches masked strings and can only discard server matches");
  assert.equal(crmPage.match(/contacts\.filter\(/g)?.length, 1,
    "contacts are narrowed in exactly one place, and it is the exported predicate");
});
