/*
 * The Control Center may only say things that are true of the data at the moment it says them.
 *
 * lib/control-center-operations.ts is a pure reader with two degrading helpers, and until this change
 * both of them collapsed several different situations into one indistinguishable answer that the
 * panel then had to cover with a single sentence:
 *
 *   /control -> Master settings   printed "No recent records in this source." underneath its own
 *                                 cards reading "Cities 1 · Services 10 · Policies 35 · Packages 60 ·
 *                                 Price rules 6" - 112 rows. No evidence query was ever issued for
 *                                 that mode; it returned a hardcoded `rows:[]`, and `rows.length ? …`
 *                                 turned a literal empty array into a factual claim about five
 *                                 connected, non-empty tables on the same screen.
 *
 *   /control -> Quality           printed the SAME sentence about unified_cases, a table sqlite_master
 *                                 says does not exist. Every card above it read "n/c · not connected",
 *                                 so one screen asserted both "there is no source" and "the source has
 *                                 no recent records".
 *
 *   every cold worker             read "not connected" for Cities, Packages, Price rules,
 *                                 Integrations, Integration blockers and Outbox pending, then read
 *                                 real counts minutes later with no deploy and no schema change,
 *                                 because unrelated screens had run their own CREATE TABLE IF NOT
 *                                 EXISTS. "not connected" was describing the worker's warm-up and
 *                                 stating it as a fact about the platform.
 *
 * Every test here EXECUTES the real module against node:sqlite through the shared D1 shim, and where
 * the defect is what the screen SAYS, it renders the real panel components with react-dom/server, so
 * the sentence under test is the sentence a founder reads.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { importLibModule } from "./helpers/ts-module-loader.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__CONTROL_EVIDENCE_DB__");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { buildControlCenterOperations } = await importLibModule("control-center-operations");
const MODES = ["approvals", "master", "inventory", "quality", "security", "health", "audit"];
/* The sentence this whole file exists to delete. It must never be produced by any state again. */
const THE_OLD_LIE = /no recent records in this source/i;

// --- canonical schemas -------------------------------------------------------------------------
/* Tables are created from their own shipping CREATE TABLE, never from a convenient minimal one: a
 * hand-written fixture would prove the module works against the fixture, which is not the claim. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist", ".wrangler"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.(ts|sql)$/.test(entry.name)) out.push(path);
  }
  return out;
}
const SCHEMAS = (() => {
  const found = new Map();
  for (const file of walk(join(ROOT, "lib")).concat(walk(join(ROOT, "drizzle")))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? ([a-z_]+) \(/gi)) {
      let i = match.index + match[0].length, depth = 1, body = "";
      while (i < text.length && depth > 0) {
        const ch = text[i];
        if (ch === "(") depth++;
        else if (ch === ")") { depth--; if (!depth) break; }
        body += ch; i++;
      }
      const prior = found.get(match[1]);
      if (!prior || prior.length < body.length) found.set(match[1], body);
    }
  }
  return found;
})();
function createCanonical(sqlite, ...tables) {
  for (const table of tables) {
    const body = SCHEMAS.get(table);
    assert.ok(body, `no canonical CREATE TABLE found for ${table} - this fixture would prove nothing`);
    sqlite.exec(`CREATE TABLE IF NOT EXISTS ${table} (${body})`);
  }
}
/* Fill every NOT NULL / key column the canonical schema declares. Writing the column list by hand
 * ties the fixture to one table's shape and breaks the moment that table gains a column - which is
 * how a fixture ends up quietly narrower than the schema it is supposed to stand in for. */
