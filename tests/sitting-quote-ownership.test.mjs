/**
 * Can one customer pay for another customer's sitting quote?
 *
 * /api/sitting-payment-sandbox is gated on scheduling.book, which the `customer` role holds. It took a
 * quoteId from the body and captured against it with no notion of who the quote belonged to - because
 * the quote genuinely had no owner: /api/sitting-commercial is public by policy so a visitor can price a
 * stay before signing in, and sitting_commercial_quotes carried no customer column at all. "Someone
 * else's quote" was not expressible in the schema, so no ownership check could be written.
 *
 * The fix is claim on first use rather than an owner set at creation, because at creation there is no
 * identity to record. The flow is reserve -> capture -> book, so the capture is the first step a
 * signed-in customer takes, and that is where the quote is attributed.
 *
 * These drive the real capture. The permission suites cannot see any of it: every caller below holds
 * scheduling.book.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__SQO_DB__", "__SQO_ENV__");

const NOW = Date.now();
const AMOUNT = 799;

let sqlite;

async function fresh() {
  sqlite = new DatabaseSync(":memory:");
  const db = createD1(sqlite);
  globalThis.__SQO_DB__ = db;
  globalThis.__SQO_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox" };

  const { ensureSittingGovernanceTables } = await import("../lib/sitting-governance.ts");
  await ensureSittingGovernanceTables(db);
  sqlite.prepare(`INSERT INTO sitting_commercial_quotes (id,package_code,package_version,mode,pet_count,scheduled_start,scheduled_end,billable_units,payment_mode,total_amount,amount_due_now,expires_at,status,created_at)
    VALUES ('Q1','sitting-overnight',1,'overnight',1,'2026-12-01T10:00:00.000Z','2026-12-02T10:00:00.000Z',1,'prepaid',?,?,?,'open',?)`)
    .run(AMOUNT, AMOUNT, NOW + 3_600_000, NOW);
  return db;
}

const owner = () => {
  const row = sqlite.prepare("SELECT customer_id FROM sitting_commercial_quotes WHERE id='Q1'").get();
  return row.customer_id === null ? null : String(row.customer_id);
};

const capture = async (db, claimFor) => {
  const { captureSittingQuoteSandbox } = await import("../lib/sitting-payment-governance.ts");
  try { return { ok: true, data: await captureSittingQuoteSandbox(db, { quoteId: "Q1", amount: AMOUNT, claimFor }) }; }
  catch (error) {
    if (error instanceof Response) return { ok: false, status: error.status, message: await error.text() };
    throw error;
  }
};

test("the first paying customer claims the quote", async () => {
  const db = await fresh();
  assert.equal(owner(), null, "a quote starts anonymous - it is priced before anyone signs in");

  const first = await capture(db, "CUS-A");
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.data.status, "captured");
  assert.equal(owner(), "CUS-A", "the capture must attribute the quote, or the next caller has nothing to be refused against");
});

test("a second customer cannot pay for a quote already claimed", async () => {
  const db = await fresh();
  await capture(db, "CUS-A");

  const second = await capture(db, "CUS-B");
  assert.equal(second.ok, false, "the second customer must be refused");
  assert.equal(second.status, 403);
  assert.match(second.message, /belongs to another customer/);
  assert.equal(owner(), "CUS-A", "a refused caller must not take the quote from its owner");
});

test("the owner paying twice is the idempotent path, not a refusal", async () => {
  const db = await fresh();
  const first = await capture(db, "CUS-A");
  const replay = await capture(db, "CUS-A");

  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.data.duplicatePrevented, true, "a retry must be recognised, not charged again or refused");
  assert.equal(replay.data.reference, first.data.reference, "the same capture reference comes back");
});

test("staff capture on a customer's behalf without taking ownership of the quote", async () => {
  const db = await fresh();
  // claimFor is null for staff and the development preview: they act for a customer rather than being
  // one. The UAT desk and the prelaunch swarm both capture this way and would break if null were read
  // as "unowned and therefore refuse".
  const assisted = await capture(db, null);

  assert.equal(assisted.ok, true, JSON.stringify(assisted));
  assert.equal(owner(), null, "staff must not accidentally attribute the quote to themselves");
});

test("two customers racing for a fresh quote: exactly one wins", async () => {
  // Driven, not hoped for. Left to Promise.all the two captures serialise - the first finishes its claim
  // before the second reads the quote, so the second is refused by the plain owner comparison and the
  // compare-and-set is never the thing under test. Verified: removing "AND customer_id IS NULL" left
  // that version of this test green.
  //
  // So the first claimant is held AT its UPDATE until the second has read the quote as unowned. Both
  // then believe it is free, which is the only state in which a compare-and-set matters.
  let quoteReads = 0;
  let claims = 0;
  let interleaved = false;
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });

  sqlite = new DatabaseSync(":memory:");
  const db = createD1(sqlite, {
    park: (sql) => {
      if (sql.includes("FROM sitting_commercial_quotes WHERE id=?")) {
        quoteReads += 1;
        // The second reader has arrived believing the quote is free: let the first one write.
        if (quoteReads >= 2) { interleaved = true; release(); }
        return null;
      }
      if (sql.includes("UPDATE sitting_commercial_quotes SET customer_id")) {
        claims += 1;
        if (claims === 1) return gate;
      }
      return null;
    },
  });
  // If the second read never happens the gate would never open; let it through and fail on the
  // interleaved assertion rather than hanging until the runner times out.
  setTimeout(release, 2000).unref?.();

  globalThis.__SQO_DB__ = db;
  globalThis.__SQO_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox" };
  const { ensureSittingGovernanceTables } = await import("../lib/sitting-governance.ts");
  await ensureSittingGovernanceTables(db);
  sqlite.prepare(`INSERT INTO sitting_commercial_quotes (id,package_code,package_version,mode,pet_count,scheduled_start,scheduled_end,billable_units,payment_mode,total_amount,amount_due_now,expires_at,status,created_at)
    VALUES ('Q1','sitting-overnight',1,'overnight',1,'2026-12-01T10:00:00.000Z','2026-12-02T10:00:00.000Z',1,'prepaid',?,?,?,'open',?)`)
    .run(AMOUNT, AMOUNT, NOW + 3_600_000, NOW);

  const [a, b] = await Promise.all([capture(db, "CUS-A"), capture(db, "CUS-B")]);

  assert.equal(interleaved, true, "the two claims did not overlap, so nothing below is proven");
  const won = [a, b].filter((r) => r.ok);
  assert.equal(won.length, 1, `exactly one caller may take the quote, got ${won.length}: ${JSON.stringify([a, b])}`);
  assert.ok(["CUS-A", "CUS-B"].includes(owner()), "the winner must be recorded as the owner");
  assert.equal([a, b].find((r) => !r.ok).status, 403);
});

test("the route resolves the claimant itself, and never takes it from the request", async () => {
  const db = await fresh();
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('u-a','asha@pawspace.test','Asha','customer','active',?,?)").run(NOW, NOW);
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('u-b','bhavna@pawspace.test','Bhavna','customer','active',?,?)").run(NOW, NOW);
  sqlite.prepare("INSERT OR REPLACE INTO customer_identity_links (email,customer_id,status,verified_at,updated_at) VALUES ('asha@pawspace.test','CUS-A','active',?,?)").run(NOW, NOW);
  sqlite.prepare("INSERT OR REPLACE INTO customer_identity_links (email,customer_id,status,verified_at,updated_at) VALUES ('bhavna@pawspace.test','CUS-B','active',?,?)").run(NOW, NOW);

  const route = await import("../app/api/sitting-payment-sandbox/route.ts");
  const post = (email) => route.POST(new Request("https://pawspace-staging.example.dev/api/sitting-payment-sandbox", {
    method: "POST",
    headers: { "content-type": "application/json", "oai-authenticated-user-email": email },
    // No customer id in the body, and there is nowhere to put one: the claimant comes from the session.
    body: JSON.stringify({ quoteId: "Q1", amount: AMOUNT }),
  }));

  const asha = await post("asha@pawspace.test");
  assert.equal(asha.status, 201, JSON.stringify(await asha.clone().json()));
  assert.equal(owner(), "CUS-A");

  const bhavna = await post("bhavna@pawspace.test");
  assert.equal(bhavna.status, 403, JSON.stringify(await bhavna.clone().json()));
});
