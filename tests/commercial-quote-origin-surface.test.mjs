import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// The six public *-commercial quote routes are reachable without authentication — the gateway maps them
// to no permission on purpose, because a visitor has to be able to price a stay before signing up. Each
// guards its POST with a per-route copy of:
//
//   if (origin && origin !== new URL(request.url).origin) -> 403
//
// which passes when the header is ABSENT. The question worth answering is not whether that is untidy;
// it is whether an origin-less anonymous POST creates durable privileged state or external side effects.
//
// These tests answer it by execution: three requests per route against a clean database — no Origin, a
// foreign Origin, and the first-party Origin — diffing every table in the schema after each.
//
// The finding is that the durable state is a QUOTE, and a quote is a price-integrity control rather than
// a privileged write: it carries no customer or contact field, its amount is computed server-side from
// the catalogue, it expires, and confirmation re-validates it. So the tests below pin the properties the
// downgrade rests on. If any of them stops holding — a customer id appears on a quote, an amount becomes
// caller-supplied, the expiry goes away — this file goes red and the downgrade is no longer valid.
//
// An Origin check is not authentication: any non-browser client can send an allowed Origin. That is
// precisely why the safety here has to come from the shape of the record, not from the header.
// ---------------------------------------------------------------------------

const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

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
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); },
  };
}

const ORIGIN = "https://app.pawspace.test";
const at = (ms) => new Date(Date.now() + ms).toISOString();
const DAY = 86400000, HOUR = 3600000;

/** Each route, a payload that produces a real quote, and the table the quote lands in. */
const ROUTES = [
  { name: "boarding", quoteTable: "boarding_commercial_quotes",
    body: () => ({ packageCode: "boarding-4h", petCount: 1, scheduledStart: at(20 * DAY), scheduledEnd: at(20 * DAY + 3 * HOUR), paymentMode: "prepaid" }) },
  { name: "sitting", quoteTable: "sitting_commercial_quotes",
    body: () => ({ packageCode: "sitting-visit-60", petCount: 1, scheduledStart: at(20 * DAY), scheduledEnd: at(20 * DAY + HOUR), paymentMode: "prepaid" }) },
  { name: "taxi", quoteTable: "taxi_commercial_quotes",
    body: () => ({ routeCode: "taxi-blr-east-short", originLabel: "Indiranagar", destinationLabel: "Koramangala", petCount: 1, scheduledStart: at(20 * DAY) }) },
  { name: "food", quoteTable: "food_commercial_quotes",
    body: () => ({ sku: "food-uat-cat-adult-1kg", quantity: 1, zoneId: "blr-east" }) },
  { name: "walking", quoteTable: "walking_commercial_quotes",
    body: () => ({ packageCode: "walking-30", mode: "once", petCount: 1, walkCount: 1, scheduledStart: at(20 * DAY), scheduledEnd: at(20 * DAY + 30 * 60000) }) },
  { name: "training", quoteTable: "training_commercial_quotes",
    body: () => ({ packageCode: "trainer-meet-greet", petCount: 1, scheduledStart: at(20 * DAY), paymentMode: "prepaid" }) },
];

async function routeModule(name) { return import(`../app/api/${name}-commercial/route.ts`); }

/** A clean database with the route's catalogue seeded, exactly as its own GET seeds it. */
async function clean(name) {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__PAWSPACE_TEST_ENV = { DB: makeD1(sqlite) };
  const mod = await routeModule(name);
  await (mod.GET.length ? mod.GET(new Request(`${ORIGIN}/api/${name}-commercial`)) : mod.GET());
  return { sqlite, mod };
}

const snapshot = (sqlite) => {
  const out = {};
  for (const { name } of sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    out[name] = sqlite.prepare(`SELECT COUNT(*) n FROM "${name}"`).get().n;
  }
  return out;
};

const changedTables = (before, after) => Object.keys({ ...before, ...after })
  .filter((key) => (before[key] ?? 0) !== (after[key] ?? 0)).sort();

