/**
 * Wallet, revenue recognition and cash flow — EXECUTED.
 *
 * WHAT THIS FILE USED TO BE. Four tests that read seven files as strings and made about forty
 * `assert.match` calls against them: that `lib/finance-accounts.ts` contains the text
 * `if (Math.abs(totalDebit - totalCredit) > 0.01) throw new Error`, that
 * `lib/pawspace-wallet-governance.ts` contains `WALLET_BONUS_RATE = 0.10`, that
 * `lib/cash-flow-statement.ts` contains `reconciled: Math.abs`. Every one of those is satisfied by the
 * phrase existing. Not one of them posted a journal, credited a wallet, recognised a rupee of revenue or
 * generated a statement — so the double-entry balance guard, the 10% redemption ceiling, the
 * one-redemption-per-booking lock and the cash/non-cash split were all uncovered in the sense that
 * matters: none of them could fail.
 *
 * Now eight EXECUTED tests (the count goes up, never down) driving the real functions against a real
 * SQLite-backed D1, asserting on the rows they write and the refusals they raise.
 *
 * Requests go to https://ops.pawspace.example, NOT localhost. `npm test` runs with NODE_ENV=test and
 * PAWSPACE_LOCAL_PREVIEW=on, so on a preview host lib/development-preview.ts resolves a superuser
 * holding ["*"] and every permission assertion here would pass vacuously. It matters twice over on this
 * route: POST /api/pawspace-wallet takes a DIFFERENT branch for a preview actor — it mints credit
 * directly instead of opening a maker/checker request — so a localhost conversion would have asserted
 * the opposite of the production behaviour.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1 } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__WALLET_FIN_DB__", "__WALLET_FIN_ENV__");

const accounts = await import("../lib/finance-accounts.ts");
const wallet = await import("../lib/pawspace-wallet-governance.ts");
const revrec = await import("../lib/revenue-recognition-governance.ts");
const cashflow = await import("../lib/cash-flow-statement.ts");
const walletRoute = await import("../app/api/pawspace-wallet/route.ts");
const cashflowRoute = await import("../app/api/cash-flow-statement/route.ts");

const { ACCT } = accounts;
const CUSTOMER = "CUST-WALLET-1";
const OTHER_CUSTOMER = "CUST-WALLET-2";
const BOOKING = "BKG-WALLET-1";
const FINANCE_MAKER = "maker.finance@pawspace.test";
const FINANCE_CHECKER = "checker.finance@pawspace.test";
const ADMIN = "ops.admin@pawspace.test";
const MANAGER = "ops.manager@pawspace.test";
const ORIGIN = "https://ops.pawspace.example";

/**
 * One wallet world: the journal, the wallet ledger, the recognition schedules, one Rs 5,000 booking
 * owned by CUSTOMER, and three staff identities.
 *
 * Every table comes from the module that OWNS it (ensureFinanceJournalTable, ensurePawspaceWalletTables,
 * ensureRevenueRecognitionTables, ensureSecurityTables) rather than from schema copied by hand, so a
 * migration in any of them reaches this file. Only `canonical_bookings` and `finance_close_periods` are
 * hand-created: these modules READ them and do not own their DDL, which is copied verbatim from
 * lib/finance-monthly-close.ts.
 */
async function walletWorld({ bookingTotal = 5000, bookingOwner = CUSTOMER } = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__WALLET_FIN_DB__ = db;
  globalThis.__WALLET_FIN_ENV__ = {};

  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  await accounts.ensureFinanceJournalTable(db);
  await wallet.ensurePawspaceWalletTables(db);
  await revrec.ensureRevenueRecognitionTables(db);

  const now = Date.now();
  const staff = sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)");
  staff.run("U-FIN-MAKER", FINANCE_MAKER, "Maker Finance", "finance", now, now);
  staff.run("U-FIN-CHECKER", FINANCE_CHECKER, "Checker Finance", "finance", now, now);
  // `admin` holds finance.view but NOT finance.manage — the contrast that makes the credit gate below
  // a real gate rather than "any signed-in staff member".
  staff.run("U-ADMIN", ADMIN, "Ops Admin", "admin", now, now);
  // `manager` holds no finance permission at all — the contrast that makes the finance.view gate on the
  // cash-flow report a gate rather than "any signed-in staff member".
  staff.run("U-MANAGER", MANAGER, "Ops Manager", "manager", now, now);

  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,provider_id TEXT,service_code TEXT,status TEXT,total_amount REAL,scheduled_start TEXT,scheduled_end TEXT,city_id TEXT,zone_id TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,status,total_amount,created_at,updated_at) VALUES (?,?,'grooming','confirmed',?,?,?)")
    .run(BOOKING, bookingOwner, bookingTotal, now, now);
  // DDL copied verbatim from lib/finance-monthly-close.ts, which owns this table. postJournal READS it.
  sqlite.exec("CREATE TABLE IF NOT EXISTS finance_close_periods (period_code text PRIMARY KEY NOT NULL,status text DEFAULT 'open' NOT NULL,checklist_json text NOT NULL,locked_at integer,locked_by text,updated_at integer NOT NULL)");

  return { sqlite, db };
}

/** Number of journal lines written under a group, straight from the table. */
const journalLines = (sqlite, group) =>
  sqlite.prepare("SELECT account_code,debit,credit,period_code,entry_date FROM finance_journal_entries WHERE id LIKE ? ORDER BY id").all(`${group}-%`);

const totalRows = (sqlite) => Number(sqlite.prepare("SELECT COUNT(*) c FROM finance_journal_entries").get().c);

