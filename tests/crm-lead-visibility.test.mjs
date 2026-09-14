/*
 * "Lead not found in CRM."
 *
 * Nine code paths insert into crm_contacts. Exactly two write the organizational scope columns
 * city_id, team_code and department_code: app/api/crm (a staff member creating a lead by hand) and
 * app/api/public-contact (the website form). The other seven leave all three NULL —
 *
 *   lib/interakt-whatsapp-base.ts        WhatsApp leads
 *   lib/haptik-integration-governance.ts public chat leads
 *   lib/inbound-ai-lead-capture.ts       AI-captured inbound leads
 *   app/api/admin/data-ingest            bulk import
 *   app/api/system-integration           integration sync
 *   app/api/revenue-crm                  revenue seeding
 *   app/api/canonical-bookings           a booking creating its own contact
 *
 * — and the list read filtered on `lower(COALESCE(city_id,''))=?`, which no real scope can equal.
 * Every lead from those seven was therefore invisible to every scoped user, while sitting in the
 * table the whole time. An unclaimed lead belongs to nobody, not to somebody else, so hiding it from
 * everybody is the one outcome that guarantees nobody works it.
 *
 * These tests run the real SQL. The route's own WHERE clause is rebuilt here against a real SQLite
 * table because the route body cannot be imported (it authenticates and reaches for a D1 binding),
 * so the clause is what is under test — that is what was wrong, and it is what a regression would
 * change. CRM-5 pins the two halves together by failing if the route stops using the clause shape
 * these tests prove.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { importLibModule } from "./helpers/ts-module-loader.mjs";

const route = fs.readFileSync(new URL("../app/api/crm/route.ts", import.meta.url), "utf8");

/* Imported, not scraped: these tests run the exact statement and bind order production runs, so
 * re-excluding unclaimed leads turns CRM-1 red instead of passing against a clause nobody uses. */
const { CRM_CONTACT_LIST_SQL, crmContactListBinds } = await importLibModule("crm-contact-list");
const LIST = CRM_CONTACT_LIST_SQL.replace("SELECT *", "SELECT id");

const SCOPE = { cityId: "blr", teamCode: "sales", departmentCode: "cc-sales" };

function crmTable() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE crm_contacts (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,email TEXT,city_id TEXT,team_code TEXT,department_code TEXT,updated_at INTEGER)");
  const add = (id, { name = "Lead", phone = "9000000000", email = "lead@example.com", city = null, team = null, dept = null, at = 1 } = {}) =>
    db.prepare("INSERT INTO crm_contacts VALUES (?,?,?,?,?,?,?,?)").run(id, name, phone, email, city, team, dept, at);
  /* Bound exactly as the route binds: scope flag, the three scope values, search flag, the term four
   * times. Escaping matches the route so a term containing % or _ is a literal, not a wildcard. */
  const visible = (search = "", scope = SCOPE) =>
    db.prepare(LIST).all(...crmContactListBinds(scope, search)).map((r) => r.id);
  return { add, visible };
}

test("CRM-1: a WhatsApp or chat lead with no scope is visible, not hidden from everyone", () => {
  const { add, visible } = crmTable();
  add("LEAD-WHATSAPP");                                                     // interakt: no scope columns
  add("LEAD-CHAT", { city: "", team: "", dept: "" });                       // haptik: empty rather than NULL
  add("LEAD-OWN", { city: "blr", team: "sales", dept: "cc-sales" });        // this manager's own
  assert.deepEqual(visible().sort(), ["LEAD-CHAT", "LEAD-OWN", "LEAD-WHATSAPP"],
    "leads created by the seven paths that write no scope were invisible to every scoped user");
});

test("CRM-2: another city's leads stay filtered out", () => {
  const { add, visible } = crmTable();
  add("LEAD-HYD", { city: "hyd", team: "sales", dept: "cc-sales" });
  add("LEAD-OTHER-TEAM", { city: "blr", team: "support", dept: "cc-sales" });
  add("LEAD-OWN", { city: "blr", team: "sales", dept: "cc-sales" });
  assert.deepEqual(visible(), ["LEAD-OWN"],
    "restoring unclaimed leads must not widen the scope across cities or teams");
});

test("CRM-3: a partially scoped lead is not treated as unclaimed", () => {
  const { add, visible } = crmTable();
  add("LEAD-HALF", { city: "hyd", team: null, dept: null });
  assert.deepEqual(visible(), [],
    "a lead carrying another city is that city's, even with the other two columns blank");
});

test("CRM-4: search finds a lead by name, phone, email or id across the table", () => {
  const { add, visible } = crmTable();
  add("LEAD-OLD", { name: "Meera Iyer", phone: "9876500011", email: "meera@example.com", at: 1 });
  for (let i = 0; i < 150; i++) add(`LEAD-NOISE-${i}`, { name: "Someone Else", at: 1000 + i });
  for (const [label, term] of [["name", "meera"], ["phone", "9876500011"], ["email", "meera@example"], ["id", "lead-old"]]) {
    assert.ok(visible(term).includes("LEAD-OLD"), `search by ${label} did not find a lead outside the newest 100`);
  }
});

test("CRM-5: the route runs this statement, and it admits unclaimed leads", () => {
  assert.match(route, /db\.prepare\(CRM_CONTACT_LIST_SQL\)\.bind\(\.\.\.crmContactListBinds\(/,
    "the route must run the statement these tests exercise, not one of its own");
  assert.match(route, /searchParams\.get\("search"\)/,
    "search must reach the database; filtering the fetched page cannot see past LIMIT 100");
  assert.match(CRM_CONTACT_LIST_SQL, /OR \(COALESCE\(TRIM\(city_id\),''\)=''/,
    "unclaimed leads must be admitted alongside the manager's own scope");
  assert.match(CRM_CONTACT_LIST_SQL, /ESCAPE/,
    "a search term containing % or _ must be escaped rather than treated as a wildcard");
});