// Boarding, sitting and training price through resolveLivePrice, whose first call lazily seeds the
// shared pricing catalogue. That is a fixed seed, not caller data — the test below pins that it is
// byte-identical no matter who calls or whether an Origin was sent — so it is allowed here alongside
// the quote table, and nothing else is.
const CATALOGUE_SEED = "service_packages";
const expectedWrites = (route) => [route.quoteTable, CATALOGUE_SEED].sort();
const assertOnlyQuoteAndSeed = (before, after, route, message) => {
  const changed = changedTables(before, after);
  assert.ok(changed.every((table) => expectedWrites(route).includes(table)),
    `${message} (unexpected tables: ${changed.filter((t) => !expectedWrites(route).includes(t)).join(", ")})`);
  assert.ok(changed.includes(route.quoteTable), "the quote itself is written");
};

const call = (mod, name, body, headers) => mod.POST(new Request(`${ORIGIN}/api/${name}-commercial`, {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
}));

// --- the three-request matrix, per route -----------------------------------------------------------

for (const route of ROUTES) {
  test(`${route.name}-commercial: a foreign Origin is rejected and writes nothing`, async () => {
    const { sqlite, mod } = await clean(route.name);
    const before = snapshot(sqlite);
    const response = await call(mod, route.name, route.body(), { origin: "https://attacker.test" });
    assert.equal(response.status, 403);
    assert.deepEqual(changedTables(before, snapshot(sqlite)), [], "a rejected cross-origin POST touches no table");
  });

  test(`${route.name}-commercial: the first-party Origin produces exactly one quote row`, async () => {
    const { sqlite, mod } = await clean(route.name);
    const before = snapshot(sqlite);
    const response = await call(mod, route.name, route.body(), { origin: ORIGIN });
    assert.equal(response.status, 201, await response.text().catch(() => ""));
    assertOnlyQuoteAndSeed(before, snapshot(sqlite), route, "the happy path writes only the quote and the pricing seed");
    assert.equal(sqlite.prepare(`SELECT COUNT(*) n FROM "${route.quoteTable}"`).get().n, 1);
  });

  test(`${route.name}-commercial: an origin-less POST writes the same anonymous quote and nothing more`, async () => {
    // The header being absent does NOT get rejected. What it produces is the finding: the same single
    // quote row, in the same table, and no second table anywhere in the schema.
    const { sqlite, mod } = await clean(route.name);
    const before = snapshot(sqlite);
    const response = await call(mod, route.name, route.body(), {});
    assert.equal(response.status, 201);
    assertOnlyQuoteAndSeed(before, snapshot(sqlite), route,
      "no lead, no customer, no order, no notification and no outbox row is created by an origin-less caller");
  });

  test(`${route.name}-commercial: the quote it persists carries no identity and a server-computed amount`, async () => {
    // This is what the downgrade rests on. A quote that cannot name a person cannot be attributed to a
    // victim, which is the property /api/meet-and-greet lacked.
    const { sqlite, mod } = await clean(route.name);
    await call(mod, route.name, route.body(), {});
    const columns = sqlite.prepare(`PRAGMA table_info("${route.quoteTable}")`).all().map((c) => String(c.name));
    for (const forbidden of ["customer_id", "customer_name", "email", "phone", "primary_phone", "lead_id", "user_id"]) {
      assert.ok(!columns.includes(forbidden), `a public quote must not carry ${forbidden}`);
    }
    assert.ok(columns.includes("expires_at"), "the row is self-expiring rather than durable business state");
    assert.ok(columns.includes("status"), "and it is consumable exactly once at confirmation");
    const row = sqlite.prepare(`SELECT * FROM "${route.quoteTable}"`).get();
    assert.equal(String(row.status), "open");
    assert.ok(Number(row.expires_at) > Date.now(), "expiry is set forward from creation");
  });

  test(`${route.name}-commercial: the caller cannot dictate the price`, async () => {
    // Amounts supplied by the caller are ignored; the catalogue decides. Confirmation later compares the
    // submitted total against this stored row, so a forged amount cannot survive into a booking either.
    //
    // Worth recording how this holds: the routes field-pick the body, naming each parameter they forward,
    // so a stray body.totalAmount never reaches the pricing lib at all. A sabotage of the lib alone does
    // not turn this test red — it takes wiring the amount through the route AND honouring it downstream,
    // which is exactly the regression this guards, and which does turn it red.
    const { sqlite, mod } = await clean(route.name);
    await call(mod, route.name, route.body(), {});
    const honest = Number(sqlite.prepare(`SELECT total_amount FROM "${route.quoteTable}"`).get().total_amount);

    const { sqlite: sqlite2, mod: mod2 } = await clean(route.name);
    await call(mod2, route.name, { ...route.body(), totalAmount: 1, amountDueNow: 1, discount: 99999, basePrice: 1 }, {});
    const attempted = Number(sqlite2.prepare(`SELECT total_amount FROM "${route.quoteTable}"`).get().total_amount);
    assert.equal(attempted, honest, "caller-supplied amounts are ignored — the price comes from the catalogue");
    assert.ok(honest > 0, "and it is a real price, so the comparison is not trivially satisfied");
  });
}

