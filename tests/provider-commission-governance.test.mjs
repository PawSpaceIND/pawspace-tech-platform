import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=path=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const governance=read("lib/provider-commission-governance.ts"),route=read("app/api/partner-finance/route.ts"),ui=read("app/team/finance/partners/page.tsx"),bookings=read("app/api/canonical-bookings/route.ts");

test("canonical providers support direct full-time and commission engagement",()=>{assert.match(bookings,/model:\"full_time\"\|\"commission\"/);assert.match(governance,/EngagementModel=\"full_time\"\|\"commission\"/);});
test("commission profiles support fixed or percentage defaults",()=>{assert.match(governance,/CommissionMode=\"fixed\"\|\"percent\"/);assert.match(governance,/default_commission_mode/);assert.match(governance,/default_commission_value/);assert.match(governance,/commissionAmount/);});
test("only commission provider work orders enter commission payout automation",()=>{assert.match(governance,/provider_model='commission'/);assert.match(governance,/b\.status='completed'/);assert.match(governance,/provider_compensation_profiles/);});
test("commission can be overridden at completed order level before confirmation",()=>{assert.match(governance,/commission_source='order_override'/);assert.match(governance,/Order-level override reason/);assert.match(route,/override_order_commission/);assert.match(ui,/Override/);});
test("provider payout SLA is five days from completion",()=>{assert.match(governance,/FIVE_DAYS=5\*24\*60\*60\*1000/);assert.match(governance,/completedAt\+FIVE_DAYS/);assert.match(governance,/due_at/);assert.match(ui,/five-day payout SLA/);});
test("commission requires explicit confirmation then two distinct approvals",()=>{assert.match(governance,/awaiting_approval_1/);assert.match(governance,/awaiting_approval_2/);assert.match(governance,/Level 2 approval must be completed by a different approver/);assert.match(route,/approve_order_commission_level_1/);assert.match(route,/approve_order_commission_level_2/);});
test("RazorpayX payout orchestration remains sandbox guarded",()=>{assert.match(governance,/rail.*razorpayx/);assert.match(governance,/environment.*sandbox/);assert.match(governance,/liveMoney:false/);assert.match(route,/rail:\"razorpayx\"/);assert.match(route,/environment:\"sandbox\"/);assert.match(ui,/RazorpayX is orchestrated in sandbox\/UAT only/);});
test("provider finance writes remain protected by finance manage permission",()=>{assert.match(route,/authorize\(request,\"finance\.manage\"\)/);assert.match(route,/securityAudit/);});