/** The thrown value of a refusal — an Error message, or a control Response's status and body. */
async function refusal(promise) {
  try { await promise; return null; }
  catch (error) {
    if (error instanceof Response) return { status: error.status, body: await error.json().catch(() => null) };
    return { message: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------------------------
test("Finance journals must balance, carry at least one line, and are idempotent per group key", async () => {
  const { sqlite, db } = await walletWorld();

  // NON-VACUITY FIRST: a balanced journal really does post, and posts one row per line.
  const posted = await accounts.postJournal(db, {
    groupKey: "wallet-test-balanced", entryDate: "2026-03-04", periodCode: "2026-03",
    sourceType: "test", sourceId: "T-1", narration: "balanced pair",
    lines: [{ accountCode: ACCT.BANK, debit: 1200 }, { accountCode: ACCT.REVENUE, credit: 1200 }],
  });
  assert.equal(posted.posted, true);
  assert.equal(posted.lines, 2);
  const rows = journalLines(sqlite, posted.journalGroup);
  assert.equal(rows.length, 2, "a two-line journal writes exactly two rows");
  assert.equal(Number(rows.reduce((sum, r) => sum + Number(r.debit), 0)), 1200);
  assert.equal(Number(rows.reduce((sum, r) => sum + Number(r.credit), 0)), 1200);

  // THE BALANCE GUARD, EXECUTED. Rs 1,200 debited against Rs 1,000 credited must be refused, and must
  // write nothing at all — a half-posted journal is worse than a refused one.
  const before = totalRows(sqlite);
  const unbalanced = await refusal(accounts.postJournal(db, {
    groupKey: "wallet-test-unbalanced", entryDate: "2026-03-04", periodCode: "2026-03",
    sourceType: "test", sourceId: "T-2", narration: "one-sided",
    lines: [{ accountCode: ACCT.BANK, debit: 1200 }, { accountCode: ACCT.REVENUE, credit: 1000 }],
  }));
  assert.match(String(unbalanced?.message), /Journal is not balanced: debit 1200 != credit 1000/);
  assert.equal(totalRows(sqlite), before, "a refused journal leaves no rows behind");

  // Within the 0.01 tolerance a rounding difference is accepted — otherwise the guard above would be
  // "debits must equal credits exactly", which is not what the books need.
  const tolerated = await accounts.postJournal(db, {
    groupKey: "wallet-test-rounding", entryDate: "2026-03-04", periodCode: "2026-03",
    sourceType: "test", sourceId: "T-3", narration: "sub-paisa rounding",
    lines: [{ accountCode: ACCT.BANK, debit: 1000.005 }, { accountCode: ACCT.REVENUE, credit: 1000 }],
  });
  assert.equal(tolerated.posted, true, "a sub-paisa difference is inside tolerance");

  // A journal with no non-zero line is refused rather than posting an empty group.
  const empty = await refusal(accounts.postJournal(db, {
    groupKey: "wallet-test-empty", entryDate: "2026-03-04", periodCode: "2026-03",
    sourceType: "test", sourceId: "T-4", narration: "nothing",
    lines: [{ accountCode: ACCT.BANK, debit: 0 }, { accountCode: ACCT.REVENUE, credit: 0 }],
  }));
  assert.match(String(empty?.message), /at least one non-zero line/);

  // IDEMPOTENCY, EXECUTED. Re-posting the same groupKey must change nothing — this is the guard that
  // stops a retried webhook double-booking the money.
  const rowsBefore = totalRows(sqlite);
  const replay = await accounts.postJournal(db, {
    groupKey: "wallet-test-balanced", entryDate: "2026-03-04", periodCode: "2026-03",
    sourceType: "test", sourceId: "T-1", narration: "balanced pair",
    lines: [{ accountCode: ACCT.BANK, debit: 1200 }, { accountCode: ACCT.REVENUE, credit: 1200 }],
  });
  assert.deepEqual({ posted: replay.posted, duplicatePrevented: replay.duplicatePrevented }, { posted: false, duplicatePrevented: true });
  assert.equal(totalRows(sqlite), rowsBefore, "and the second call writes no rows");
});

// ---------------------------------------------------------------------------------------------
test("A journal cannot be relabelled out of its month or dated into a locked period", async () => {
  const { sqlite, db } = await walletWorld();

  // The period is the month the entry is DATED in. Labelling a March entry as April is refused,
  // otherwise a locked month is walked around by renaming the period. The old source-text test never
  // mentioned either guard.
  const mislabelled = await refusal(accounts.postJournal(db, {
    groupKey: "wallet-test-mislabelled", entryDate: "2026-03-31", periodCode: "2026-04",
    sourceType: "test", sourceId: "T-5", narration: "wrong label",
    lines: [{ accountCode: ACCT.BANK, debit: 100 }, { accountCode: ACCT.REVENUE, credit: 100 }],
  }));
  assert.match(String(mislabelled?.message), /period_mismatch: this journal is dated 2026-03; it cannot be posted as 2026-04/);
  assert.equal(totalRows(sqlite), 0);

  // An OPEN period accepts the entry — non-vacuity for the lock below.
  const insert = sqlite.prepare("INSERT INTO finance_close_periods (period_code,status,checklist_json,updated_at) VALUES (?,?, '{}',?)");
  insert.run("2026-02", "open", Date.now());
  const open = await accounts.postJournal(db, {
    groupKey: "wallet-test-open-period", entryDate: "2026-02-10", periodCode: "2026-02",
    sourceType: "test", sourceId: "T-6", narration: "open month",
    lines: [{ accountCode: ACCT.BANK, debit: 250 }, { accountCode: ACCT.REVENUE, credit: 250 }],
  });
  assert.equal(open.posted, true, "an open period still accepts postings");

  // A LOCKED period refuses it. Published figures for a closed month stay published.
  insert.run("2026-01", "locked", Date.now());
  const locked = await refusal(accounts.postJournal(db, {
    groupKey: "wallet-test-locked-period", entryDate: "2026-01-15", periodCode: "2026-01",
    sourceType: "test", sourceId: "T-7", narration: "into a closed month",
    lines: [{ accountCode: ACCT.BANK, debit: 250 }, { accountCode: ACCT.REVENUE, credit: 250 }],
  }));
  assert.match(String(locked?.message), /period_locked: 2026-01 is closed and locked/);
  assert.equal(journalLines(sqlite, "JRN-wallet-test-locked-period").length, 0, "and nothing lands in the closed month");
});

// ---------------------------------------------------------------------------------------------
test("Wallet credit is idempotent, bound to its payload, and books a liability against contra-revenue", async () => {
  const { sqlite, db } = await walletWorld();

  const credit = await wallet.creditWallet(db, {
    customerId: CUSTOMER, amount: 1000, source: "refund",
    sourceId: BOOKING, idempotencyKey: "refund:BKG-WALLET-1", actorId: FINANCE_MAKER,
  });
  assert.equal(credit.alreadyCredited, false);
  assert.equal(credit.balance, 1000);
  assert.equal(await wallet.walletBalance(db, CUSTOMER), 1000, "the account row carries the balance");

  // THE DOUBLE ENTRY, from the journal table: a wallet credit is contra-revenue (a refund we granted)
  // against a liability we now owe the customer. The old test only checked the account codes existed as
  // strings in a constants file.
  const lines = journalLines(sqlite, `JRN-wallet-credit-refund:${BOOKING}`);
  assert.deepEqual(lines.map((line) => [String(line.account_code), Number(line.debit), Number(line.credit)]), [
    [ACCT.REFUNDS, 1000, 0],
    [ACCT.WALLET_LIABILITY, 0, 1000],
  ]);

  // IDEMPOTENCY: the same key must not credit twice. A refund webhook retried by the gateway would
  // otherwise double a customer's balance.
  const replay = await wallet.creditWallet(db, {
    customerId: CUSTOMER, amount: 1000, source: "refund",
    sourceId: BOOKING, idempotencyKey: "refund:BKG-WALLET-1", actorId: FINANCE_MAKER,
  });
  assert.equal(replay.alreadyCredited, true);
  assert.equal(await wallet.walletBalance(db, CUSTOMER), 1000, "and the balance is unchanged");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM pawspace_wallet_ledger").get().c), 1, "one ledger row for one credit");

  // The key is bound to the PAYLOAD, so it cannot be reused to smuggle a different amount through as a
  // "retry": same key, Rs 9,000, refused 409.
  const rebound = await refusal(wallet.creditWallet(db, {
    customerId: CUSTOMER, amount: 9000, source: "refund",
    sourceId: BOOKING, idempotencyKey: "refund:BKG-WALLET-1", actorId: FINANCE_MAKER,
  }));
  assert.equal(rebound?.status, 409, `a reused key with a new payload must be refused: ${JSON.stringify(rebound)}`);
  assert.match(String(rebound?.body?.error), /already bound to another payload/);
  assert.equal(await wallet.walletBalance(db, CUSTOMER), 1000);

  // The source vocabulary is closed: only refund, cancellation and goodwill can create store credit.
  const badSource = await refusal(wallet.creditWallet(db, {
    customerId: CUSTOMER, amount: 500, source: "promo", idempotencyKey: "promo:1", actorId: FINANCE_MAKER,
  }));
  assert.match(String(badSource?.message), /must be refund, cancellation or goodwill/);
  const negative = await refusal(wallet.creditWallet(db, {
    customerId: CUSTOMER, amount: -500, source: "refund", idempotencyKey: "negative:1", actorId: FINANCE_MAKER,
  }));
  assert.match(String(negative?.message), /Credit amount must be between/);
  assert.equal(await wallet.walletBalance(db, CUSTOMER), 1000, "neither refusal moved the balance");
});

// ---------------------------------------------------------------------------------------------
test("A manual wallet credit needs a distinct checker, and the route can never mint one", async () => {
  const { sqlite, db } = await walletWorld();

  // Every positive manual credit needs approval: the threshold is 0, asserted as a VALUE, and the
  // smallest creditable amount really does open a pending request rather than being waved through as
  // "below the threshold".
  assert.equal(wallet.MANUAL_CREDIT_DUAL_CONTROL_THRESHOLD, 0);
  const smallest = await wallet.requestWalletCredit(db, {
    customerId: OTHER_CUSTOMER, amount: 0.01, source: "goodwill", idempotencyKey: "goodwill:paisa", requestedBy: FINANCE_MAKER,
  });
  assert.equal(smallest.status, "pending", "one paisa still needs a checker");
  assert.equal(await wallet.walletBalance(db, OTHER_CUSTOMER), 0);
  /*
   * SABOTAGE NOTE. Deleting requestWalletCredit's own `amount > THRESHOLD` check does not redden
   * anything here, and cannot: with the threshold at 0 that check refuses exactly the amounts
   * canonicalCredit has already refused one line earlier ("Credit amount must be between 0.01 and
   * 1000000"). It is currently unreachable, so the mutation is equivalent. The assertions above are the
   * ones that matter if the threshold is ever RAISED — a threshold of, say, 500 would make the 0.01
   * request throw and would change the constant, and both are asserted.
   */

  // MAKER: the request records nothing in the wallet.
  const requested = await wallet.requestWalletCredit(db, {
    customerId: CUSTOMER, amount: 2500, source: "goodwill",
    idempotencyKey: "goodwill:case-1", note: "service recovery", requestedBy: FINANCE_MAKER,
  });
  assert.equal(requested.status, "pending");
  assert.equal(requested.requiresApproval, true);
  assert.equal(await wallet.walletBalance(db, CUSTOMER), 0, "a pending request must not move money");
  assert.equal(totalRows(sqlite), 0, "and must not post a journal");

  // The same maker cannot approve their own request: 403, and still nothing moves.
  const selfApproval = await refusal(wallet.approveWalletCreditRequest(db, { requestId: requested.id, approvedBy: FINANCE_MAKER }));
  assert.equal(selfApproval?.status, 403, `self-approval must be refused: ${JSON.stringify(selfApproval)}`);
  assert.match(String(selfApproval?.body?.error), /distinct finance actor/);
  assert.equal(await wallet.walletBalance(db, CUSTOMER), 0);
  assert.equal(String(sqlite.prepare("SELECT status FROM pawspace_wallet_credit_requests WHERE id=?").get(requested.id).status), "pending");

  // A DISTINCT checker approves, and the money moves exactly once.
  const approved = await wallet.approveWalletCreditRequest(db, { requestId: requested.id, approvedBy: FINANCE_CHECKER });
  assert.equal(approved.newlyApproved, true);
  assert.equal(approved.status, "approved");
  assert.equal(approved.approvedBy, FINANCE_CHECKER);
  assert.equal(await wallet.walletBalance(db, CUSTOMER), 2500);

  // Re-approval is idempotent, not a second credit.
  const again = await wallet.approveWalletCreditRequest(db, { requestId: requested.id, approvedBy: FINANCE_CHECKER });
  assert.equal(again.alreadyApproved, true);
  assert.equal(await wallet.walletBalance(db, CUSTOMER), 2500, "approving twice does not credit twice");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM pawspace_wallet_ledger").get().c), 1);

  // THE ROUTE, on a real hostname. A finance actor's credit call opens a REQUEST (202) — it cannot mint.
  // This is the branch a localhost conversion would have missed entirely: on a preview host the same
  // call takes the developmentPreview path and credits directly.
  const post = async (actorEmail, body) => {
    const response = await walletRoute.POST(new Request(`${ORIGIN}/api/pawspace-wallet`, {
      method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-email": actorEmail },
      body: JSON.stringify(body),
    }));
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const viaRoute = await post(FINANCE_MAKER, { action: "credit", customerId: OTHER_CUSTOMER, amount: 700, source: "cancellation", idempotencyKey: "route:case-1" });
  assert.equal(viaRoute.status, 202, `a staff credit must be a pending request, not a mint: ${JSON.stringify(viaRoute)}`);
  assert.equal(viaRoute.body?.data?.status, "pending");
  assert.equal(await wallet.walletBalance(db, OTHER_CUSTOMER), 0, "and no money exists yet");

  // finance.manage is required: `admin` holds finance.view and is still refused.
  const asAdmin = await post(ADMIN, { action: "credit", customerId: OTHER_CUSTOMER, amount: 700, source: "cancellation", idempotencyKey: "route:case-2" });
  assert.ok(asAdmin.status === 403 || asAdmin.status === 401, `admin must not create wallet credit: ${JSON.stringify(asAdmin)}`);
  const anonymous = await post("", { action: "credit", customerId: OTHER_CUSTOMER, amount: 700, source: "cancellation", idempotencyKey: "route:case-3" });
  assert.ok(anonymous.status === 401 || anonymous.status === 403, `an anonymous caller must not create wallet credit: ${JSON.stringify(anonymous)}`);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM pawspace_wallet_credit_requests").get().c), 3,
    "only the three authorised requests exist — the admin and anonymous attempts wrote nothing");

  // The gateway's own mapping of this surface, from authorizeApiRequest rather than from its source
  // text: reading a wallet is a customer action, minting credit is a finance action. The two branches
  // are proven by two actors SWAPPING places — `admin` holds scheduling.book but not finance.manage,
  // `finance` the reverse — so neither branch can silently collapse into the other.
  const gateway = await import("../lib/api-gateway.ts");
  const decide = async (actorEmail, init = {}) => {
    const headers = { ...(init.headers ?? {}), ...(actorEmail ? { "oai-authenticated-user-email": actorEmail } : {}) };
    const decision = await gateway.authorizeApiRequest(new Request(`${ORIGIN}/api/pawspace-wallet`, { ...init, headers }), { DB: db });
    return decision instanceof Response ? { refused: decision.status } : { permission: decision.permission };
  };
  const creditCall = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "credit" }) };
  const redeemCall = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "redeem" }) };
  assert.deepEqual(await decide(ADMIN), { permission: "scheduling.book" }, "reading a wallet is a booking-side permission");
  assert.deepEqual(await decide(ADMIN, redeemCall), { permission: "scheduling.book" }, "so is redeeming one");
  assert.deepEqual(await decide(ADMIN, creditCall), { refused: 403 }, "but admin cannot mint credit");
  assert.deepEqual(await decide(FINANCE_MAKER, creditCall), { permission: "finance.manage" }, "minting credit is a finance permission");
  assert.deepEqual(await decide(FINANCE_MAKER, redeemCall), { refused: 403 }, "and finance cannot redeem on a customer's behalf");
  assert.deepEqual(await decide(""), { refused: 401 }, "no wallet surface is public");
});

