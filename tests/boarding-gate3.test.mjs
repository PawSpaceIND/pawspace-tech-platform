import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=(path)=>readFileSync(new URL(`../${path}`,import.meta.url),"utf8");

test("Boarding Gate 3 keeps cancellation refund policy explicit and auditable",()=>{
 const source=read("lib/boarding-finance-governance.ts");
 assert.match(source,/boarding_cancellation_requests/);
 assert.match(source,/policy_review_required/);
 assert.match(source,/refundPolicy:\"configuration_required\"/);
 assert.match(source,/approvedRefundAmount/);
 assert.match(source,/explicit_staff_approval/);
 assert.match(source,/In-progress Boarding cancellation requires an Operations incident workflow/);
 assert.match(source,/UPDATE boarding_capacity_locks SET status='released'/);
 assert.match(source,/UPDATE scheduling_reservations SET status='cancelled'/);
});

test("Boarding Gate 3 refund ledger is sandbox-only and replay resistant",()=>{
 const source=read("lib/boarding-finance-governance.ts");
 assert.match(source,/boarding_finance_action_keys/);
 assert.match(source,/boarding_refund_ledger/);
 assert.match(source,/sandbox_pending/);
 assert.match(source,/sandbox_recorded/);
 assert.match(source,/idx_boarding_refund_reference/);
 assert.match(source,/Refund reference was already used/);
 assert.doesNotMatch(source,/razorpay/i);
});

test("Boarding Gate 3 date changes require fresh canonical quote and capacity",()=>{
 const source=read("lib/boarding-finance-governance.ts");
 assert.match(source,/boarding_date_change_requests/);
 assert.match(source,/commercial_quote_required/);
 assert.match(source,/A fresh open Boarding server quote is required/);
 assert.match(source,/ensureHostCapacityForWindow/);
 assert.match(source,/provider_unavailability/);
 assert.match(source,/A lower-priced date change requires an approved refund policy/);
 assert.match(source,/Additional sandbox payment reference is required/);
 assert.match(source,/UPDATE boarding_capacity_locks SET starts_at=\?,ends_at=\?/);
 assert.match(source,/UPDATE scheduling_reservations SET starts_at=\?,ends_at=\?/);
 assert.match(source,/UPDATE boarding_commercial_quotes SET status='used'/);
});

test("Boarding Gate 3 host settlement never invents payout or tax",()=>{
 const source=read("lib/boarding-finance-governance.ts");
 assert.match(source,/boarding_host_settlement_ledger/);
 assert.match(source,/payout_rule_status TEXT NOT NULL DEFAULT 'rule_pending'/);
 assert.match(source,/tax_status TEXT NOT NULL DEFAULT 'configuration_required'/);
 assert.match(source,/approval_status TEXT NOT NULL DEFAULT 'not_ready'/);
 assert.match(source,/payout_status TEXT NOT NULL DEFAULT 'not_instructed'/);
 assert.match(source,/Host settlement can be prepared only after canonical checkout/);
 assert.match(source,/base_payout REAL/);
 assert.match(source,/travel_allowance REAL/);
 assert.match(source,/incentives REAL/);
 assert.match(source,/penalties REAL/);
 assert.match(source,/cash_adjustment REAL/);
});

test("Boarding Gate 3 reconciliation surfaces unresolved money states",()=>{
 const source=read("lib/boarding-finance-governance.ts");
 assert.match(source,/boarding_finance_reconciliation/);
 assert.match(source,/refundState/);
 assert.match(source,/settlementState/);
 assert.match(source,/taxState/);
 assert.match(source,/attention_required/);
 assert.match(source,/netCustomerAmount/);
});

test("Boarding finance API separates customer requests from finance authority",()=>{
 const api=read("app/api/boarding-finance/route.ts"),gateway=read("lib/api-gateway.ts");
 assert.match(api,/customerActions=new Set<BoardingFinanceAction>\(\[\"request_cancel\",\"request_date_change\"\]\)/);
 assert.match(api,/financeActions=new Set<BoardingFinanceAction>\(\[\"approve_cancel\",\"apply_date_change\",\"record_refund\",\"prepare_settlement\",\"reconcile\"\]\)/);
 assert.match(api,/requireCustomerOwnership\(db,actor,customerId\)/);
 assert.match(api,/requirePermission\(actor,\"finance\.manage\"\)/);
 assert.match(api,/requirePermission\(actor,\"finance\.view\"\)/);
 assert.match(api,/securityAudit/);
 assert.match(api,/sandboxOnly:true/);
 assert.match(gateway,/url\.pathname===\"\/api\/boarding-finance\"/);
 assert.match(gateway,/\[\"request_cancel\",\"request_date_change\"\]/);
 assert.match(gateway,/\?\"scheduling\.book\":\"finance\.manage\"/);
});