function insertRows(sqlite, table, n, overrides = {}) {
  const info = sqlite.prepare(`PRAGMA table_info(${table})`).all();
  const needed = info.filter((c) => Number(c.notnull) === 1 || Number(c.pk) > 0 || c.name in overrides);
  const names = needed.map((c) => c.name);
  const statement = sqlite.prepare(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`);
  for (let i = 0; i < n; i += 1) {
    statement.run(...needed.map((c) => (c.name in overrides
      ? overrides[c.name]
      : /INT|REAL|NUM|DOUB|FLOA/i.test(String(c.type)) ? i + 1 : `${table}-${c.name}-${i}`)));
  }
}

// --- rendering the real panel ------------------------------------------------------------------
const panel = await import("../app/control/live-governance-panel.tsx");
async function render(component, props) {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  return renderToStaticMarkup(React.createElement(component, props));
}
const plain = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const evidenceText = async (payload) => plain(await render(panel.EvidenceBody, { data: payload }));
const cardText = async (card) => plain(await render(panel.MetricCard, { card }));
const cardFor = (payload, label) => payload.cards.find((c) => c.label === label);

/** Collect whatever the module logged, so "degraded" can be asserted to be LOUD and not merely quiet. */
async function capturingConsole(work) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  try { return { value: await work(), lines }; } finally { console.error = original; }
}

/** A D1 whose statements matching `needle` fail with a NON-column error. */
function dbThatFailsOn(db, needle, message) {
  return {
    prepare(sql) {
      if (!String(sql).includes(needle)) return db.prepare(sql);
      const boom = () => { throw new Error(message); };
      const stmt = { sql, bind: () => stmt, first: async () => boom(), all: async () => boom(), run: async () => boom() };
      return stmt;
    },
    batch: (...args) => db.batch(...args),
    exec: (...args) => db.exec(...args),
  };
}

// --- 1. Master settings: no evidence query is not "no records" -----------------------------------

const MASTER_TABLES = ["city_launch_configs", "service_controls", "service_policy_configs", "service_packages", "dynamic_pricing_rules"];

/** Reproduce the reported screen: five master tables present and non-empty, subscription plans absent. */
function masterWorld() {
  const world = freshCountingD1();
  createCanonical(world.sqlite, ...MASTER_TABLES);
  const counts = { city_launch_configs: 1, service_controls: 10, service_policy_configs: 35, service_packages: 60, dynamic_pricing_rules: 6 };
  for (const [table, n] of Object.entries(counts)) insertRows(world.sqlite, table, n);
  return world;
}

test("EV-1: EXECUTED - Master settings counts 112 rows and does NOT claim its sources hold no records", async () => {
  const { db } = masterWorld();
  const payload = await buildControlCenterOperations(db, "master");

  assert.equal(cardFor(payload, "Cities").value, 1);
  assert.equal(cardFor(payload, "Services").value, 10);
  assert.equal(cardFor(payload, "Policies").value, 35);
  assert.equal(cardFor(payload, "Packages").value, 60);
  assert.equal(cardFor(payload, "Price rules").value, 6);
  const counted = payload.cards.reduce((sum, c) => sum + (c.value ?? 0), 0);
  assert.equal(counted, 112, "the screen that printed the false sentence had just counted these rows");

  const text = await evidenceText(payload);
  assert.doesNotMatch(text, THE_OLD_LIE,
    `the panel said "no recent records" over ${counted} rows it had just counted. It rendered: ${text}`);
});

test("EV-2: EXECUTED - Master settings says it issues no evidence query, and says how much it did count", async () => {
  const { db } = masterWorld();
  const payload = await buildControlCenterOperations(db, "master");

  assert.equal(payload.evidence.state, "not_queried", "no evidence query is issued for this view");
  assert.equal(payload.evidence.source, null, "and there is no single source it could be about");
  assert.deepEqual(payload.rows, [], "the row list is still empty - that was never the defect");
  assert.match(payload.evidence.note, /issues no evidence query/i);
  assert.match(payload.evidence.note, /\b5 of them answered\b/, "5 of the 6 configuration tables answered");
  assert.match(payload.evidence.note, /\b112 rows\b/, "and the note must carry the total the cards add up to");

  const text = await evidenceText(payload);
  assert.match(text, /NO EVIDENCE QUERY IN THIS VIEW/);
  assert.match(text, /112 rows/);
});

test("EV-3: EXECUTED - the note tracks the data, so it cannot go stale into a new falsehood", async () => {
  const { db } = freshCountingD1();
  const cold = await buildControlCenterOperations(db, "master");
  assert.match(cold.evidence.note, /\b0 of them answered\b/, "on a cold database nothing answered");
  assert.match(cold.evidence.note, /\b0 rows\b/);

  const { db: warm } = masterWorld();
  const populated = await buildControlCenterOperations(warm, "master");
  assert.notEqual(populated.evidence.note, cold.evidence.note,
    "a note that reads identically at 0 rows and at 112 rows is decoration, not a statement about the data");
});

// --- 2. A missing table is not a queried table ---------------------------------------------------

test("EV-4: EXECUTED - Quality with unified_cases absent reports NOT QUERIED, never 'no recent records'", async () => {
  const { db } = freshCountingD1();
  const payload = await buildControlCenterOperations(db, "quality");

  assert.equal(payload.evidence.state, "uninitialised");
  assert.equal(payload.evidence.source, "unified_cases");
  assert.deepEqual(payload.rows, []);
  assert.match(payload.evidence.note, /has not been created on this database yet/i);

  const text = await evidenceText(payload);
  assert.match(text, /SOURCE NOT INITIALISED · NOT QUERIED/);
  assert.doesNotMatch(text, THE_OLD_LIE,
    "sqlite_master says the table is not there; a sentence about its recent records describes a query that never ran");
});

test("EV-5: EXECUTED - the cards and the evidence list on that same screen now agree with each other", async () => {
  const { db } = freshCountingD1();
  const payload = await buildControlCenterOperations(db, "quality");
  const safety = cardFor(payload, "Safety cases");

  assert.equal(safety.connected, false, "the count is still unavailable - that part was always right");
  assert.equal(safety.state, "uninitialised");

  const card = await cardText(safety);
  assert.match(card, /not created on this database yet/);
  assert.doesNotMatch(card, /not connected/,
    "the table is part of the shipping schema and nothing has touched it here; 'not connected' is a different claim");
  const text = await evidenceText(payload);
  /* The contradiction, stated as one assertion: both halves of the screen must name the same table
   * and give the same reason for having nothing to show. */
  const agree = /created on this database/;
  assert.ok(agree.test(card) && agree.test(text) && card.includes("unified_cases") && text.includes("unified_cases"),
    `the screen must not say "no source" above and "the source has no records" below:\n  cards: ${card}\n  evidence: ${text}`);
  assert.doesNotMatch(text, /not connected/);
});

// --- 3. Warm-up is not disconnection ------------------------------------------------------------

test("EV-6: EXECUTED - a table that appears later reads as not-created-yet first and as a real count after", async () => {
  /* The observed defect, replayed: the same database, the same code, no deploy - only another screen
   * running its own CREATE TABLE IF NOT EXISTS in between. */
  const { sqlite, db } = freshCountingD1();
  const cold = cardFor(await buildControlCenterOperations(db, "health"), "Integrations");
  assert.equal(cold.state, "uninitialised");
  assert.doesNotMatch(await cardText(cold), /not connected/);

  createCanonical(sqlite, "integration_registry");
  const warm = cardFor(await buildControlCenterOperations(db, "health"), "Integrations");
  assert.equal(warm.state, "ok");
  assert.equal(warm.value, 0);
  assert.equal(warm.connected, true);
  assert.match(await cardText(warm), /\b0\b/, "an existing empty table counts zero - it does not read as unavailable");
});

test("EV-7: EXECUTED - the reader stays a reader: running every mode creates nothing", async () => {
  /* The honest-copy fix must not be quietly traded for an ensure*Tables() on a read path. */
  const { sqlite, db } = freshCountingD1();
  const before = sqlite.prepare("SELECT name FROM sqlite_master").all().map((r) => r.name);
  for (const mode of MODES) await buildControlCenterOperations(db, mode);
  const after = sqlite.prepare("SELECT name FROM sqlite_master").all().map((r) => r.name);
  assert.deepEqual(after, before, "the Control Center created database objects while reporting on them");
  assert.equal(after.length, 0, "and the fixture really was cold, so this assertion could have failed");
});

// --- 4. Schema drift is its own state, and it is loud --------------------------------------------

function driftedQualityWorld() {
  const world = freshCountingD1();
  /* The table EXISTS and is missing the columns both queries name - real drift, not absence. */
  world.sqlite.exec("CREATE TABLE unified_cases (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)");
  return world;
}

test("EV-8: EXECUTED - a drifted evidence table reports the failure and the D1 message, not an empty list", async () => {
  const { db } = driftedQualityWorld();
  const { value: payload, lines } = await capturingConsole(() => buildControlCenterOperations(db, "quality"));

  assert.equal(payload.evidence.state, "unreadable");
  assert.equal(payload.evidence.source, "unified_cases");
  assert.deepEqual(payload.rows, [], "the request still survives - one drifted column must not 500 the console");
  assert.match(payload.evidence.note, /no such column/i, "the operator needs what D1 actually said");
  assert.ok(lines.some((l) => /evidence rows unavailable/.test(l)), `the absorbed failure must still be logged: ${lines.join(" | ")}`);

  const text = await evidenceText(payload);
  assert.match(text, /EVIDENCE QUERY FAILED · SCHEMA MISMATCH/);
  assert.doesNotMatch(text, THE_OLD_LIE);
});

test("EV-9: EXECUTED - the drifted count is loud too, on the screen and in the log", async () => {
  const { db } = driftedQualityWorld();
  const { value: payload, lines } = await capturingConsole(() => buildControlCenterOperations(db, "quality"));
  const safety = cardFor(payload, "Safety cases");

  assert.equal(safety.state, "unreadable", "an existing table whose predicate column is gone is drift, not absence");
  assert.equal(safety.connected, false);
  assert.match(safety.note, /no such column/i);
  assert.ok(lines.some((l) => /count unavailable/.test(l)),
    `count() absorbed a \`no such column\` silently for as long as this module existed: ${lines.join(" | ")}`);

  const card = await cardText(safety);
  assert.match(card, /SCHEMA MISMATCH/);
  assert.doesNotMatch(card, /not created on this database yet/, "the table IS there - saying it is not would be the next false sentence");

  const html = await render(panel.EvidenceBody, { data: payload });
  assert.match(html, /#8f1d1d/, "the one failure this module hides from the HTTP status must not also be visually calm");
});

