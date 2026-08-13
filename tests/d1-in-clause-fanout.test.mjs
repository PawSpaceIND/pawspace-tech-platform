/**
 * Staging /team/analytics reported 331 bookings and GMV of Rs 3,24,472 next to "Collected Rs 0" on
 * every service line, while the seeded database held a captured payment for each of those bookings.
 *
 * D1 caps a query at 100 bound parameters. Reads shaped `WHERE booking_id IN (?,?,...)` built from a
 * result set pass under 100 rows and fail above it, and because these reads sit inside
 * swallow-and-continue helpers the failure renders as a confident zero. The shim below enforces the
 * same cap as D1 so the tests fail the way production did.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";


installWorkersHooks("__FANOUT_DB__");

const D1_BOUND_PARAMETER_LIMIT = 100;

function makeD1(sqlite) {
  function statement(sql, args) {
    const guard = () => {
      if (args.length > D1_BOUND_PARAMETER_LIMIT) {
        throw new Error(`D1_ERROR: too many SQL variables at offset 0: SQLITE_ERROR (${args.length} bound parameters, limit ${D1_BOUND_PARAMETER_LIMIT})`);
      }
    };
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => {
        guard();
        const row = sqlite.prepare(sql).get(...args);
        return row === undefined ? null : row;
      },
      run: async () => {
        guard();
        const info = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes) } };
      },
      all: async () => {
        guard();
        return { results: sqlite.prepare(sql).all(...args) };
      },
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => {
      const out = [];
      for (const item of statements) out.push(await item.run());
      return out;
    },
    exec: async (sql) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}

// DDL copied verbatim from scripts/staging-seed.sql (booking_payments) and
// drizzle/0011_serious_shaman.sql (canonical_bookings) - the same shapes staging runs.
const BOOKINGS = "CREATE TABLE IF NOT EXISTS canonical_bookings (id text PRIMARY KEY NOT NULL, idempotency_key text NOT NULL, customer_id text NOT NULL, pet_ids_json text NOT NULL, source_pet_ids_json text NOT NULL, city_id text NOT NULL, zone_id text NOT NULL, service_code text NOT NULL, package_code text NOT NULL, package_name text NOT NULL, schedule_group_id text NOT NULL, provider_id text NOT NULL, scheduled_start text NOT NULL, scheduled_end text NOT NULL, status text DEFAULT 'confirmed' NOT NULL, channel text DEFAULT 'customer_app' NOT NULL, total_amount real NOT NULL, currency text DEFAULT 'INR' NOT NULL, pricing_json text DEFAULT '{}' NOT NULL, created_by text NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL)";
const PAYMENTS = "CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)";
const TICKETS = "CREATE TABLE IF NOT EXISTS customer_experience_tickets (id TEXT PRIMARY KEY, customer_id TEXT, booking_id TEXT, lead_id TEXT, category TEXT NOT NULL, priority TEXT NOT NULL, subject TEXT NOT NULL, detail TEXT NOT NULL, owner TEXT NOT NULL, manager TEXT NOT NULL, sla_due_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', escalation_level INTEGER NOT NULL DEFAULT 0, customer_status TEXT NOT NULL DEFAULT 'We received your request', resolution TEXT, root_cause TEXT, resolution_evidence TEXT, reopened_count INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, resolved_at INTEGER)";

// Staging holds 331 bookings; anything over the 100-parameter cap reproduces it.
const BOOKING_COUNT = 150;
const AMOUNT = 1000;

function seedBookings() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(BOOKINGS);
  sqlite.exec(PAYMENTS);
  sqlite.exec(TICKETS);
  const now = Date.now();
  for (let index = 0; index < BOOKING_COUNT; index += 1) {
    const id = `BK${String(index).padStart(5, "0")}`;
    const customerId = `CUS${String(index).padStart(4, "0")}`;
    sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','zone-1','grooming','pkg','Full groom',?,'PRV-1','2026-07-01T09:00:00.000Z','2026-07-01T10:00:00.000Z','completed','customer_app',?,'INR','{}','seed',?,?)")
      .run(id, `${id}-idem`, customerId, `SG-${id}`, AMOUNT, now, now);
    sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,'INR','card','prepaid','captured','uat_sandbox',?,'{}',?,?)")
      .run(`PAY-${id}`, id, customerId, AMOUNT, AMOUNT, `pidem-${id}`, now, now);
  }
  sqlite.prepare("INSERT INTO customer_experience_tickets (id,customer_id,booking_id,category,priority,subject,detail,owner,manager,sla_due_at,status,created_by,created_at,updated_at) VALUES ('CXT-1','CUS0000','BK00000','service','high','Late groomer','detail','owner@pawspace.in','manager@pawspace.in',?,'open','seed',?,?)")
    .run(now + 3_600_000, now, now);
  globalThis.__FANOUT_DB__ = makeD1(sqlite);
  globalThis.__FANOUT_ENV__ = {};
  return sqlite;
}

test("the D1 shim enforces the same 100-bound-parameter cap as production", async () => {
  seedBookings();
  const ids = Array.from({ length: 150 }, (_, index) => `BK${String(index).padStart(5, "0")}`);
  await assert.rejects(
    globalThis.__FANOUT_DB__.prepare(`SELECT id FROM canonical_bookings WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all(),
    /too many SQL variables/,
    "without this the tests below would pass against a limit production does not have",
  );
});

test("real execution: collected revenue survives more bookings than D1 allows bound parameters", async () => {
  seedBookings();
  const { buildCompanyAnalytics } = await import("../lib/company-analytics.ts");
  const analytics = await buildCompanyAnalytics(globalThis.__FANOUT_DB__);

  assert.equal(analytics.bookings.total, BOOKING_COUNT);
  assert.equal(analytics.money.gmv, BOOKING_COUNT * AMOUNT);
  // The staging symptom: GMV counted, collected silently zero.
  assert.equal(analytics.money.collected, BOOKING_COUNT * AMOUNT, "every captured payment is counted");
  const grooming = Object.fromEntries(Object.entries(analytics.services))["grooming"];
  assert.equal(grooming.collected, BOOKING_COUNT * AMOUNT, "per-service collected is not zero either");
  // The CX read in the same call was discarded by the same cap.
  assert.equal(analytics.cx.tickets, 1);
});

test("real execution: the payment and invoice reads behind the accounts view survive the cap", async () => {
  const sqlite = seedBookings();
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_invoices (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT NOT NULL,invoice_number TEXT NOT NULL,status TEXT NOT NULL,gross_amount REAL NOT NULL,tax_amount REAL NOT NULL,net_amount REAL NOT NULL,issued_at INTEGER NOT NULL)");
  const accounts = await import("../lib/accounts-business-view.ts");
  const build = accounts.buildAccountsBusinessView || accounts.accountsBusinessView || Object.values(accounts).find((value) => typeof value === "function");
  const view = await build(globalThis.__FANOUT_DB__, {});
  // The ledger itself is capped at 100 rows for display (lib/accounts-business-view.ts:88); what matters
  // is that the payment behind each row was read at all - before chunking, every status was null.
  assert.equal(view.ledger.length, 100);
  assert.equal(view.ledger.filter((row) => row.status === "captured").length, 100, "payment status comes from the chunked read");
  assert.equal(view.ledger.reduce((sum, row) => sum + Number(row.gross || 0), 0), 100 * AMOUNT);
  // Rows past the first chunk are the ones the single query used to lose.
  assert.ok(view.ledger.some((row) => Number(String(row.bookingId).replace("BK", "")) > 90), "bookings beyond the first chunk are present");
});

test("real execution: customer names on the partner job feed survive the cap", async () => {
  const sqlite = seedBookings();
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'seed',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  const now = Date.now();
  const ids = [];
  for (let index = 0; index < BOOKING_COUNT; index += 1) {
    const id = `CUS${String(index).padStart(4, "0")}`;
    ids.push(id);
    sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,created_at,updated_at) VALUES (?,'blr',?,?,?,?)")
      .run(id, `Customer ${index} Sharma`, `98765${String(index).padStart(5, "0")}`, now, now);
  }
  const { chunkedIn } = await import("../lib/d1-chunked-in.ts");
  const rows = await chunkedIn(ids, async (chunk, placeholders) =>
    (await globalThis.__FANOUT_DB__.prepare(`SELECT id,name FROM canonical_customers WHERE id IN (${placeholders})`).bind(...chunk).all()).results);
  assert.equal(rows.length, BOOKING_COUNT, "every id in the list is answered, not just the first chunk");
  assert.equal(new Set(rows.map((row) => row.id)).size, BOOKING_COUNT, "chunks do not overlap or drop ids");
});

test("chunkedIn preserves the semantics of the single query it replaces", async () => {
  const { chunkedIn, idChunks, D1_IN_CHUNK } = await import("../lib/d1-chunked-in.ts");
  assert.ok(D1_IN_CHUNK <= 100, "the chunk must fit inside D1's bound-parameter cap");
  assert.deepEqual(idChunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(await chunkedIn([], async () => [1]), [], "an empty list runs no query at all");
  const seen = [];
  const out = await chunkedIn(["a", "b", "c"], async (chunk, placeholders) => {
    seen.push(placeholders);
    return chunk;
  }, 2);
  assert.deepEqual(out, ["a", "b", "c"], "results are concatenated in order");
  assert.deepEqual(seen, ["?,?", "?"], "each chunk gets placeholders matching its own length");
});

// Files whose IN lists cannot grow past the cap: each is a fixed vocabulary or a per-row list, not a
// result set. A new name appearing here must be justified the same way or routed through chunkedIn.
const BOUNDED_IN_LISTS = {
  "boarding-ops-governance.ts": "pet ids of a single stay",
  "lead-assignment-governance.ts": "the service codes on one policy",
  "meet-and-greet.ts": "the literal statuses a transition may come from",
  "ops-work-queue.ts": "the literal statuses a task may be claimed from",
  "staff-alert-center.ts": "the literal alert types the sweep owns",
  "statutory-compliance.ts": "the obligations of one month",
  "subscription-wallet.ts": "the grooming plan catalogue",
  "tds-governance.ts": "the months of one financial year",
};

test("no library builds an IN list straight from a result set any more", async () => {
  const files = (await readdir(new URL("../lib", import.meta.url))).filter((name) => name.endsWith(".ts") && name !== "d1-chunked-in.ts");
  const offenders = [];
  for (const name of files) {
    const source = await readFile(new URL(`../lib/${name}`, import.meta.url), "utf8");
    // `.map(() => "?")` over a variable-length list is the shape that breaks past 100 rows.
    if (!/\.map\(\s*\(\s*\)\s*=>\s*"\?"\s*\)/.test(source)) continue;
    if (source.includes("d1-chunked-in") || name in BOUNDED_IN_LISTS) continue;
    offenders.push(name);
  }
  assert.deepEqual(offenders, [], "these files must build IN lists through chunkedIn so they cannot exceed D1's cap");
});

test("one chunk size for the whole platform, not one per module", async () => {
  // Main briefly carried two: 80 in lib/customer-360.ts and 50 in lib/unit-economics.ts, which is how
  // the same class of bug came back at a different size in a different module. The constant lives in
  // one place now, and a module that declares its own is the thing to catch.
  const files = (await readdir(new URL("../lib", import.meta.url))).filter((name) => name.endsWith(".ts") && name !== "d1-chunked-in.ts");
  const offenders = [];
  for (const name of files) {
    const source = await readFile(new URL(`../lib/${name}`, import.meta.url), "utf8");
    for (const match of source.matchAll(/const\s+([A-Z_]*CHUNK[A-Z_]*)\s*=\s*(\d+)/g)) offenders.push(`${name}: ${match[1]}=${match[2]}`);
  }
  assert.deepEqual(offenders, [], "these modules declare their own IN-chunk size instead of using D1_IN_CHUNK");

  const { D1_IN_CHUNK } = await import("../lib/d1-chunked-in.ts");
  assert.equal(D1_IN_CHUNK, 80, "the size #166 measured as correct: a chunk of 50 cost 82 D1 calls for 500 customers where 58 would do");
});

test("the suites run on the Node the CI pins, not just the one on this machine", async () => {
  // CI pins 22.13.0, where module.registerHooks does not exist. Calling it unguarded threw
  // `TypeError: nodeModule.registerHooks is not a function` and took the whole file down before a
  // single test ran - which is why these suites were red on GitHub while green locally.
  const helper = await readFile(new URL("./helpers/module-hooks.mjs", import.meta.url), "utf8");
  assert.match(helper, /typeof nodeModule\.registerHooks === "function"/, "the modern API must be feature-detected");
  assert.match(helper, /nodeModule\.register\(/, "and an older Node must still get a resolver");

  const suites = (await readdir(new URL(".", import.meta.url))).filter((name) => name.endsWith(".test.mjs"));
  const unguarded = [];
  for (const name of suites) {
    const source = await readFile(new URL(name, import.meta.url), "utf8");
    if (!source.includes("registerHooks")) continue;
    if (source.includes('typeof nodeModule.registerHooks === "function"')) continue;
    unguarded.push(name);
  }
  assert.deepEqual(unguarded, [], "these suites call registerHooks without a fallback and will die on CI's Node");
});
