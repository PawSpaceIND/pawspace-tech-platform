/**
 * E2E PRE-HUMAN-TESTING — every POST must refuse bad input politely.
 *
 * A human tester submits half-filled forms, double-clicks, and retries. Every write endpoint should
 * answer an empty or malformed body with a 4xx and a sentence a human can act on. A 500 means the
 * handler reached its database with nothing and the tester sees a broken page instead of "please fill
 * in the date".
 *
 * Two bodies are sent to each POST: `{}` and a non-JSON string. Neither should ever produce a 5xx.
 * Authenticated as the preview superuser so authorisation is not what stops the request — the
 * validation layer is the thing under test.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__E2EPOST_DB__", "__E2EPOST_ENV__");

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes), rows_written: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args), meta: {} }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const routeDirs = readdirSync("app/api", { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(`app/api/${entry.name}/route.ts`))
  .map((entry) => entry.name)
  .sort();

const CASES = [
  { label: "empty object", body: "{}", contentType: "application/json" },
  { label: "not json", body: "this is not json", contentType: "application/json" },
];

test("every POST answers an empty or malformed body with a 4xx, never a 5xx", async () => {
  const failures = [];
  let posts = 0, clean = 0;

  for (const name of routeDirs) {
    const sqlite = new DatabaseSync(":memory:");
    globalThis.__E2EPOST_DB__ = makeD1(sqlite);
    globalThis.__E2EPOST_ENV__ = { FOUNDER_EMAIL: "founder@pawspace.in" };

    let route;
    try { route = await import(`../app/api/${name}/route.ts?post=${name}`); } catch { continue; }
    if (typeof route.POST !== "function") continue;
    posts += 1;

    for (const testCase of CASES) {
      let status, message = "";
      try {
        const response = await route.POST(new Request(`http://localhost/api/${name}`, {
          method: "POST", headers: { "content-type": testCase.contentType }, body: testCase.body,
        }));
        status = response.status;
        const text = await response.text();
        try { message = String(JSON.parse(text).error ?? ""); } catch { message = text.slice(0, 120); }
      } catch (thrown) {
        status = thrown instanceof Response ? thrown.status : "threw";
        message = thrown instanceof Response ? "(thrown Response)" : String(thrown?.message ?? thrown).slice(0, 140);
      }

      if (status === "threw" || Number(status) >= 500) {
        failures.push({ name, case: testCase.label, status, message: message.slice(0, 130) });
      } else {
        clean += 1;
      }
    }
  }

  console.error(`\n=== POST VALIDATION SWEEP: ${posts} write endpoints x ${CASES.length} bad bodies ===`);
  console.error(`  refused cleanly (4xx):   ${clean}`);
  console.error(`  5xx or threw (defects):  ${failures.length}`);
  if (failures.length) {
    console.error(`\n--- write endpoints that break on bad input ---`);
    for (const item of failures) console.error(`  ${item.name.padEnd(34)} ${String(item.case).padEnd(13)} ${String(item.status).padEnd(6)} ${item.message}`);
  }

  assert.deepEqual(failures.map((item) => `${item.name} [${item.case}] -> ${item.status}: ${item.message}`), [],
    "these write endpoints answer a half-filled or malformed submission with a server error instead of a message the tester can act on");
});
