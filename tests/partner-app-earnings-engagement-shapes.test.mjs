import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// The Partner app Earnings tab against BOTH shapes providerWorkspace returns.
//
// providerWorkspace builds two different objects depending on the worker's engagement kind:
//   contract   -> { netPayout, orders, grossOrderValue, computed:{netPayout,...}, settlements, incentives }
//   commission -> { netPayout, orders, grossOrderValue, computed:{commissionAmount,orders},
//                   commissionOrders, payouts }
// There is no settlements or incentives key on the commission shape at all.
//
// The tab read `earnings.computed.netPayout`, which is undefined on the commission shape, so every
// commission partner saw a governed zero. Worse, it then ran `earnings?.settlements.map(...)`: the
// optional chain short-circuits on `earnings`, not on `settlements`, so a commission partner opening
// the tab threw a TypeError into the error boundary rather than seeing their commission ledger.
//
// The shapes below are copied from lib/provider-workspace.ts and the reads from app/partner-app/page.tsx.
// ---------------------------------------------------------------------------

const page = readFileSync(new URL("../app/partner-app/page.tsx", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../lib/provider-workspace.ts", import.meta.url), "utf8");

const contractEarnings = {
  netPayout: 1200, orders: 3, grossOrderValue: 9000, visible: true,
  computed: { netPayout: 1200, orders: 3, grossOrderValue: 9000 },
  settlements: [{ bookingId: "BK-1", payoutAmount: 1200, status: "eligible", reason: "rule v3" }],
  incentives: [{ monthStart: "2026-09-01", status: "finalized", headTotal: 400, helperTotal: 100, monthTotal: 500 }],
  note: "Contract earnings are governed provider earnings, not employee salary payroll.",
};

const commissionEarnings = {
  visible: true, netPayout: 850, orders: 2, grossOrderValue: 5000,
  computed: { commissionAmount: 850, orders: 2 },
  commissionOrders: [{ bookingId: "BK-9", serviceCode: "grooming", orderAmount: 5000, commissionMode: "percentage", commissionValue: 17, commissionAmount: 850, source: "rule", status: "accrued", completedAt: 1, dueAt: 2 }],
  payouts: [{ id: "PO-1", bookingId: "BK-9", amount: 850, status: "pending_approval", dueAt: 2, providerReference: null, updatedAt: 3 }],
  note: "Commission statement is visible to the provider from governed order commissions and payout state.",
};

/** The reads the Earnings tab now performs, in the same precedence order as the page. */
const readTotals = (earnings) => ({
  netPayout: Number(earnings?.netPayout ?? earnings?.computed?.netPayout ?? earnings?.computed?.commissionAmount ?? 0),
  orders: Number(earnings?.orders ?? earnings?.computed?.orders ?? 0),
  gross: Number(earnings?.grossOrderValue ?? earnings?.computed?.grossOrderValue ?? 0),
});

test("providerWorkspace really does return two different earnings shapes", () => {
  // Guard the premise: if these diverge in the library, this test's fixtures must be revisited.
  assert.match(workspace, /const contractEarnings=\{/);
  assert.match(workspace, /const commissionEarnings=\{/);
  assert.match(workspace, /computed:\{commissionAmount:/, "commission computed carries commissionAmount");
  assert.match(workspace, /earnings:engagement==="commission"\?commissionEarnings:contractEarnings/);
  assert.ok(!("settlements" in commissionEarnings), "the commission shape has no settlements key");
  assert.ok(!("incentives" in commissionEarnings), "the commission shape has no incentives key");
});

test("the old reads were a zero for commission partners and a crash on the ledger lists", () => {
  assert.equal(commissionEarnings.computed.netPayout, undefined,
    "computed.netPayout is the field the tab used to read, and it does not exist here");
  assert.throws(() => commissionEarnings?.settlements.map((item) => item),
    TypeError, "optional chaining stops at `earnings`, so the missing settlements key threw");
});

test("both engagement shapes now yield their real totals", () => {
  const contract = readTotals(contractEarnings);
  assert.deepEqual(contract, { netPayout: 1200, orders: 3, gross: 9000 });

  const commission = readTotals(commissionEarnings);
  assert.deepEqual(commission, { netPayout: 850, orders: 2, gross: 5000 },
    "a commission partner's earned commission must reach the screen, not a zero");
  assert.notEqual(commission.netPayout, 0);
});

test("an absent earnings object still reads as zero rather than throwing", () => {
  assert.deepEqual(readTotals(null), { netPayout: 0, orders: 0, gross: 0 });
  assert.deepEqual(readTotals(undefined), { netPayout: 0, orders: 0, gross: 0 });
});

test("every per-engagement list is defaulted before .map in the page source", () => {
  for (const key of ["settlements", "incentives", "commissionOrders", "payouts"]) {
    assert.match(page, new RegExp(`\\(earnings\\.${key} \\?\\? \\[\\]\\)\\.map`),
      `${key} must be defaulted, because it is absent on the other engagement shape`);
    assert.doesNotMatch(page, new RegExp(`earnings\\?\\.${key}\\.map`),
      `${key} must not be read through an optional chain that stops one level too early`);
  }
});

test("the tab reads the top-level totals, not the per-engagement computed block", () => {
  assert.doesNotMatch(page, /money\(earnings\?\.computed\.netPayout \?\? 0\)/,
    "computed.netPayout is undefined for commission partners");
  assert.match(page, /earnings\?\.netPayout \?\? earnings\?\.computed\?\.netPayout \?\? earnings\?\.computed\?\.commissionAmount/);
});

test("the unlinked and withheld states are explained instead of rendered as zero", () => {
  assert.match(page, /linked === false/, "a 200 with linked:false must not render as zero rupees");
  assert.match(page, /earningsNotice/);
  assert.match(page, /visible === false/, "earnings.visible is a governance flag, not decoration");
});

test("the commission ledger and its payout states are rendered somewhere", () => {
  assert.match(page, /earnings\.commissionOrders/);
  assert.match(page, /earnings\.payouts/);
});