test("EV-10: the `no such column` tolerance is not widened - every other D1 failure still escapes", async () => {
  const canonical = freshCountingD1();
  createCanonical(canonical.sqlite, "unified_cases");

  await assert.rejects(
    () => buildControlCenterOperations(dbThatFailsOn(canonical.db, "FROM unified_cases ORDER BY", "D1_ERROR: database is locked"), "quality"),
    /database is locked/,
    "an evidence query failing for any other reason must reach the route and become a 500",
  );
  await assert.rejects(
    () => buildControlCenterOperations(dbThatFailsOn(canonical.db, "COUNT(*) count FROM unified_cases", "D1_ERROR: network error"), "quality"),
    /network error/,
    "and so must a count",
  );
});

// --- 5. Queried-and-empty is a real, separate answer ----------------------------------------------

test("EV-11: EXECUTED - a table that exists and holds nothing says the query RAN and found nothing", async () => {
  const { db, sqlite } = freshCountingD1();
  createCanonical(sqlite, "security_audit_events");
  const payload = await buildControlCenterOperations(db, "security");

  assert.equal(payload.evidence.state, "empty");
  assert.equal(payload.evidence.source, "security_audit_events");
  assert.match(payload.evidence.note, /was queried and holds no rows/);
  assert.equal(cardFor(payload, "Security audit").value, 0, "zero is an answer, not an absence");

  const text = await evidenceText(payload);
  assert.match(text, /QUERIED · NO ROWS/);
  assert.doesNotMatch(text, THE_OLD_LIE);
});

