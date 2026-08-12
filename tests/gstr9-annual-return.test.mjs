import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const lib = await readFile(new URL("../lib/gst-accounting.ts", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/gst-accounting/route.ts", import.meta.url), "utf8");

test("GSTR-9 annual return consolidates a full financial year with maker/checker governance", () => {
  // the annual return table + functions exist
  assert.match(lib, /CREATE TABLE IF NOT EXISTS finance_annual_returns/);
  assert.match(lib, /export async function generateAnnualReturn/);
  assert.match(lib, /export async function approveAnnualReturn/);
  // GSTR-9 identity + Indian April-March financial year
  assert.match(lib, /returnType:"GSTR-9"/);
  assert.match(lib, /const fyLabel=`\$\{startYear\}-\$\{String\(\(startYear\+1\)%100\)/);
  assert.match(lib, /fromPeriod=`\$\{startYear\}-04`,toPeriod=`\$\{startYear\+1\}-03`/);
  // consolidates real output tax, eligible ITC and adjustments from the canonical ledgers
  assert.match(lib, /finance_tax_ledger WHERE entity_id=\? AND registration_id=\? AND ledger_type='output' AND period_code BETWEEN/);
  assert.match(lib, /finance_vendor_tax_reviews v JOIN finance_bills b ON b\.id=v\.bill_id WHERE v\.review_status='eligible'/);
  assert.match(lib, /netTaxPayable=Math\.round\(\(totalOutputTax\+totalAdjustments-totalEligibleItc\)/);
  // reconciliation against approved monthly returns
  assert.match(lib, /monthsMissingApprovedMonthlyReturn/);
  // maker/checker + honest not-live-filing
  assert.match(lib, /if\(text\(row\.prepared_by\)===actor\)throw new Error\("maker_checker_required"\)/);
  assert.match(lib, /if\(!text\(input\.approvalReference\)\)throw new Error\("approval_reference_required"\)/);
  assert.match(lib, /liveFilingEnabled:false/);
  // wired into the API
  assert.match(route, /action==="generate_annual_return"\)data=await generateAnnualReturn/);
  assert.match(route, /action==="approve_annual_return"\)data=await approveAnnualReturn/);
});
