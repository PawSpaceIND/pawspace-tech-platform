/**
 * WAVE 3C - a coverage gap the Wave 2 hunt recorded and did not execute. [PTJA-W3C]
 *
 * THE GAP, verbatim (ptja/PTJA-FINDINGS.json, domain 02-booking):
 *
 *   "app/api/pricing-quote/route.ts was read (it repeats the same `service_packages ... AND active=1`
 *    lookup with no effective-window check, and it accepts a fully client-supplied `coupon` object)
 *    but I did not execute it; it is only called from app/control/pricing-control-panel.tsx as a staff
 *    preview, so I could not demonstrate a customer-money consequence."
 *
 * PROBED, and the outcome is a REFUTATION with two corrections to the note itself:
 *
 *   1. The effective-window check is NOT missing. The route's lookup carries
 *      `AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?)`. QT-02 proves it bites.
 *   2. The client-supplied coupon is real, and the route IS public - it sits in api-gateway's
 *      allowlist and calls no authorize(). But it has no money consequence, because the REAL pricing
 *      path (lib/live-pricing-resolver.ts resolveLivePrice, the single bridge into every commercial
 *      quote) calls calculatePrice with NO coupon argument at all, and this route writes nothing.
 *
 * So an anonymous caller can make this endpoint compute any discount they like and hand it back to
 * themselves. The number binds nothing. That is safe TODAY by a property nobody had written down, and
 * it stops being safe the moment somebody wires this quote into a booking. QT-04 and QT-05 pin the two
 * properties that make it harmless, so that change cannot be made silently.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__W3C_PQ_DB__", "__W3C_PQ_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => { const out = []; for (const i of items) out.push(await i.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

let sqlite;
function world() {
  sqlite = new DatabaseSync(":memory:");
  globalThis.__W3C_PQ_DB__ = makeD1(sqlite);
  globalThis.__W3C_PQ_ENV__ = {};
  return globalThis.__W3C_PQ_DB__;
}

const route = await import("../app/api/pricing-quote/route.ts");

/** Anonymous: no cookie, no staff header, no identity of any kind. */
async function quote(body) {
  const response = await route.POST(new Request("https://uat.pawspace.in/api/pricing-quote", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  let parsed = null;
  try { parsed = await response.clone().json(); } catch { /* non-JSON */ }
  return { status: response.status, body: parsed };
}

async function seedPackage({ effectiveFrom = "2026-01-01", effectiveTo = null, basePrice = 1000 } = {}) {
  const db = world();
  // ensureSchema runs inside the route; call it once through a throwaway request so the tables exist.
  await quote({});
  sqlite.prepare("INSERT INTO service_packages (id,service_code,package_code,name,description,base_price,slot_minutes,blocking_minutes,tax_inclusive,active,version,effective_from,effective_to,updated_by,updated_at) VALUES ('PKG-1','grooming','GROOM-STD','Standard groom','desc',?,60,15,1,1,1,?,?,'w3c',?)")
    .run(basePrice, effectiveFrom, effectiveTo, Date.now());
  return db;
}

test("QT-01: the route is anonymous and a client-supplied coupon DOES move the number it returns", async () => {
  // Stated plainly rather than implied: this is the behaviour the gap describes, and it is real.
  await seedPackage();
  const honest = await quote({ packageCode: "GROOM-STD", scheduledStart: "2026-09-01T10:00:00.000Z" });
  assert.equal(honest.status, 200, JSON.stringify(honest.body));
  const full = Number(honest.body.data.finalPrice);
  assert.ok(full > 0, `a real quote must be produced: ${JSON.stringify(honest.body)}`);

  const invented = await quote({
    packageCode: "GROOM-STD", scheduledStart: "2026-09-01T10:00:00.000Z",
    coupon: { code: "NOT-A-REAL-COUPON", discountType: "percent", value: 90 },
  });
  assert.equal(invented.status, 200, "an anonymous caller may still ask");
  assert.ok(Number(invented.body.data.finalPrice) < full,
    `an invented coupon changes the returned number: ${JSON.stringify(invented.body.data)}`);
});

test("QT-02: the package lookup DOES carry an effective window (correcting the recorded note)", async () => {
  // The gap says the effective-window check is missing. It is not. A package whose window has closed
  // is not quotable at all.
  await seedPackage({ effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30" });
  const outside = await quote({ packageCode: "GROOM-STD", scheduledStart: "2026-09-01T10:00:00.000Z" });
  assert.equal(outside.status, 404, `a package outside its window must not be quotable: ${JSON.stringify(outside.body)}`);
  const inside = await quote({ packageCode: "GROOM-STD", scheduledStart: "2026-03-01T10:00:00.000Z" });
  assert.equal(inside.status, 200, "and one inside its window still is");
});

test("QT-03: the quote is not persisted - the route writes nothing at all", async () => {
  await seedPackage();
  const before = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name).sort();
  await quote({
    packageCode: "GROOM-STD", scheduledStart: "2026-09-01T10:00:00.000Z",
    coupon: { code: "FAKE", discountType: "fixed", value: 999999 },
  });
  const after = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name).sort();
  assert.deepEqual(after, before, "no new table");
  for (const table of after) {
    if (table === "service_packages") continue;
    assert.equal(Number(sqlite.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c), 0,
      `${table} must be untouched by a quote request`);
  }
});

// -----------------------------------------------------------------------------------------------
// The two properties that make the above harmless. Both are currently accidental; these make them
// deliberate, so wiring this endpoint into a booking cannot happen quietly.
// -----------------------------------------------------------------------------------------------

test("QT-04: the REAL pricing path passes no caller coupon into calculatePrice", async () => {
  // lib/live-pricing-resolver.ts is the single bridge from the Pricing Control catalogue into every
  // commercial quote. If it ever accepts a coupon from its input, a client-supplied discount reaches
  // money, and QT-01 stops being harmless.
  const source = await readFile(new URL("../lib/live-pricing-resolver.ts", import.meta.url), "utf8");
  const call = source.match(/calculatePrice\(\{[^}]*\}\)/);
  assert.ok(call, "resolveLivePrice must still call calculatePrice - if not, this guard has drifted");
  assert.doesNotMatch(call[0], /coupon/,
    `the real pricing path must not pass a coupon: ${call[0]}`);
});

test("QT-05: no route other than the public preview passes a caller-supplied coupon to pricing", async () => {
  const { readdir } = await import("node:fs/promises");
  const offenders = [];
  const walk = async (dir) => {
    for (const entry of await readdir(new URL(`../${dir}`, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) { await walk(`${dir}/${entry.name}`); continue; }
      if (entry.name !== "route.ts") continue;
      const path = `${dir}/${entry.name}`;
      if (path === "app/api/pricing-quote/route.ts") continue; // the known, contained preview
      const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
      if (/calculatePrice\(/.test(source) && /coupon:\s*body\.coupon/.test(source)) offenders.push(path);
    }
  };
  await walk("app/api");
  assert.deepEqual(offenders, [],
    "a second route taking a caller-supplied coupon into the pricing engine is how a preview becomes a discount oracle");
});
