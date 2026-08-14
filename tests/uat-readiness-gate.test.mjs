import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Is a freshly seeded environment actually usable?
//
// The unit suite injects the rows it needs, so it can prove a query is right while the deployed
// database has nothing for that query to read. Three of this week's failures were exactly that shape
// and none of them was a logic bug:
//
//   "Permission denied" on every screen  - an app_users row whose role resolved to no permissions
//   "no full-access login"               - nothing in the seed could open the admin surfaces
//   revenue reads zero                   - 319 payments, no reconciliation rows, and
//                                          /api/grooming-finance counts only reconciliation_status
//                                          === "matched"
//
// So this loads the REAL seed files into a fresh database - not fixtures, not injected rows - and
// asserts what has to be true before a human can test anything. If a seed stops producing a usable
// environment, this fails instead of the founder discovering it in a browser.
// ---------------------------------------------------------------------------

const SEEDS = ["scripts/staging-seed.sql", "scripts/uat-demo-seed.sql", "scripts/employee-seed.sql"];

/** The seeds are self-contained (CREATE TABLE IF NOT EXISTS + INSERT), so a blank database is enough. */
async function seededDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  const applied = [];
  for (const path of SEEDS) {
    const sql = await readFile(path, "utf8");
    // Statement at a time: a seed that references a table another seed owns should be reported as a
    // gap, not abort the whole run and hide everything after it.
    const skipped = [];
    // Strip line comments first. Splitting on ";\n" leaves a leading "-- …" comment sharing a chunk
    // with the CREATE TABLE beneath it, and skipping the chunk drops the table.
    const statements = sql.replace(/^\s*--[^\n]*$/gm, "").split(/;\s*\n/);
    for (const statement of statements) {
      const trimmed = statement.trim();
      if (!trimmed) continue;
      try { sqlite.exec(`${trimmed};`); } catch (error) { skipped.push(`${trimmed.slice(0, 70)} → ${error.message}`); }
    }
    applied.push({ path, skipped });
  }
  return { sqlite, applied };
}

const rows = (sqlite, sql) => { try { return sqlite.prepare(sql).all(); } catch { return null; } };
const one = (sqlite, sql) => { const r = rows(sqlite, sql); return r && r.length ? r[0] : null; };

test("every seeded staff identity has a role the platform actually defines", async () => {
  const { sqlite } = await seededDatabase();
  const { defaultRoles } = await import("../lib/platform-security.ts");
  const defined = new Set(defaultRoles.map((role) => role.code));

  const users = rows(sqlite, "SELECT email, role_code, status FROM app_users");
  assert.ok(users && users.length, "the seed must create staff identities, or nobody can sign in");

  // resolveUatStaffActor looks the role up in role_definitions and, when it is missing, hands back an
  // actor with NO permissions rather than refusing. That is a signed-in user who is denied everywhere
  // and cannot tell why - the outage this week. An undefined role code is therefore a seed defect.
  const orphaned = users.filter((user) => user.status === "active" && !defined.has(String(user.role_code)));
  assert.deepEqual(
    orphaned.map((u) => `${u.email} → role "${u.role_code}" is not in defaultRoles`), [],
    "a seeded identity points at a role the platform does not define; signing in as it yields zero permissions",
  );
});

test("the seed leaves at least one identity that can open the admin surfaces", async () => {
  const { sqlite } = await seededDatabase();
  const { defaultRoles, hasPermission } = await import("../lib/platform-security.ts");
  const byCode = new Map(defaultRoles.map((role) => [role.code, role.permissions]));

  const users = rows(sqlite, "SELECT email, role_code FROM app_users WHERE status='active'") || [];
  const fullAccess = users.filter((user) => {
    const permissions = byCode.get(String(user.role_code));
    return permissions && hasPermission(permissions, "launch.manage") && hasPermission(permissions, "finance.manage");
  });

  assert.ok(
    fullAccess.length > 0,
    `no seeded identity can open the admin surfaces. Active roles present: ${[...new Set(users.map((u) => u.role_code))].join(", ") || "none"}`,
  );
});

