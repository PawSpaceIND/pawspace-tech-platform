/**
 * V2 grooming catalogue copy: seeded Pricing Control rows carry an internal note as their description
 * ("Canonical Grooming price for …"). Once the price list is published, customers must see what each
 * package includes (from the approved commercial catalogue), and an operator-written description wins.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__GROOM_COPY_DB__", "__GROOM_COPY_ENV__");

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
    batch: async (statements) => { const out = []; for (const s of statements) out.push(await s.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const sqlite = new DatabaseSync(":memory:");
globalThis.__GROOM_COPY_DB__ = makeD1(sqlite);
globalThis.__GROOM_COPY_ENV__ = {};
const route = await import("../app/api/v2/grooming-catalogue/route.ts");
const catalogue = async () => { const res = await route.GET(); assert.equal(res.status, 200); return (await res.json()).data.packages; };

test("nothing is listed until Pricing Control publishes the grooming price list", async () => {
  assert.deepEqual(await catalogue(), []);
});

test("published packages describe what they include, never the internal seed note", async () => {
  sqlite.exec("UPDATE service_packages SET active=1 WHERE service_code='grooming'");
  const packages = await catalogue();
  assert.equal(packages.length, 10);
  for (const item of packages) assert.doesNotMatch(item.description, /canonical/i, item.code);
  const bath = packages.find(item => item.code === "dog-bath");
  assert.equal(bath.description, "Includes Bath, Shampoo & Conditioning, Deshedding, Blow Drying, Combing & Brushing.");
  assert.deepEqual(bath.bundles.map(bundle => [bundle.petCount, bundle.price]), [[1, 1349], [2, 2298], [3, 3447], [4, 4596]]);
});

test("an operator-written description is shown as written", async () => {
  sqlite.prepare("UPDATE service_packages SET description=? WHERE package_code='dog-trim'").run("Breed-specific haircut with nail clipping and ear cleaning.");
  const trim = (await catalogue()).find(item => item.code === "dog-trim");
  assert.equal(trim.description, "Breed-specific haircut with nail clipping and ear cleaning.");
});

test("an operator description written on a multi-pet bundle row still reaches the package", async () => {
  sqlite.prepare("UPDATE service_packages SET description=? WHERE package_code='cat-routine__2_pets'").run("Nails, ears, eyes and a full brush-out for calm cats.");
  const routine = (await catalogue()).find(item => item.code === "cat-routine");
  assert.equal(routine.description, "Nails, ears, eyes and a full brush-out for calm cats.");
  sqlite.prepare("UPDATE service_packages SET description=? WHERE package_code='cat-routine'").run("Single-cat routine grooming at home.");
  assert.equal((await catalogue()).find(item => item.code === "cat-routine").description, "Single-cat routine grooming at home.", "the single-pet row wins");
});