// ---------------------------------------------------------------------------------------------
test("The 10% enhanced redemption never exceeds the booking and expenses the bonus", async () => {
  const { sqlite, db } = await walletWorld({ bookingTotal: 5000 });

  // THE ARITHMETIC, EXECUTED. Rs 1,000 of wallet buys Rs 1,100 of booking value: Rs 1,000 spent plus a
  // Rs 100 bonus. The old test asserted the two formula lines appeared in the source.
  assert.deepEqual(wallet.quoteWalletRedemption(1000, 5000), { appliedValue: 1100, walletUsed: 1000, bonus: 100 });
  // And the ceiling is the BOOKING, never the balance: Rs 10,000 of wallet against a Rs 5,000 booking
  // applies Rs 5,000 and spends only what that costs — Rs 4,545.45 plus a Rs 454.55 bonus.
  const capped = wallet.quoteWalletRedemption(10_000, 5000);
  assert.equal(capped.appliedValue, 5000, "applied value can never exceed the booking total");
  assert.equal(capped.walletUsed, 4545.45);
  assert.equal(capped.bonus, 454.55);
  assert.equal(Math.round((capped.walletUsed + capped.bonus) * 100) / 100, 5000, "and the two halves add back to the applied value");
  assert.equal(wallet.WALLET_BONUS_RATE, 0.1, "the bonus rate is 10%, asserted as a value");

  await wallet.creditWallet(db, { customerId: CUSTOMER, amount: 1000, source: "cancellation", idempotencyKey: "cancel:1", actorId: FINANCE_MAKER });

  const redeemed = await wallet.redeemWalletForBooking(db, { customerId: CUSTOMER, bookingId: BOOKING, actorId: CUSTOMER });
  assert.deepEqual(
    { walletUsed: redeemed.walletUsed, bonus: redeemed.bonus, appliedValue: redeemed.appliedValue, balance: redeemed.balance },
    { walletUsed: 1000, bonus: 100, appliedValue: 1100, balance: 0 });
  assert.equal(await wallet.walletBalance(db, CUSTOMER), 0, "the balance really is spent");

  // The redemption row, read back: a negative ledger amount, the bonus and the applied value separated.
  const ledger = sqlite.prepare("SELECT entry_type,amount,bonus_amount,applied_value,source_id FROM pawspace_wallet_ledger WHERE entry_type='redeem'").get();
  assert.deepEqual(
    { type: String(ledger.entry_type), amount: Number(ledger.amount), bonus: Number(ledger.bonus_amount), applied: Number(ledger.applied_value), booking: String(ledger.source_id) },
    { type: "redeem", amount: -1000, bonus: 100, applied: 1100, booking: BOOKING });

  // THE DOUBLE ENTRY: the liability we owed is discharged, the bonus is our own expense, and the
  // customer's booking is credited with the full enhanced value. The bonus being an EXPENSE rather than
  // a discount is the whole reason the 10% top-up shows up in the P&L.
  const lines = journalLines(sqlite, `JRN-wallet-redeem-${BOOKING}`);
  assert.deepEqual(lines.map((line) => [String(line.account_code), Number(line.debit), Number(line.credit)]), [
    [ACCT.WALLET_LIABILITY, 1000, 0],
    [ACCT.WALLET_BONUS_EXPENSE, 100, 0],
    [ACCT.CREDITS_APPLIED, 0, 1100],
  ]);
  assert.equal(Number(lines.reduce((sum, l) => sum + Number(l.debit) - Number(l.credit), 0)), 0, "and it balances");
});

