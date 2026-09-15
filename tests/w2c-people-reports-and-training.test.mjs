/**
 * People reports and provider training: the controls the backing APIs support, and the numbers the
 * screens were stating as facts their source cannot state.
 *
 *   1. /api/people-reports takes `?start=` and `?end=`, and lib/people-reports.ts scopes joiners,
 *      leavers, attendance, the payroll register and its variance, incentives, expenses, statutory
 *      exports and both audit trails to them. The screen posted NEITHER and displayed NEITHER end of
 *      the resolved period, so every one of those numbers silently meant "month-to-date" and closing
 *      LAST month - the reason the report exists - was not expressible. Proved below by asking the
 *      real route the same question twice and getting two different, both-correct answers.
 *   2. The same screen rendered "statutory sandbox exports 0" to a manager-scoped actor, for whom
 *      lib/people-reports.ts never queries statutory exports at all, and footed itself with hard-coded
 *      prose while the payload carried the truth flags.
 *   3. /team/people/provider-training showed "(cross) Name - 0/0 required modules" for a provider whose
 *      service set is unknown. lib/provider-lms.ts distinguishes that case by name
 *      (`provider_services_unknown`) and GET /api/provider-lms?providerId= already returns it; no
 *      control asked for it.
 *
 * Everything executes: the real route handlers over a real SQLite-backed D1, and the shipped screens
 * rendered with react-dom/server.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";

installWorkersHooks("__W2C_REPORTS_DB__", "__W2C_REPORTS_ENV__");

// The provider-training screen imports `../../../components/ui`, a DIRECTORY barrel that pulls
// recharts. Node's ESM resolver does not fold in an index file, and recharts' CJS/redux chain cannot
// be linked from a synchronous resolve hook. Neither is the code under test. Same treatment as
// tests/people-money-screen-governance.test.mjs.
const RECHARTS_STUB = `data:text/javascript,${encodeURIComponent(
  ["ResponsiveContainer", "LineChart", "Line", "BarChart", "Bar", "XAxis", "YAxis", "CartesianGrid", "Tooltip", "Legend"]
    .map((name) => `export const ${name}=()=>null;`).join(""),
)}`;
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "recharts") return { url: RECHARTS_STUB, shortCircuit: true };
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
        for (const candidate of [`${specifier}/index.ts`, `${specifier}/index.tsx`]) {
          try { return nextResolve(candidate, context); } catch { /* try the next candidate */ }
        }
      }
      throw error;
    }
  },
});

const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const reportsRoute = await import("../app/api/people-reports/route.ts");
const lmsRoute = await import("../app/api/provider-lms/route.ts");
const reportsScreen = await import("../app/team/people/reports/page.tsx");
const trainingScreen = await import("../app/team/people/provider-training/page.tsx");
const { ensureSecurityTables } = await import("../lib/server-auth.ts");
const { ensurePeopleTables } = await import("../lib/people-foundation.ts");
const { saveLmsModule, setLmsModuleStatus } = await import("../lib/provider-lms.ts");

const AUDITOR = "audit@pawspace.test";      // reports.view + payroll.view + audit.view -> company-wide scope
const ADMIN = "admin@pawspace.test";        // + finance.view, still company-wide
// A CUSTOM role (the product supports them through save_role): reports.view and finance.view without
// people.manage/payroll.view/audit.view. That is the only shape that produces a finance section
// rendered at reporting-line scope, which is exactly where the statutory zero was misleading.
const CITY_FINANCE = "cityfin@pawspace.test";
const NOW = Date.UTC(2026, 8, 15);
const AUGUST_START = Date.parse("2026-08-01T00:00:00.000+05:30");
const AUGUST_END = Date.parse("2026-08-31T23:59:59.999+05:30");

const getReports = (email, query = "") => reportsRoute.GET(new Request(`https://uat.pawspace.in${query || "/api/people-reports"}`, { headers: { "oai-authenticated-user-email": email } }));
const getLms = (email, query = "") => lmsRoute.GET(new Request(`https://uat.pawspace.in/api/provider-lms${query}`, { headers: { "oai-authenticated-user-email": email } }));
const answer = async (response) => ({ status: response.status, body: await response.json() });

