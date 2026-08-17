import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PRIMARY_SOURCE,
  PRODUCT_SOURCE_ROOTS,
  REQUIRED_TABLES,
  assertCreateTableOnly,
  bootstrapSchema,
  candidateSource,
  collectSchema,
  extractCreateTables,
} from "./e2e/release-preview-schema.mjs";

// ---------------------------------------------------------------------------
// The preview D1 is created empty, and the candidate has no migrations directory. The gate's own setup
// — roles, users, the customer binding, the scheduling rows, the first snapshot — runs before any
// product code, so on an empty database all of it is "no such table" and the first real dispatch would
// die during setup having proved nothing.
//
// The fix is to create the tables first, from the CANDIDATE's own CREATE TABLE text. The temptation is
// to paste a schema into infrastructure instead; that would be a second source of truth, it would drift
// from the routes, and the drift would surface as passing tests against a schema no Worker creates.
// These tests hold that line: the DDL is extracted, the extraction is unambiguous, and anything it
// cannot resolve stops the run instead of guessing.
// ---------------------------------------------------------------------------

/** A virtual checkout: paths to file contents, no fixture tree on disk. */
const checkout = (files) => ({
  listFiles: () => Object.keys(files),
  readFile: (path) => {
    if (!(path in files)) throw new Error(`ENOENT: ${path}`);
    return files[path];
  },
});

// Fixture DDL uses invented table names wherever the shape is what matters, so that nothing in this
// file could ever be mistaken for — or quietly become — a copy of the product's schema.
const WIDGETS = "CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY, label TEXT NOT NULL)";

test("every required table resolves from this repository's own product source", async () => {
  const { statements, scanned } = collectSchema(await candidateSource(process.cwd()));
  assert.equal(statements.length, REQUIRED_TABLES.length);
  assert.deepEqual(statements.map((s) => s.table), REQUIRED_TABLES, "resolved in dependency order");
  assert.ok(scanned > 100, `expected a real source tree, scanned ${scanned} files`);
  for (const statement of statements) {
    assert.match(statement.sql, new RegExp(`^CREATE TABLE IF NOT EXISTS ${statement.table}\\b`, "i"));
    assert.ok(statement.sources.length >= 1);
    for (const source of statement.sources) {
      assert.ok(PRODUCT_SOURCE_ROOTS.some((root) => source.startsWith(`${root}/`)),
        `${statement.table} was taken from ${source}, which is not product source`);
    }
  }
});

test("test fixtures are never used as a schema source", async () => {
  const { statements } = collectSchema(await candidateSource(process.cwd()));
  for (const statement of statements) {
    for (const source of statement.sources) {
      assert.ok(!source.startsWith("tests/") && !source.startsWith("scripts/"),
        `${statement.table} resolved to ${source}; fixtures define only the columns their own test needs`);
    }
  }
});

test("a table the candidate does not define fails closed", () => {
  assert.throws(
    () => collectSchema({ ...checkout({ "lib/a.ts": WIDGETS }), tables: ["gadgets"] }),
    /gadgets: no CREATE TABLE IF NOT EXISTS found/);
});

test("two different definitions fail closed rather than picking one", () => {
  const files = {
    "lib/a.ts": "CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY, label TEXT NOT NULL)",
    "lib/b.ts": "CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY, label TEXT)",
  };
  assert.throws(
    () => collectSchema({ ...checkout(files), tables: ["widgets"] }),
    /widgets: 2 different definitions .* refusing to guess/s);
});

test("the same definition written two ways is one definition, not an ambiguity", () => {
  const files = {
    "lib/a.ts": "CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY, label TEXT NOT NULL)",
    "lib/b.ts": "CREATE   TABLE  IF NOT EXISTS  widgets (\n  id TEXT PRIMARY KEY,\n  label TEXT NOT NULL\n)",
  };
  const { statements } = collectSchema({ ...checkout(files), tables: ["widgets"] });
  assert.equal(statements.length, 1);
  assert.deepEqual(statements[0].sources, ["lib/a.ts", "lib/b.ts"]);
  assert.equal(statements[0].tieBreak, false);
});

test("a genuine disagreement is broken by the route under test, and reported", () => {
  const files = {
    "lib/other.ts": "CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY, label TEXT NOT NULL DEFAULT 'x')",
    [PRIMARY_SOURCE]: "CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY, label TEXT NOT NULL DEFAULT 'y')",
  };
  const { statements } = collectSchema({ ...checkout(files), tables: ["widgets"] });
  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /'y'/, "the schema the route under test executes is the one the preview gets");
  assert.equal(statements[0].tieBreak, true, "and the disagreement must be surfaced, not swallowed");
});

test("the candidate really does disagree about one table, and the tie-break is the only one used", async () => {
  // Not hypothetical: canonical_customers is declared with two different DEFAULT sources in product
  // code. Exactly one table may need the tie-break; a second would mean the rule is doing more work
  // than it was justified for and deserves another look.
  const { statements } = collectSchema(await candidateSource(process.cwd()));
  const tied = statements.filter((s) => s.tieBreak);
  assert.equal(tied.length, 1, `tie-broken tables: ${tied.map((s) => s.table).join(", ") || "none"}`);
  assert.ok(tied[0].sources.includes(PRIMARY_SOURCE));
});

