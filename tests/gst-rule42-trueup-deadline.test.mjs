/*
 * Rule 42(2) annual true-up deadline (owner decision, 27 Sept 2026): the rule's text once tied this to the September
 * return after the financial year; since the Finance Act 2022 aligned it with the amended section 16(4), the standard
 * is the October return, filed by 30 November after the year. The window check accepts April through October and no
 * longer hedges with a "confirm with the CA" note for anything within it; November and later are refused outright.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors, asActor } from "./helpers/execution-harness.mjs";

installWorkersHooks("__R42_TRUEUP_DB__", "__R42_TRUEUP_ENV__");
const gstAccounting = await import("../lib/gst-accounting.ts");
const gstRoute = await import("../app/api/gst-accounting/route.ts");

const ENTITY = "pawspace_india", REG = "REG-KA", GSTIN = "29AAICT7352F1Z0";
const MAKER = "maker@pawspace.in";
const scope = { entityId: ENTITY, registrationId: REG };

async function trueUpWorld() {
  const { sqlite, db } = world("__R42_TRUEUP_DB__", "__R42_TRUEUP_ENV__", {});
  await seedActors(sqlite, db, [{ id: "U-MK", email: MAKER, role: "finance" }]);
  await gstAccounting.ensureGstAccountingTables(db);
  sqlite.prepare("INSERT INTO finance_entities (id,legal_name,country_code,status,approved_by,approved_at,created_at,updated_at) VALUES (?,?,?,'active','founder',1,1,1)").run(ENTITY, "TK PETCARE SOLUTIONS PRIVATE LIMITED", "IN");
  sqlite.prepare("INSERT INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,effective_to,approved_by,approved_at,created_at,updated_at) VALUES (?,?,'Karnataka','gstin',?,'active','2020-01-01',NULL,'founder',1,1,1)").run(REG, ENTITY, GSTIN);
  return { sqlite, db };
}
const json = async (response) => ({ status: response.status, body: await response.json() });
const trueUp = (body) => gstRoute.POST(asActor(MAKER, "/api/gst-accounting", { method: "POST", body: JSON.stringify({ action: "rule42_annual_true_up", ...scope, ...body }) })).then(json);

test("Rule 42(2) true-up: the October return (30 November deadline) succeeds with no CA hedge", async () => {
  await trueUpWorld();
  const r = await trueUp({ financialYear: "2022-23", applyInPeriod: "2023-10", reason: "Annual true-up for FY 2022-23" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.deadlineNote, null);
  assert.equal(r.body.data.applyInPeriod, "2023-10");
});

test("Rule 42(2) true-up: April through September also still succeed, no hedge either", async () => {
  await trueUpWorld();
  const r = await trueUp({ financialYear: "2022-23", applyInPeriod: "2023-09", reason: "Annual true-up for FY 2022-23" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.deadlineNote, null);
});

test("Rule 42(2) true-up: November (past the 30 November deadline) is refused, naming October as the standard", async () => {
  await trueUpWorld();
  const r = await trueUp({ financialYear: "2022-23", applyInPeriod: "2023-11", reason: "Annual true-up for FY 2022-23" });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /April to October 2023/);
  assert.match(r.body.error, /30 November/);
});