// ---------------------------------------------------------------------------------------------
test("Wallet redemption is once per booking, own-booking only, and capped by credit already applied", async () => {
  const { sqlite, db } = await walletWorld({ bookingTotal: 5000 });
  await wallet.creditWallet(db, { customerId: CUSTOMER, amount: 6000, source: "refund", idempotencyKey: "refund:big", actorId: FINANCE_MAKER });
  await wallet.creditWallet(db, { customerId: OTHER_CUSTOMER, amount: 2000, source: "refund", idempotencyKey: "refund:other", actorId: FINANCE_MAKER });

  // OWNERSHIP: another customer cannot spend their credit on this booking. The old test asserted the
  // refusal STRING existed in the source; this one attempts the act.
  const cross = await refusal(wallet.redeemWalletForBooking(db, { customerId: OTHER_CUSTOMER, bookingId: BOOKING, actorId: OTHER_CUSTOMER }));
  assert.match(String(cross?.message), /only spend wallet credit on your own booking/);
  assert.equal(await wallet.walletBalance(db, OTHER_CUSTOMER), 2000, "and their balance is untouched");

  // A booking that does not exist is refused rather than treated as a zero-total booking.
  const missing = await refusal(wallet.redeemWalletForBooking(db, { customerId: CUSTOMER, bookingId: "BKG-NOPE", actorId: CUSTOMER }));
  assert.match(String(missing?.message), /Booking not found/);

  // PARTIAL redemption: Rs 1,000 of the Rs 6,000 balance, leaving Rs 5,000.
  const partial = await wallet.redeemWalletForBooking(db, { customerId: CUSTOMER, bookingId: BOOKING, walletAmount: 1000, actorId: CUSTOMER });
  assert.equal(partial.appliedValue, 1100);
  assert.equal(await wallet.walletBalance(db, CUSTOMER), 5000);

  /*
   * ONCE PER BOOKING: the second redemption is refused, and refunds nothing from the balance. Without
   * this a customer could apply their whole balance to one booking in slices.
   *
   * SABOTAGE NOTE. Deleting the early `if (prior) throw` fast path does NOT redden this assertion, and
   * that is correct rather than a gap: the lock is enforced twice. The second layer is
   * `idempotency_key TEXT NOT NULL UNIQUE` on pawspace_wallet_ledger — the INSERT fails, the debit is
   * rolled back with applyDelta, and the same refusal is raised from the catch. Removing either layer
   * alone is observationally identical through the public interface (same message, same balance, one
   * redeem row), so no assertion on the outside of this function can separate them. Recorded as an
   * equivalent mutation, not fixed by weakening anything.
   */
  const second = await refusal(wallet.redeemWalletForBooking(db, { customerId: CUSTOMER, bookingId: BOOKING, walletAmount: 1000, actorId: CUSTOMER }));
  assert.match(String(second?.message), /already been applied to this booking/);
  assert.equal(await wallet.walletBalance(db, CUSTOMER), 5000, "the refused second attempt did not debit");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM pawspace_wallet_ledger WHERE entry_type='redeem'").get().c), 1);

  // CAPPED BY WHAT IS STILL PAYABLE. On a second booking, points already applied reduce the ceiling: a
  // Rs 2,000 booking carrying Rs 2,000 of points has nothing left to cover, so the wallet is refused
  // rather than pushing total credit past the order value.
  const now = Date.now();
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,status,total_amount,created_at,updated_at) VALUES (?,?,'grooming','confirmed',2000,?,?)")
    .run("BKG-WALLET-COVERED", CUSTOMER, now, now);
  sqlite.exec("CREATE TABLE IF NOT EXISTS paw_points_ledger (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,entry_type TEXT NOT NULL,points REAL NOT NULL,booking_id TEXT,created_at INTEGER NOT NULL)");
  // 4,000 points at Rs 0.50 each = Rs 2,000 of credit already applied, which is the whole booking.
  sqlite.prepare("INSERT INTO paw_points_ledger (id,customer_id,entry_type,points,booking_id,created_at) VALUES ('PP-1',?,'redeemed',-4000,?,?)")
    .run(CUSTOMER, "BKG-WALLET-COVERED", now);
  const fullyCovered = await refusal(wallet.redeemWalletForBooking(db, { customerId: CUSTOMER, bookingId: "BKG-WALLET-COVERED", actorId: CUSTOMER }));
  assert.match(String(fullyCovered?.message), /already fully covered by credit you have applied/);
  assert.equal(await wallet.walletBalance(db, CUSTOMER), 5000, "and nothing was spent on it");
});

