import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__D12_DB__", "__D12_ENV__");

function makeD1(sqlite) {
  function statement(sql, args = []) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => sqlite.prepare(sql).get(...args) ?? null,
      run: async () => {
        const info = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes) } };
      },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: sql => statement(sql),
    batch: async statements => {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

let sqlite;
function freshDb() {
  sqlite = new DatabaseSync(":memory:");
  globalThis.__D12_DB__ = makeD1(sqlite);
  globalThis.__D12_ENV__ = {};
  return globalThis.__D12_DB__;
}

const wallet = await import("../lib/pawspace-wallet-governance.ts");

test("D12 maker step records a pending request without minting wallet value", async () => {
  const db = freshDb();
  assert.equal(wallet.MANUAL_CREDIT_DUAL_CONTROL_THRESHOLD, 0, "policy: every positive manual credit requires dual control");
  const request = await wallet.requestWalletCredit(db, {
    customerId: "CUS-D12",
    amount: 500,
    source: "refund",
    sourceId: "REF-D12",
    idempotencyKey: "manual-d12-1",
    note: "Approved refund as store credit",
    requestedBy: "maker@pawspace.in",
  });
  assert.equal(request.status, "pending");
  assert.equal(request.requiresApproval, true);
  assert.equal(await wallet.walletBalance(db, "CUS-D12"), 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM pawspace_wallet_ledger").get().count, 0);
  const journalTable = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='finance_journal_entries'").get();
  assert.equal(journalTable, undefined, "maker step must not post a finance journal");
});

test("D12 self-approval is 403; a distinct checker mints exactly once across retries and races", async () => {
  const db = freshDb();
  const request = await wallet.requestWalletCredit(db, {
    customerId: "CUS-D12",
    amount: 750,
    source: "goodwill",
    idempotencyKey: "manual-d12-2",
    requestedBy: "maker@pawspace.in",
  });
  await assert.rejects(
    wallet.approveWalletCreditRequest(db, { requestId: request.id, approvedBy: "maker@pawspace.in" }),
    error => error instanceof Response && error.status === 403,
  );
  assert.equal(await wallet.walletBalance(db, "CUS-D12"), 0);

  const outcomes = await Promise.all([
    wallet.approveWalletCreditRequest(db, { requestId: request.id, approvedBy: "checker.one@pawspace.in" }),
    wallet.approveWalletCreditRequest(db, { requestId: request.id, approvedBy: "checker.two@pawspace.in" }),
  ]);
  assert.ok(outcomes.some(result => result.newlyApproved), "one checker must win the guarded approval claim");
  assert.equal(await wallet.walletBalance(db, "CUS-D12"), 750);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM pawspace_wallet_ledger WHERE entry_type='credit'").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM finance_journal_entries").get().count, 2, "one balanced two-line journal only");

  const replay = await wallet.approveWalletCreditRequest(db, { requestId: request.id, approvedBy: "checker.one@pawspace.in" });
  assert.equal(replay.credit.alreadyCredited, true);
  assert.equal(await wallet.walletBalance(db, "CUS-D12"), 750);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM pawspace_wallet_ledger WHERE entry_type='credit'").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM finance_journal_entries").get().count, 2);
});

test("D12 binds request and ledger idempotency keys to payload while system credits stay non-blocking", async () => {
  const db = freshDb();
  const input = {
    customerId: "CUS-D12",
    amount: 200,
    source: "cancellation",
    idempotencyKey: "manual-d12-3",
    requestedBy: "maker@pawspace.in",
  };
  const first = await wallet.requestWalletCredit(db, input);
  const replay = await wallet.requestWalletCredit(db, input);
  assert.equal(replay.id, first.id);
  assert.equal(replay.alreadyRequested, true);
  await assert.rejects(
    wallet.requestWalletCredit(db, { ...input, amount: 201 }),
    error => error instanceof Response && error.status === 409,
  );

  const system = await wallet.creditWallet(db, {
    customerId: "CUS-D12",
    amount: 100,
    source: "refund",
    sourceId: "AUTO-REFUND-1",
    idempotencyKey: "system-refund-1",
    actorId: "system:refund",
  });
  assert.equal(system.alreadyCredited, false, "automated refunds do not wait for a human checker");
  assert.equal(await wallet.walletBalance(db, "CUS-D12"), 100);
  await assert.rejects(
    wallet.creditWallet(db, {
      customerId: "OTHER-CUSTOMER",
      amount: 100,
      source: "refund",
      sourceId: "AUTO-REFUND-1",
      idempotencyKey: "system-refund-1",
      actorId: "system:refund",
    }),
    error => error instanceof Response && error.status === 409,
  );
  assert.equal(await wallet.walletBalance(db, "OTHER-CUSTOMER"), 0);
});

test("D12 route contract keeps maker and checker behind the existing finance.manage gateway action", () => {
  const route = fs.readFileSync(new URL("../app/api/pawspace-wallet/route.ts", import.meta.url), "utf8");
  const gateway = fs.readFileSync(new URL("../lib/api-gateway.ts", import.meta.url), "utf8");
  assert.match(route, /if\(body\.action==="credit"\)/);
  assert.match(route, /if\(body\.requestId\)/, "the same finance-gated action carries the checker step");
  assert.match(route, /requestWalletCredit\(db,/);
  assert.match(route, /approveWalletCreditRequest\(db,/);
  assert.match(route, /requirePermission\(actor,"finance\.manage"\)/);
  assert.match(route, /data\.newlyApproved\?201:200/);
  assert.match(route, /actor\.developmentPreview/, "legacy direct mint is isolated to the local money-test harness");
  assert.match(gateway, /String\(body\.action\|\|""\)==="credit"\?"finance\.manage":"scheduling\.book"/);
});
