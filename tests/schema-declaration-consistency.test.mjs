import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Two modules may both declare the same table with CREATE TABLE IF NOT EXISTS.
// That statement is a NO-OP once the table exists, so when the declarations
// disagree, whichever module runs first silently decides the real shape and the
// other module's writes fail forever against a live database.
//
// Nothing else catches this. Each module's own tests create their own copy of
// the table and pass. It only shows up in production, as it did on staging:
//
//   /api/finance-control
//   -> D1_ERROR: table finance_close_periods has no column named checklist_json
//
// because lib/gst-accounting.ts created that table without the column. The same
// latent bug existed on customer_contact_preferences.opt_out.
//
// This test reads every CREATE TABLE in the repo and fails if any table is
// declared with two different column sets.
// ---------------------------------------------------------------------------

const root = new URL("../", import.meta.url).pathname;

function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", ".next", "dist", ".git", ".wrangler"].includes(entry.name)) continue;
        walk(rel);
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        out.push(rel);
      }
    }
  };
  walk("lib");
  walk("app");
  walk("backend");
  return out;
}

/** Split a CREATE TABLE body on top-level commas and return the declared column names. */
function columnNames(body) {
  const parts = [];
  let depth = 0, current = "";
  for (const char of body) {
    if (char === "(") depth++;
    else if (char === ")") depth--;
    if (char === "," && depth === 0) { parts.push(current); current = ""; }
    else current += char;
  }
  parts.push(current);
  const names = new Set();
  for (const part of parts) {
    const first = part.trim().split(/\s+/)[0]?.toLowerCase();
    // Table-level constraints are not columns.
    if (!first || ["primary", "unique", "foreign", "check", "constraint"].includes(first)) continue;
    names.add(first);
  }
  return names;
}

function declarations() {
  const found = new Map(); // table -> Map(signature -> [files])
  const pattern = /CREATE TABLE IF NOT EXISTS ([a-z_]+) \((.*?)\)"/gs;
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    for (const match of source.matchAll(pattern)) {
      const table = match[1];
      const signature = [...columnNames(match[2])].sort().join(",");
      if (!found.has(table)) found.set(table, new Map());
      const shapes = found.get(table);
      if (!shapes.has(signature)) shapes.set(signature, []);
      shapes.get(signature).push(file);
    }
  }
  return found;
}

test("no table is declared with two different column sets", () => {
  const found = declarations();
  const conflicts = [];
  for (const [table, shapes] of found) {
    if (shapes.size === 1) continue;
    const sets = [...shapes.keys()].map(signature => new Set(signature.split(",")));
    const common = sets.reduce((left, right) => new Set([...left].filter(column => right.has(column))));
    const detail = [...shapes.entries()].map(([signature, files]) => {
      const extra = signature.split(",").filter(column => !common.has(column));
      return `      ${files.join(", ")}${extra.length ? ` -> only here: ${extra.join(", ")}` : " -> subset"}`;
    }).join("\n");
    conflicts.push(`  ${table}\n${detail}`);
  }
  assert.deepEqual(conflicts, [],
    "CREATE TABLE IF NOT EXISTS is a no-op once the table exists, so a table declared two different " +
    "ways means whichever module runs first wins and the other module's writes fail on a live " +
    "database. Make the declarations identical.\n" + conflicts.join("\n"));
});

test("the scan actually sees the repo's tables", () => {
  // A guard that silently matched nothing would pass forever. Pin that it finds a real, known table.
  const found = declarations();
  assert.ok(found.size > 200, `expected the repo to declare hundreds of tables, saw ${found.size}`);
  assert.ok(found.has("canonical_bookings"), "the scan must see canonical_bookings");
  assert.ok(found.has("finance_close_periods"), "the scan must see the table that caused this test to exist");
});

test("the two tables that drifted are repaired in place, not just re-declared", async () => {
  // Unifying the declarations only helps a fresh database. Any database that already created the
  // table with the wrong shape needs the column added, which is what the repair module does.
  const repair = fs.readFileSync(path.join(root, "lib/schema-drift-repair.ts"), "utf8");
  for (const pair of ["finance_close_periods", "checklist_json", "customer_contact_preferences", "opt_out"]) {
    assert.ok(repair.includes(pair), `${pair} must be covered by the in-place repair`);
  }
  assert.match(repair, /ALTER TABLE .* ADD COLUMN/, "the repair adds the missing column");
  assert.match(repair, /PRAGMA table_info/, "the repair checks before altering, so it is safe to re-run");
});
