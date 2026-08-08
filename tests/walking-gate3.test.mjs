import test from"node:test";
import assert from"node:assert/strict";
import{readFile}from"node:fs/promises";
const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("Walking Gate 3 keeps cancellation refund policy explicit and staff-approved",async()=>{const source=await read("lib/walking-finance-governance.ts");assert.match(source,/walking_cancellation_requests/);assert.match(source,/policy_review_required/);assert.match(source,/refundPolicy:\"configuration_required\"/);assert.match(source,/Approved refund amount must be explicitly supplied/);assert.match(source,/explicit_staff_approval/);});

test("Walking Gate 3 refund ledger is sandbox-only and replay resistant",async()=>{const source=await read("lib/walking-finance-governance.ts");assert.match(source,/walking_refund_ledger/);assert.match(source,/sandbox_pending/);assert.match(source,/sandbox_recorded/);assert.match(source,/idx_walking_refund_reference/);assert.match(source,/Refund reference was already used/);});

test("Walking Gate 3 reschedule requires a fresh quote and fresh exact-window reservation",async()=>{const source=await read("lib/walking-finance-governance.ts");assert.match(source,/walking_reschedule_requests/);assert.match(source,/commercial_quote_required/);assert.match(source,/fresh matching Walking server quote/);assert.match(source,/fresh canonical Walking replacement schedule/);assert.match(source,/Replacement Walking reservation does not match the requested window/);assert.match(source,/lower-priced Walking reschedule requires an approved refund policy/);});

test("Walking Gate 3 settlement never invents payout or tax",async()=>{const source=await read("lib/walking-finance-governance.ts");assert.match(source,/walking_settlement_ledger/);assert.match(source,/rule_pending/);assert.match(source,/configuration_required/);assert.match(source,/not_instructed/);});

test("Walking Gate 3 reconciliation surfaces unresolved finance states",async()=>{const source=await read("lib/walking-finance-governance.ts");assert.match(source,/walking_finance_reconciliation/);assert.match(source,/attention_required/);assert.match(source,/refundState/);assert.match(source,/settlementState/);assert.match(source,/taxState/);assert.match(source,/liveMoney:false/);});

test("Walking finance API separates customer requests from Finance authority",async()=>{const api=await read("app/api/walking-finance/route.ts"),gateway=await read("lib/api-gateway.ts"),client=await read("lib/walking-finance-client.ts");assert.match(api,/request_cancel/);assert.match(api,/request_reschedule/);assert.match(api,/requireCustomerOwnership/);assert.match(api,/finance\.manage/);assert.match(api,/securityAudit/);assert.match(gateway,/url\.pathname===\"\/api\/walking-finance\"/);assert.match(gateway,/request_reschedule/);assert.match(client,/\/api\/walking-finance/);});