// --- coupons: the one lever that could have consumed a limited resource ----------------------------

test("five of the six refuse coupons outright, and the sixth only READS a coupon rule", async () => {
  // A coupon that decremented a redemption budget would turn an anonymous quote into resource
  // consumption. Boarding/sitting/taxi/food/walking reject any coupon with 409; training resolves one,
  // but training_coupon_rules has no usage counter — discountFor is a pure lookup, so nothing is spent.
  for (const name of ["boarding", "sitting", "taxi", "food", "walking"]) {
    const route = ROUTES.find((item) => item.name === name);
    const { sqlite, mod } = await clean(name);
    const response = await call(mod, name, { ...route.body(), couponCode: "ANYTHING" }, {});
    assert.equal(response.status, 409, `${name} must refuse coupons`);
    assert.equal(sqlite.prepare(`SELECT COUNT(*) n FROM "${route.quoteTable}"`).get().n, 0, "and write no quote");
  }

  const { sqlite, mod } = await clean("training");
  const columns = sqlite.prepare("PRAGMA table_info(training_coupon_rules)").all().map((c) => String(c.name));
  for (const counter of ["used_count", "redemptions", "max_redemptions", "remaining", "usage_limit"]) {
    assert.ok(!columns.includes(counter), `a coupon rule with ${counter} would make anonymous quoting spend a budget`);
  }
  const unknown = await call(mod, "training", { ...ROUTES.find((r) => r.name === "training").body(), couponCode: "NOT-A-REAL-CODE" }, {});
  assert.equal(unknown.status, 409, "an unknown coupon is refused rather than silently discounting");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM training_commercial_quotes").get().n, 0);
});

test("the pricing catalogue an origin-less caller seeds is identical to a first-party caller's", async () => {
  // The one table beyond the quote that a POST can touch. If its contents differed by caller then it
  // would be caller data wearing a seed's clothes; they do not, so it is a fixed catalogue.
  const rowsFor = async (headers) => {
    const { sqlite, mod } = await clean("boarding");
    await call(mod, "boarding", ROUTES.find((r) => r.name === "boarding").body(), headers);
    // Timestamps naturally differ between two runs; everything that describes WHAT was seeded must not.
    return sqlite.prepare("SELECT * FROM service_packages ORDER BY rowid").all()
      .map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => column !== "updated_at")));
  };
  const anonymous = await rowsFor({});
  const firstParty = await rowsFor({ origin: ORIGIN });
  assert.ok(anonymous.length > 0, "the seed is non-empty, so this comparison means something");
  assert.deepEqual(anonymous, firstParty, "the seeded catalogue does not vary with the caller");
});
