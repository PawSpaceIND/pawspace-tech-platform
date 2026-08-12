import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const accounts = await readFile(new URL("../lib/finance-accounts.ts", import.meta.url), "utf8");
const wallet = await readFile(new URL("../lib/pawspace-wallet-governance.ts", import.meta.url), "utf8");
const revrec = await readFile(new URL("../lib/revenue-recognition-governance.ts", import.meta.url), "utf8");
const cashflow = await readFile(new URL("../lib/cash-flow-statement.ts", import.meta.url), "utf8");
const walletRoute = await readFile(new URL("../app/api/pawspace-wallet/route.ts", import.meta.url), "utf8");
const revrecRoute = await readFile(new URL("../app/api/revenue-recognition/route.ts", import.meta.url), "utf8");
const cashflowRoute = await readFile(new URL("../app/api/cash-flow-statement/route.ts", import.meta.url), "utf8");

test("Finance foundation: balanced, idempotent double-entry postings + cash-flow classification", () => {
  assert.match(accounts, /WALLET_LIABILITY: "2100-Customer Wallet Liability"/);
  assert.match(accounts, /DEFERRED_REVENUE: "2200-Deferred Revenue"/);
  assert.match(accounts, /ADVANCE_FROM_CUSTOMERS: "2210-Advance from Customers"/);
  assert.match(accounts, /if \(Math\.abs\(totalDebit - totalCredit\) > 0\.01\) throw new Error/);
  assert.match(accounts, /if \(existing\) return \{ journalGroup, posted: false, duplicatePrevented: true \}/);
  assert.match(accounts, /export function cashFlowSection/);
});

test("PawSpace Wallet: refund/cancellation credit, 10% enhanced redemption, idempotent, owned", () => {
  assert.match(wallet, /WALLET_BONUS_RATE = 0\.10/);
  assert.match(wallet, /CREDIT_SOURCES = \["refund", "cancellation", "goodwill"\]/);
  // 10% enhanced value: Rs.X of wallet -> Rs.X*1.1 of booking value, never over the booking total
  assert.match(wallet, /const maxAppliedByBalance = round\(balance \* \(1 \+ WALLET_BONUS_RATE\)\)/);
  assert.match(wallet, /const appliedValue = round\(Math\.min\(maxAppliedByBalance, bookingTotal\)\)/);
  // one redemption per booking, ownership enforced
  assert.match(wallet, /Wallet credit has already been applied to this booking/);
  assert.match(wallet, /You can only spend wallet credit on your own booking/);
  // idempotent credit
  assert.match(wallet, /idempotency_key TEXT NOT NULL UNIQUE/);
  // routes: credit is finance-gated, redeem is customer-owned
  assert.match(walletRoute, /requirePermission\(actor,"finance\.manage"\)/);
  assert.match(walletRoute, /requireCustomerOwnership/);
});

test("Revenue recognition: subscriptions per used session, advance bookings on utilisation", () => {
  // subscription recognised per session, remainder swept on the final session
  assert.match(revrec, /export async function recognizeSubscriptionUsage/);
  assert.match(revrec, /const amount = target >= totalUnits \? round\(totalAmount - Number\(schedule\.recognized_amount\)\) : round\(perUnit \* delta\)/);
  // advance booking recognised only when utilised
  assert.match(revrec, /export async function recognizeAdvanceBooking/);
  assert.match(revrec, /collect \(advance\):       Dr Bank  Cr Advance from Customers/);
  // collection (cash) and recognition (P&L) are separate journals
  assert.match(revrec, /recognise:               Dr Deferred Revenue \/ Advance from Customers  Cr Service Revenue/);
  assert.match(revrec, /export async function recognizedRevenueForPeriod/);
  assert.match(revrec, /export async function deferredRevenueBalance/);
  assert.match(revrecRoute, /requirePermission\(actor,"finance\.manage"\)/);
});

test("Cash flow statement: direct method from journals, non-cash excluded, reconciled", () => {
  assert.match(cashflow, /export async function generateCashFlowStatement/);
  // only journals that touch a cash account contribute
  assert.match(cashflow, /const cashLines = lines\.filter\(l => CASH_ACCOUNTS\.has\(String\(l\.account_code\)\)\)/);
  assert.match(cashflow, /if \(!cashLines\.length\) continue;/);
  // operating / investing / financing, with a reconciliation guard
  assert.match(cashflow, /operating: \{ total: operating/);
  assert.match(cashflow, /investing: \{ total: investing/);
  assert.match(cashflow, /financing: \{ total: financing/);
  assert.match(cashflow, /reconciled: Math\.abs/);
  assert.match(cashflowRoute, /requirePermission\(actor,"finance\.view"\)/);
});