test("EV-12: EXECUTED - and rows, when there are rows, are still the evidence", async () => {
  const { db, sqlite } = freshCountingD1();
  createCanonical(sqlite, "security_audit_events");
  const columns = sqlite.prepare("PRAGMA table_info(security_audit_events)").all().map((c) => c.name);
  assert.ok(columns.includes("actor_email") && columns.includes("created_at"), "fixture mismatch");
  insertRows(sqlite, "security_audit_events", 1, { actor_email: "founder@pawspace.in", action: "control.view", outcome: "allowed" });

  const payload = await buildControlCenterOperations(db, "security");
  assert.equal(payload.evidence.state, "rows");
  assert.equal(payload.rows.length, 1);
  assert.match(payload.evidence.note, /1 most recent row read from security_audit_events/);

  const text = await evidenceText(payload);
  assert.match(text, /founder@pawspace\.in/, "the rows themselves are what the section is for");
  assert.doesNotMatch(text, THE_OLD_LIE);
});

// --- 6. The vocabulary, end to end ---------------------------------------------------------------

test("EV-13: the five evidence states render five different sentences", async () => {
  const drifted = await buildControlCenterOperations(driftedQualityWorld().db, "quality");
  const cold = freshCountingD1();
  const empty = freshCountingD1(); createCanonical(empty.sqlite, "security_audit_events");
  const filled = freshCountingD1(); createCanonical(filled.sqlite, "security_audit_events");
  insertRows(filled.sqlite, "security_audit_events", 1, { actor_email: "ops@pawspace.in" });

  const payloads = {
    not_queried: await buildControlCenterOperations(masterWorld().db, "master"),
    uninitialised: await buildControlCenterOperations(cold.db, "quality"),
    unreadable: drifted,
    empty: await buildControlCenterOperations(empty.db, "security"),
    rows: await buildControlCenterOperations(filled.db, "security"),
  };
  const rendered = {};
  for (const [state, payload] of Object.entries(payloads)) {
    assert.equal(payload.evidence.state, state, `fixture for "${state}" produced "${payload.evidence.state}"`);
    rendered[state] = await evidenceText(payload);
  }
  assert.equal(new Set(Object.values(rendered)).size, 5,
    `each state must read differently, or the vocabulary is decorative:\n${JSON.stringify(rendered, null, 2)}`);
});