// ---------------------------------------------------------------------------------------------
test("Revenue recognises per used session and an advance booking only on utilisation", async () => {
  const { sqlite, db } = await walletWorld();

  // A Rs 12,000 ten-session subscription, collected to the bank. The cash is a LIABILITY, not revenue.
  const schedule = await revrec.recordDeferredRevenue(db, {
    sourceType: "subscription", sourceId: "SUB-WALLET-1", customerId: CUSTOMER, serviceCode: "grooming",
    totalAmount: 12_000, totalUnits: 10, collectedToBank: true, at: "2026-03-01", actorId: FINANCE_MAKER,
  });
  assert.equal(schedule.liabilityAccount, ACCT.DEFERRED_REVENUE, "a subscription defers to Deferred Revenue");
  assert.equal(schedule.perUnitValue, 1200);
  const collection = journalLines(sqlite, "JRN-revrec-collect-SUB-WALLET-1");
  assert.deepEqual(collection.map((l) => [String(l.account_code), Number(l.debit), Number(l.credit)]), [
    [ACCT.BANK, 12_000, 0],
    [ACCT.DEFERRED_REVENUE, 0, 12_000],
  ], "collection is cash against a liability — no revenue on the P&L yet");
  assert.deepEqual(await revrec.deferredRevenueBalance(db), { deferredSubscription: 12_000, advanceBookings: 0, total: 12_000 });
  assert.equal((await revrec.recognizedRevenueForPeriod(db, "2026-03")).recognizedRevenue, 0, "nothing is recognised on collection");

  // Three sessions used: Rs 3,600 recognised, Rs 8,400 still deferred.
  const three = await revrec.recognizeSubscriptionUsage(db, { sourceId: "SUB-WALLET-1", sessionsConsumed: 3, at: "2026-03-10", actorId: FINANCE_MAKER });
  assert.equal(three.amount, 3600);
  assert.equal(three.units, 3);
  assert.equal(three.status, "open");
  assert.equal((await revrec.getRevenueSchedule(db, "SUB-WALLET-1")).deferredAmount, 8400);

  // The recognition journal moves the LIABILITY to revenue — it never touches cash, which is why the
  // cash-flow statement must exclude it (asserted in the next test).
  const recognition = journalLines(sqlite, "JRN-revrec-recognize-SUB-WALLET-1:sessions:3");
  assert.deepEqual(recognition.map((l) => [String(l.account_code), Number(l.debit), Number(l.credit)]), [
    [ACCT.DEFERRED_REVENUE, 3600, 0],
    [ACCT.REVENUE, 0, 3600],
  ]);

  /*
   * CUMULATIVE, not incremental: re-reporting three sessions recognises nothing more.
   *
   * SABOTAGE NOTE. Deleting the inner `if (prior) return { alreadyRecognized: true ... }` in
   * recognize() does not redden this, because the outer guards make it unreachable through the module's
   * public API: recognizeSubscriptionUsage returns no_new_sessions when delta <= 0 and
   * recognizeAdvanceBooking returns already_recognized on a fully_recognized schedule, so no caller can
   * reach recognize() twice with the same sequence key. If one ever could, the UNIQUE index on
   * revenue_recognition_events.idempotency_key would refuse the insert rather than double-recognise.
   * Recorded as an equivalent mutation.
   */
  const repeat = await revrec.recognizeSubscriptionUsage(db, { sourceId: "SUB-WALLET-1", sessionsConsumed: 3, at: "2026-03-11", actorId: FINANCE_MAKER });
  assert.deepEqual({ recognized: repeat.recognized, reason: repeat.reason }, { recognized: false, reason: "no_new_sessions" });
  assert.equal((await revrec.getRevenueSchedule(db, "SUB-WALLET-1")).recognizedAmount, 3600);

  // The FINAL session sweeps the remainder so the whole amount recognises exactly, with no rounding
  // drift left stranded in the liability.
  const last = await revrec.recognizeSubscriptionUsage(db, { sourceId: "SUB-WALLET-1", sessionsConsumed: 10, at: "2026-04-02", actorId: FINANCE_MAKER });
  assert.equal(last.amount, 8400);
  assert.equal(last.status, "fully_recognized");
  assert.deepEqual(await revrec.deferredRevenueBalance(db), { deferredSubscription: 0, advanceBookings: 0, total: 0 });
  // And the revenue lands in the month it was USED, not the month it was collected.
  assert.equal((await revrec.recognizedRevenueForPeriod(db, "2026-03")).recognizedRevenue, 3600);
  assert.equal((await revrec.recognizedRevenueForPeriod(db, "2026-04")).recognizedRevenue, 8400);

  // THE REMAINDER SWEEP, on an amount that does NOT divide evenly. Rs 1,000 over three sessions is
  // Rs 333.33 each; recognising the last one at per-unit value would strand a paisa in the liability
  // forever, so the final session books the exact remainder — Rs 333.34, not Rs 333.33.
  await revrec.recordDeferredRevenue(db, {
    sourceType: "subscription", sourceId: "SUB-WALLET-ODD", customerId: CUSTOMER,
    totalAmount: 1000, totalUnits: 3, collectedToBank: true, at: "2026-05-01", actorId: FINANCE_MAKER,
  });
  assert.equal((await revrec.recognizeSubscriptionUsage(db, { sourceId: "SUB-WALLET-ODD", sessionsConsumed: 2, at: "2026-05-05", actorId: FINANCE_MAKER })).amount, 666.66);
  const sweep = await revrec.recognizeSubscriptionUsage(db, { sourceId: "SUB-WALLET-ODD", sessionsConsumed: 3, at: "2026-05-09", actorId: FINANCE_MAKER });
  assert.equal(sweep.amount, 333.34, "the final session sweeps the remainder, it does not book per-unit value");
  assert.equal((await revrec.getRevenueSchedule(db, "SUB-WALLET-ODD")).deferredAmount, 0, "and nothing is stranded in the liability");

  // ADVANCE BOOKING: a different liability account, and recognised only when utilised.
  const advance = await revrec.recordDeferredRevenue(db, {
    sourceType: "advance_booking", sourceId: "ADV-WALLET-1", customerId: CUSTOMER,
    totalAmount: 4000, collectedToBank: true, at: "2026-04-05", actorId: FINANCE_MAKER,
  });
  assert.equal(advance.liabilityAccount, ACCT.ADVANCE_FROM_CUSTOMERS);
  assert.equal((await revrec.deferredRevenueBalance(db)).advanceBookings, 4000, "held as a liability until used");
  const wrongKind = await refusal(revrec.recognizeSubscriptionUsage(db, { sourceId: "ADV-WALLET-1", sessionsConsumed: 1, actorId: FINANCE_MAKER }));
  assert.match(String(wrongKind?.message), /not a subscription/);
  const utilised = await revrec.recognizeAdvanceBooking(db, { sourceId: "ADV-WALLET-1", at: "2026-04-20", actorId: FINANCE_MAKER });
  assert.equal(utilised.amount, 4000);
  assert.deepEqual(await revrec.deferredRevenueBalance(db), { deferredSubscription: 0, advanceBookings: 0, total: 0 });
  const twice = await revrec.recognizeAdvanceBooking(db, { sourceId: "ADV-WALLET-1", at: "2026-04-21", actorId: FINANCE_MAKER });
  assert.deepEqual({ recognized: twice.recognized, reason: twice.reason }, { recognized: false, reason: "already_recognized" });

  // A schedule must exist first, and the source vocabulary is closed.
  assert.match(String((await refusal(revrec.recognizeAdvanceBooking(db, { sourceId: "ADV-NOPE", actorId: FINANCE_MAKER })))?.message), /No revenue schedule/);
  assert.match(String((await refusal(revrec.recordDeferredRevenue(db, { sourceType: "tip", sourceId: "X", customerId: CUSTOMER, totalAmount: 10, actorId: FINANCE_MAKER })))?.message),
    /must be subscription or advance_booking/);
});