test("an unbalanced statement is malformed, and malformed fails closed", () => {
  const files = { "lib/a.ts": "CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY, label TEXT" };
  assert.equal(extractCreateTables(files["lib/a.ts"], "widgets").malformed, 1);
  assert.throws(
    () => collectSchema({ ...checkout(files), tables: ["widgets"] }),
    /widgets: 1 CREATE TABLE statement\(s\) could not be parsed/);
});

test("parentheses are balanced, not regex-matched", () => {
  const sql = "CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT (0), k TEXT CHECK (k IN ('a','b')))";
  const found = extractCreateTables(`const ddl = \`${sql}\`;`, "widgets");
  assert.equal(found.malformed, 0);
  assert.equal(found.statements.length, 1);
  assert.equal(found.statements[0], sql, "a naive [^)]* match would have stopped at the first inner )");
});

test("a parenthesis inside a string literal does not move the depth", () => {
  const sql = "CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT ')(')";
  const found = extractCreateTables(sql, "widgets");
  assert.equal(found.malformed, 0);
  assert.equal(found.statements[0], sql);
});

test("only a bare CREATE TABLE IF NOT EXISTS may ever be executed", () => {
  assert.doesNotThrow(() => assertCreateTableOnly(WIDGETS, "widgets"));
  const rejected = {
    "a statement terminator": "CREATE TABLE IF NOT EXISTS widgets (id TEXT); DROP TABLE widgets",
    "a line comment": "CREATE TABLE IF NOT EXISTS widgets (id TEXT -- nope\n)",
    "a block comment": "CREATE TABLE IF NOT EXISTS widgets (id TEXT /* nope */)",
    "no columns": "CREATE TABLE IF NOT EXISTS widgets ()",
    "a different table": "CREATE TABLE IF NOT EXISTS gadgets (id TEXT)",
    "a plain CREATE TABLE": "CREATE TABLE widgets (id TEXT)",
  };
  for (const [why, sql] of Object.entries(rejected)) {
    assert.throws(() => assertCreateTableOnly(sql, "widgets"), Error, `${why} must be refused`);
  }
});

test("bootstrapSchema executes each statement once, in order, and re-validates on the way out", async () => {
  const executed = [];
  const statements = [
    { table: "widgets", sql: WIDGETS },
    { table: "gadgets", sql: "CREATE TABLE IF NOT EXISTS gadgets (id TEXT PRIMARY KEY)" },
  ];
  const created = await bootstrapSchema({ d1: async (sql) => { executed.push(sql); return []; }, statements });
  assert.deepEqual(created, ["widgets", "gadgets"]);
  assert.deepEqual(executed, statements.map((s) => s.sql));

  // Mutated between resolution and execution: still refused, and nothing runs.
  const tampered = [{ table: "widgets", sql: `${WIDGETS}; DROP TABLE app_users` }];
  const ran = [];
  await assert.rejects(() => bootstrapSchema({ d1: async (sql) => { ran.push(sql); return []; }, statements: tampered }),
    /statement terminator/);
  assert.deepEqual(ran, []);
});

test("the bootstrap logs table names only — never a database identifier", async () => {
  const lines = [];
  await bootstrapSchema({
    d1: async () => [],
    statements: [{ table: "widgets", sql: WIDGETS }],
    log: (line) => lines.push(line),
  });
  const text = lines.join("\n");
  assert.match(text, /widgets/);
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text),
    "a D1 id is a uuid; none may ever be logged");
});

// --- the schema stays in one place ---------------------------------------------------------------

test("no infrastructure file that runs in the hosted job carries a schema of its own", () => {
  // Only the files that EXECUTE in the preview job are scanned. Test files are fixtures by definition —
  // this one contains DDL for widgets and gadgets a few lines up — and the thing that must not hold a
  // duplicate schema is the code that talks to the real database.
  const hosted = [
    ".github/workflows/deploy-release-preview.yml",
    "scripts/release-preview-config.mjs",
    "tests/e2e/release-preview-gate.mjs",
    "tests/e2e/release-preview-schema.mjs",
  ];
  for (const path of hosted) {
    const text = readFileSync(path, "utf8");
    for (const table of REQUIRED_TABLES) {
      assert.ok(!new RegExp(`CREATE\\s+TABLE[\\s\\S]{0,80}\\b${table}\\b`, "i").test(text),
        `${path} appears to define ${table}; the DDL must be read from the candidate, never copied here`);
    }
  }
});

test("the gate asks for the candidate checkout explicitly, and refuses to run without it", () => {
  const gate = readFileSync("tests/e2e/release-preview-gate.mjs", "utf8");
  assert.match(gate, /CANDIDATE_DIR/, "the gate must be told where the candidate is");
  assert.match(gate, /!CANDIDATE_DIR/, "and must refuse to start without it");
  const workflow = readFileSync(".github/workflows/deploy-release-preview.yml", "utf8");
  assert.match(workflow, /CANDIDATE_DIR:\s*\$\{\{\s*github\.workspace\s*\}\}\/candidate/,
    "the workflow must point the bootstrap at candidate/, never at infra/");
});