test("EV-14: EXECUTED - no mode, at any database state, renders a claim about a query that did not run", async () => {
  const cold = freshCountingD1();
  const canonical = freshCountingD1();
  for (const table of new Set([...MASTER_TABLES, "unified_cases", "security_audit_events", "integration_registry", "food_inventory_uat", "board_approvals"])) {
    if (SCHEMAS.get(table)) createCanonical(canonical.sqlite, table);
  }
  const worlds = { cold: cold.db, canonical: canonical.db, populated: masterWorld().db, drifted: driftedQualityWorld().db };

  for (const [name, db] of Object.entries(worlds)) {
    for (const mode of MODES) {
      const payload = await buildControlCenterOperations(db, mode);
      const text = await evidenceText(payload);
      assert.doesNotMatch(text, THE_OLD_LIE, `${name}/${mode} rendered: ${text}`);
      assert.ok(text.length > 0, `${name}/${mode} rendered nothing at all, which says nothing true either`);
      for (const card of payload.cards) {
        const rendered = await cardText(card);
        assert.doesNotMatch(rendered, /not connected/, `${name}/${mode}/${card.label} rendered: ${rendered}`);
        assert.ok(["ok", "uninitialised", "unreadable"].includes(card.state), `${name}/${mode}/${card.label} has no state`);
        if (card.state === "ok") assert.equal(typeof card.value, "number");
        else assert.equal(card.value, null, "a card that could not read must not carry a number");
      }
    }
  }
});
/* EV-15 closes a hole found while independently sabotage-checking this suite.
 *
 * Every rendering test above renders the EXPORTED MetricCard / EvidenceBody directly. Nothing pinned
 * that the panel the founder actually loads USES them. Reverting the default component's JSX back to
 * the old `rows.length ? rows : "No recent records in this source."` left all 14 tests green - correct
 * components, simply not wired in. So this asserts the delegation and the absence of the old
 * vocabulary in the module that ships, which is the thing a reader of /control is exposed to. */
test("EV-15: the panel that actually ships delegates to the vocabulary, and no longer carries the old copy", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../app/control/live-governance-panel.tsx", import.meta.url), "utf8");

  assert.match(source, /<EvidenceBody\b/, "the default panel must render the evidence vocabulary, not its own fallback");
  assert.match(source, /<MetricCard\b/, "the default panel must render cards through MetricCard, not its own inline markup");

  /* Comments legitimately quote the old copy to record what was fixed, so strip them first and check
   * only what can actually reach a screen. */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const [forbidden, why] of [
    ["No recent records in this source.", "claims a query found nothing when it may never have run"],
    ["not connected", "states a warm-up artifact as a fact about the platform"],
  ]) {
    const hits = code.split(forbidden).length - 1;
    assert.equal(hits, 0, `the shipping panel can still render ${JSON.stringify(forbidden)} - it ${why}`);
  }
});