// ---------------------------------------------------------------------------------------------
test("The cash-flow statement is direct-method, excludes non-cash journals and reconciles", async () => {
  const { sqlite, db } = await walletWorld();

  // CLASSIFICATION, EXECUTED rather than read: the section is decided by the counterpart account's
  // number range.
  assert.equal(accounts.cashFlowSection("1500-Kennel Equipment"), "investing");
  assert.equal(accounts.cashFlowSection("2500-Term Loan"), "financing");
  assert.equal(accounts.cashFlowSection("3000-Share Capital"), "financing");
  assert.equal(accounts.cashFlowSection(ACCT.REVENUE), "operating");
  assert.equal(accounts.cashFlowSection(ACCT.DEFERRED_REVENUE), "operating");
  // Gateway clearing is deliberately NOT a cash account: money captured is not money in the bank.
  assert.equal(accounts.CASH_ACCOUNTS.has(ACCT.BANK), true);
  assert.equal(accounts.CASH_ACCOUNTS.has(ACCT.CASH), true);
  assert.equal(accounts.CASH_ACCOUNTS.has(ACCT.GATEWAY_CLEARING), false);

  const post = (groupKey, entryDate, narration, lines) => accounts.postJournal(db, {
    groupKey, entryDate, periodCode: entryDate.slice(0, 7), sourceType: "test", sourceId: groupKey, narration, lines,
  });

  // February — strictly before the window, so it is OPENING cash, not movement.
  await post("cf-opening", "2026-02-20", "February collection", [{ accountCode: ACCT.BANK, debit: 7000 }, { accountCode: ACCT.REVENUE, credit: 7000 }]);
  // March — inside the window: one operating inflow, one investing outflow, one financing inflow.
  await post("cf-operating", "2026-03-05", "March collection", [{ accountCode: ACCT.BANK, debit: 10_000 }, { accountCode: ACCT.REVENUE, credit: 10_000 }]);
  await post("cf-investing", "2026-03-08", "Grooming van", [{ accountCode: "1500-Vehicles", debit: 4000 }, { accountCode: ACCT.BANK, credit: 4000 }]);
  await post("cf-financing", "2026-03-12", "Term loan drawdown", [{ accountCode: ACCT.BANK, debit: 3000 }, { accountCode: "2500-Term Loan", credit: 3000 }]);
  // A NON-CASH journal in the same month: revenue recognition moves a liability to revenue and must not
  // appear anywhere in the statement. This is the exclusion the old test asserted as a source line.
  await post("cf-noncash", "2026-03-15", "Recognise deferred revenue", [{ accountCode: ACCT.DEFERRED_REVENUE, debit: 2500 }, { accountCode: ACCT.REVENUE, credit: 2500 }]);
  // A cash journal AFTER the window must not leak into it either.
  await post("cf-after", "2026-04-02", "April collection", [{ accountCode: ACCT.BANK, debit: 999 }, { accountCode: ACCT.REVENUE, credit: 999 }]);

  const statement = await cashflow.generateCashFlowStatement(db, { periodCode: "2026-03" });
  assert.equal(statement.method, "direct");
  assert.equal(statement.openingCash, 7000, "February is opening cash, not March movement");
  assert.equal(statement.operating.total, 10_000);
  assert.equal(statement.investing.total, -4000, "capex is an outflow");
  assert.equal(statement.financing.total, 3000);
  assert.equal(statement.netChangeInCash, 9000);
  assert.equal(statement.closingCash, 16_000);
  assert.equal(statement.reconciled, true, "the sections must add up to the movement and to the closing balance");

  /*
   * The non-cash journal is absent by NARRATION, so the exclusion is proven by what is not there.
   *
   * SABOTAGE NOTE. Two guards enforce this and either one alone is sufficient: `if (!cashLines.length)
   * continue` and, one line later, `if (cashDelta === 0) continue`. Removing EITHER on its own is
   * observationally identical (verified: both survive individually); removing BOTH — which is the
   * actual defect, a revenue-recognition journal landing in the cash-flow statement — reddens this
   * test. The redundancy is in the production code, not a gap in this assertion.
   */
  const narrations = statement.detail.map((line) => line.narration);
  assert.ok(narrations.includes("March collection"), `non-vacuity: cash journals do appear: ${JSON.stringify(narrations)}`);
  assert.equal(narrations.includes("Recognise deferred revenue"), false, "a non-cash journal contributes nothing");
  assert.equal(narrations.includes("April collection"), false, "and neither does a month outside the window");
  assert.equal(statement.detail.length, 3, "exactly the three cash journals of March");

  // A window covering both months carries both, which is what makes the single-month figures above a
  // real filter and not just an empty table.
  const window = await cashflow.generateCashFlowStatement(db, { fromPeriod: "2026-03", toPeriod: "2026-04" });
  assert.equal(window.netChangeInCash, 9999);
  assert.equal(window.closingCash, 16_999);
  assert.equal(window.reconciled, true);

  // A missing period is refused rather than reported as a zero statement.
  assert.match(String((await refusal(cashflow.generateCashFlowStatement(db, {})))?.message), /A period \(YYYY-MM\) is required/);

  // THE ROUTE'S finance.view GATE, executed on a real hostname.
  const get = async (actorEmail, query) => {
    const headers = actorEmail ? { "oai-authenticated-user-email": actorEmail } : {};
    const response = await cashflowRoute.GET(new Request(`${ORIGIN}/api/cash-flow-statement?${query}`, { headers }));
    return { status: response.status, body: await response.json().catch(() => null), cacheControl: response.headers.get("cache-control") };
  };
  const anonymous = await get("", "period=2026-03");
  assert.ok(anonymous.status === 401 || anonymous.status === 403, `an anonymous caller must not read the cash-flow statement: ${JSON.stringify(anonymous)}`);
  // A SIGNED-IN staff member without finance.view is refused too. This is the assertion that covers the
  // permission check rather than the sign-in check: resolveActor already refuses the anonymous call
  // above, so on its own that case would still pass with requirePermission deleted entirely.
  const wrongRole = await get(MANAGER, "period=2026-03");
  assert.equal(wrongRole.status, 403, `a manager holds no finance permission and must be refused: ${JSON.stringify(wrongRole)}`);
  assert.equal(wrongRole.body?.data, undefined, "and sees none of the figures");
  const authorised = await get(FINANCE_MAKER, "period=2026-03");
  assert.equal(authorised.status, 200, `finance.view must be allowed through: ${JSON.stringify(authorised)}`);
  assert.equal(authorised.body?.data?.closingCash, 16_000, "and the response carries the real figures");
  assert.equal(authorised.cacheControl, "no-store", "a finance report is never cached");
  assert.equal((await get(FINANCE_MAKER, "")).status, 400, "and a request without a period is a 400, not an empty report");
});