async function world() {
  const { db, sqlite } = freshCountingD1();
  globalThis.__W2C_REPORTS_DB__ = db;
  globalThis.__W2C_REPORTS_ENV__ = {};
  enterWorkersDbScope(db);
  await ensureSecurityTables(db);
  await ensurePeopleTables(db);
  const user = sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)");
  user.run("U-AUD", AUDITOR, "Ana Auditor", "auditor", NOW, NOW);
  user.run("U-ADMIN", ADMIN, "Ada Admin", "admin", NOW, NOW);
  sqlite.prepare("INSERT INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES ('city_finance_lead','City finance lead','Reads People reports and the finance boundary for their own reporting line.',?,0,?)")
    .run(JSON.stringify(["dashboard.view", "reports.view", "people.view", "attendance.view", "finance.view"]), NOW);
  user.run("U-CITYFIN", CITY_FINANCE, "Cyrus City Finance", "city_finance_lead", NOW, NOW);
  return { db, sqlite };
}

const addEmployee = (sqlite, id, code, name, joinedAt, endedAt = null, status = "active") =>
  sqlite.prepare("INSERT INTO employees (id,user_email,employee_code,display_name,work_email,employment_status,joined_at,ended_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, `${code.toLowerCase()}@pawspace.test`, code, name, `${code.toLowerCase()}@pawspace.test`, status, joinedAt, endedAt, NOW, NOW);

// =================================================================================================
// 1. The reporting period: a control the API supported and no control posted
// =================================================================================================

test("the period control asks the API a different question and gets a different, correct answer", async () => {
  const { sqlite } = await world();
  addEmployee(sqlite, "EMP-AUG", "PSAUG", "Aug Joiner", Date.UTC(2026, 7, 12));
  addEmployee(sqlite, "EMP-SEP", "PSSEP", "Sep Joiner", Date.UTC(2026, 8, 9));
  addEmployee(sqlite, "EMP-LEFT", "PSLEFT", "Aug Leaver", Date.UTC(2025, 0, 6), Date.UTC(2026, 7, 20), "exited");

  // The month-to-date default the screen was frozen on: August is invisible.
  const monthToDate = await answer(await getReports(AUDITOR));
  assert.equal(monthToDate.status, 200);
  assert.equal(monthToDate.body.data.headcount.joiners, 1, "September's joiner only");
  assert.equal(monthToDate.body.data.headcount.leavers, 0, "August's leaver falls outside month-to-date");

  // The URL the screen's own control builds for "last month".
  const url = reportsScreen.peopleReportQuery({ start: "2026-08-01", end: "2026-08-31" });
  assert.equal(url, `/api/people-reports?start=${AUGUST_START}&end=${AUGUST_END}`);
  const august = await answer(await getReports(AUDITOR, url));
  assert.equal(august.status, 200);
  assert.equal(august.body.data.period.startDate, "2026-08-01");
  assert.equal(august.body.data.period.endDate, "2026-08-31");
  assert.equal(august.body.data.headcount.joiners, 1, "August's joiner");
  assert.equal(august.body.data.headcount.leavers, 1, "August's leaver, which month-to-date could not show");

  // A half-filled form is still a legal question, and an empty one is the default.
  assert.equal(reportsScreen.peopleReportQuery({ start: "2026-08-01", end: "" }), `/api/people-reports?start=${AUGUST_START}`);
  assert.equal(reportsScreen.peopleReportQuery({ start: "", end: "" }), "/api/people-reports");
  assert.equal((await answer(await getReports(AUDITOR, reportsScreen.peopleReportQuery({ start: "2026-08-01", end: "" })))).status, 200);

  // A reversed range never leaves the screen.
  assert.match(reportsScreen.invalidPeriod({ start: "2026-08-31", end: "2026-08-01" }), /on or after/);
  assert.equal(reportsScreen.invalidPeriod({ start: "2026-08-01", end: "2026-08-31" }), "");
});

test("the screen shows the period it is reporting on, and the control that changes it", async () => {
  const { sqlite } = await world();
  addEmployee(sqlite, "EMP-AUG", "PSAUG", "Aug Joiner", Date.UTC(2026, 7, 12));
  const august = await answer(await getReports(AUDITOR, reportsScreen.peopleReportQuery({ start: "2026-08-01", end: "2026-08-31" })));
  const html = renderToStaticMarkup(React.createElement(reportsScreen.PeopleReportsScreen, {
    data: august.body.data, busy: false, draft: { start: "2026-08-01", end: "2026-08-31" }, onDraft: () => {}, onApply: () => {},
  }));
  assert.match(html, /Reporting period/);
  assert.match(html, /Apply period/);
  assert.match(html, /2026-08-01 → 2026-08-31/, "the operator must be able to read which window the numbers describe");
  assert.match(html, /Joiners in period/);
  assert.match(html, /Leavers in period/);

  // The reversed range disables Apply rather than sending it.
  const reversed = renderToStaticMarkup(React.createElement(reportsScreen.PeopleReportsScreen, {
    data: august.body.data, busy: false, draft: { start: "2026-08-31", end: "2026-08-01" }, onDraft: () => {}, onApply: () => {},
  }));
  assert.match(reversed, /<button disabled=""[^>]*>Apply period<\/button>/);
  assert.match(reversed, /must fall on or after/);
});

test("the screen states the truth flags the payload carries, not a hard-coded footer", async () => {
  await world();
  const live = await answer(await getReports(AUDITOR));
  const data = live.body.data;
  assert.equal(data.truth.productionReady, false);
  assert.match(renderToStaticMarkup(React.createElement(reportsScreen.PeopleReportsScreen, { data, busy: false, draft: { start: "", end: "" }, onDraft: () => {}, onApply: () => {} })),
    /<b>Production ready:<\/b> NO/);
  // The same screen against a payload that says otherwise must say otherwise.
  const flipped = { ...data, truth: { ...data.truth, productionReady: true, staticDemoCountersAccepted: true } };
  const html = renderToStaticMarkup(React.createElement(reportsScreen.PeopleReportsScreen, { data: flipped, busy: false, draft: { start: "", end: "" }, onDraft: () => {}, onApply: () => {} }));
  assert.match(html, /<b>Production ready:<\/b> YES/);
  assert.match(html, /<b>Static\/demo performance truth:<\/b> YES/);
});

test("a manager-scoped actor is not shown a company-wide zero as if it were their number", async () => {
  const { sqlite } = await world();
  addEmployee(sqlite, "EMP-CITYFIN", "PSCITY", "Cyrus City Finance", Date.UTC(2025, 0, 6));
  sqlite.prepare("UPDATE employees SET user_email=?, work_email=? WHERE id='EMP-CITYFIN'").run(CITY_FINANCE, CITY_FINANCE);

  const managerScoped = await answer(await getReports(CITY_FINANCE));
  assert.equal(managerScoped.status, 200);
  assert.equal(managerScoped.body.data.scope.mode, "manager");
  assert.equal(managerScoped.body.data.finance.available, true, "this actor DOES hold finance.view - the section is drawn");
  assert.deepEqual(managerScoped.body.data.finance.statutoryExports, [], "but the engine never queries statutory exports at this scope");

  const html = renderToStaticMarkup(React.createElement(reportsScreen.PeopleReportsScreen, {
    data: managerScoped.body.data, busy: false, draft: { start: "", end: "" }, onDraft: () => {}, onApply: () => {},
  }));
  assert.match(html, /statutory exports are reported company-wide only/);
  assert.doesNotMatch(html, /statutory sandbox exports 0/, "a scope gap must not be rendered as a count of zero");
  assert.match(html, /your reporting line/);

  const companyWide = await answer(await getReports(ADMIN));
  assert.equal(companyWide.body.data.scope.mode, "all");
  const companyHtml = renderToStaticMarkup(React.createElement(reportsScreen.PeopleReportsScreen, {
    data: companyWide.body.data, busy: false, draft: { start: "", end: "" }, onDraft: () => {}, onApply: () => {},
  }));
  assert.match(companyHtml, /whole company/);
  assert.match(companyHtml, /statutory sandbox exports 0/, "at company scope the zero IS the count");
});

test("an empty period explains itself instead of rendering an empty section", async () => {
  await world();
  const empty = await answer(await getReports(AUDITOR));
  const html = renderToStaticMarkup(React.createElement(reportsScreen.PeopleReportsScreen, {
    data: empty.body.data, busy: false, draft: { start: "", end: "" }, onDraft: () => {}, onApply: () => {},
  }));
  assert.match(html, /No attendance exception was raised in this period/);
  assert.match(html, /Two payroll runs must fall inside the selected period/, "the variance gap must name the period as the thing to change");
});

// =================================================================================================
// 2. Provider training: the readiness reason the API returns and no control asked for
// =================================================================================================

async function lmsWorld() {
  const { db, sqlite } = await world();
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('U-OPS','ops@pawspace.test','Ops Manager','manager','active',?,?)").run(NOW, NOW);
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_capacity_profiles (id TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL,live INTEGER NOT NULL DEFAULT 0,services_json TEXT NOT NULL DEFAULT '[]')");
  sqlite.prepare("INSERT INTO provider_capacity_profiles (id,name,status,live,services_json) VALUES (?,?,'active',1,?)").run("PRV-KNOWN", "Known Services", JSON.stringify(["grooming"]));
  sqlite.prepare("INSERT INTO provider_capacity_profiles (id,name,status,live,services_json) VALUES (?,?,'active',1,?)").run("PRV-UNKNOWN", "Unknown Services", JSON.stringify([]));
  const saved = await saveLmsModule(db, {
    title: "Grooming safety SOP", serviceCode: "grooming", summary: "Handling and clipper safety",
    sections: ["Restraint", "Clipper temperature"], quiz: [{ question: "When do you stop clipping?", options: ["When the blade is hot", "Never"], answerIndex: 0 }],
    passPct: 80, required: true, actorId: "ops@pawspace.test",
  });
  await setLmsModuleStatus(db, { moduleId: saved.moduleId, status: "published", actorId: "ops@pawspace.test" });
  return { db, sqlite, moduleId: saved.moduleId };
}

test("a provider with no recorded services is reported as UNKNOWN, not as nothing-outstanding", async () => {
  await lmsWorld();
  const unknown = await answer(await getLms("ops@pawspace.test", "?providerId=PRV-UNKNOWN"));
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.data.trainingReady, false);
  assert.equal(unknown.body.data.readinessReason, "provider_services_unknown");
  assert.equal(unknown.body.data.requiredTotal, 0);
  assert.equal(unknown.body.data.requiredComplete, 0);

  const known = await answer(await getLms("ops@pawspace.test", "?providerId=PRV-KNOWN"));
  assert.equal(known.body.data.readinessReason, "required_modules_outstanding");
  assert.equal(known.body.data.requiredTotal, 1);
  assert.equal(known.body.data.requiredComplete, 0);

  // The fleet overview both providers appear in cannot tell those two apart: 0/0 and a cross.
  const overview = await answer(await getLms("ops@pawspace.test"));
  const row = overview.body.data.providers.find((p) => p.providerId === "PRV-UNKNOWN");
  assert.deepEqual([row.trainingReady, row.requiredComplete, row.requiredTotal], [false, 0, 0]);
  assert.equal(row.readinessReason, undefined, "the overview carries no reason - which is why the drill-down exists");

  // The screen's explanation refuses to read 0/0 as "done".
  assert.match(trainingScreen.readinessExplanation(unknown.body.data), /we do not know what they do/);
  assert.match(trainingScreen.readinessExplanation(known.body.data), /1 of 1 required module\(s\) outstanding/);
  assert.match(trainingScreen.readinessExplanation({ ...known.body.data, readinessReason: "required_modules_complete", requiredComplete: 1 }), /Every required module is complete/);
});

test("the provider training drill-down is refused to an actor who does not manage providers", async () => {
  const { sqlite } = await lmsWorld();
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('U-ASSOC','assoc@pawspace.test','Ann Associate','associate','active',?,?)").run(NOW, NOW);
  const refused = await answer(await getLms("assoc@pawspace.test", "?providerId=PRV-KNOWN"));
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, "Provider ownership denied");
});

test("the module author form still refuses exactly what the engine refuses", () => {
  const complete = { title: "Grooming safety SOP", summary: "Handling and clipper safety", sections: "Restraint\nClipper temperature", question: "When do you stop clipping?", options: "When the blade is hot|Never", answerIndex: "0", passPct: "80" };
  assert.deepEqual(trainingScreen.missingModuleFields(complete), []);
  assert.ok(trainingScreen.missingModuleFields({ ...complete, options: "Only one" }).some((m) => /two answer options/.test(m)));
  assert.ok(trainingScreen.missingModuleFields({ ...complete, answerIndex: "5" }).some((m) => /between 0 and 1/.test(m)));
  assert.ok(trainingScreen.missingModuleFields({ ...complete, passPct: "0" }).some((m) => /pass mark between 1 and 100/.test(m)));
});