test("collected money is reconciled, so the finance screens do not read zero", async () => {
  const { sqlite } = await seededDatabase();

  const collected = rows(sqlite, "SELECT COUNT(*) AS n FROM booking_payments WHERE status IN ('captured','paid')");
  assert.ok(collected, "booking_payments must exist in the seed");
  const total = Number(collected[0].n);
  assert.ok(total > 0, "the seed must record collected payments, or every revenue screen is honestly zero");

  // /api/grooming-finance counts a payment only when reconciliation_status === "matched". A seed with
  // payments and no reconciliation rows produces the exact screen the founder saw: 66 bookings,
  // "Reconciled 0", "Captured ₹0", while the money is sitting in booking_payments.
  const reconciled = one(sqlite, "SELECT COUNT(*) AS n FROM payment_reconciliation_records WHERE reconciliation_status='matched'");
  assert.ok(
    reconciled !== null,
    "payment_reconciliation_records is absent from the seed, so every reconciled figure reads zero while booking_payments holds real money",
  );
  assert.ok(
    Number(reconciled.n) > 0,
    `${total} collected payments and no matched reconciliation record: the finance screens will read zero`,
  );
});

test("a seeded provider can be resolved from an identity, so the partner app has jobs", async () => {
  const { sqlite } = await seededDatabase();

  const orders = one(sqlite, "SELECT COUNT(*) AS n FROM provider_work_orders");
  assert.ok(orders && Number(orders.n) > 0, "the seed must create provider work orders, or the partner app is empty");

  const links = rows(sqlite, "SELECT provider_id, status FROM provider_identity_links WHERE status='active'");
  assert.ok(
    links && links.length > 0,
    "no active provider_identity_links: a provider can sign in but resolves to no provider, so their job list is empty",
  );

  // A link that points at a provider with no work proves nothing about the partner app.
  const withWork = rows(sqlite, `SELECT DISTINCT l.provider_id FROM provider_identity_links l
    JOIN provider_work_orders w ON w.provider_id = l.provider_id WHERE l.status='active'`);
  assert.ok(
    withWork && withWork.length > 0,
    "every active provider identity points at a provider with no work orders; the partner app resolves an identity and shows nothing",
  );
});

test("the seed applies cleanly, so nothing downstream is silently missing", async () => {
  const { applied } = await seededDatabase();
  const broken = applied.flatMap(({ path, skipped }) => skipped.map((detail) => `${path}: ${detail}`));
  assert.deepEqual(broken.slice(0, 8), [], `seed statements failed to apply; everything they feed is missing:\n  ${broken.slice(0, 8).join("\n  ")}`);
});

test("a completed booking closes: it is invoiced and its provider is paid", async () => {
  const { sqlite } = await seededDatabase();

  const completed = one(sqlite, "SELECT COUNT(*) AS n FROM canonical_bookings WHERE status='completed'");
  assert.ok(completed && Number(completed.n) > 0, "the seed must complete some bookings, or closure is untestable");
  const total = Number(completed.n);

  // Closure is the second half of the lifecycle: money in is only reconciliation. A finished job also
  // owes the customer a document and the provider their share. booking_invoices and
  // provider_payout_computations are what the finance screens read (13 and 3 call sites), so a seed
  // that completes bookings without them leaves every payout and invoice screen honestly empty - the
  // same class as the reconciliation gap, one layer further down the funnel.
  const invoices = one(sqlite, "SELECT COUNT(*) AS n FROM booking_invoices");
  assert.ok(invoices !== null, `booking_invoices is absent from the seed: ${total} completed bookings, no invoice for any of them`);
  assert.ok(Number(invoices.n) > 0, `${total} completed bookings and no invoice rows`);

  const payouts = one(sqlite, "SELECT COUNT(*) AS n FROM provider_payout_computations");
  assert.ok(payouts !== null, `provider_payout_computations is absent from the seed: ${total} completed bookings, no provider is owed anything`);
  assert.ok(Number(payouts.n) > 0, `${total} completed bookings and no payout computation`);
});

test("a completed booking was actually paid for", async () => {
  const { sqlite } = await seededDatabase();

  // Service delivered with no money collected is a revenue leak, and it is invisible on a screen that
  // only ever sums what it finds. Reported per booking so the list is actionable rather than a count.
  const unpaid = rows(sqlite, `SELECT b.id, b.service_code, b.total_amount FROM canonical_bookings b
    LEFT JOIN booking_payments p ON p.booking_id = b.id
    WHERE b.status='completed' AND b.total_amount > 0 AND (p.id IS NULL OR p.status NOT IN ('captured','paid'))`) || [];

  assert.deepEqual(
    unpaid.map((b) => `${b.id} (${b.service_code}, ₹${b.total_amount}) completed with no captured payment`), [],
    "a completed booking with no collected payment is a revenue leak no screen will surface",
  );
});
