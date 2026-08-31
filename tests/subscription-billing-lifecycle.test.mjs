import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { addCalendarMonthsClamped } from "../lib/subscription-calendar.ts";

const root=process.cwd();
const read=(file)=>fs.readFileSync(path.join(root,file),"utf8");
const after=(source,marker)=>source.slice(source.indexOf(marker));

test("subscription calendar clamps month-end without rolling into the following month",()=>{
  assert.equal(new Date(addCalendarMonthsClamped(Date.UTC(2027,0,31,12,30),1)).toISOString(),"2027-02-28T12:30:00.000Z");
  assert.equal(new Date(addCalendarMonthsClamped(Date.UTC(2028,0,31,12,30),1)).toISOString(),"2028-02-29T12:30:00.000Z");
  assert.equal(new Date(addCalendarMonthsClamped(Date.UTC(2027,9,31,8,0),4)).toISOString(),"2028-02-29T08:00:00.000Z");
});

test("Razorpay recurring adapter exposes governed lifecycle operations and fail-closed live money",()=>{
  const source=read("lib/razorpay-subscriptions.ts");
  for(const contract of ["createRazorpaySubscription","updateRazorpaySubscription","cancelRazorpaySubscription","pauseRazorpaySubscription","resumeRazorpaySubscription","fetchRazorpaySubscription","createRazorpaySubscriptionRefund"])assert.match(source,new RegExp(`export async function ${contract}`));
  assert.match(source,/PAWSPACE_PAYMENT_LIVE_APPROVED/);
  assert.match(source,/reconciliation_required|Razorpay provider request timed out/);
});

test("billing state machine maps provider dunning and terminal states",()=>{
  const source=read("lib/subscription-billing.ts");
  assert.match(source,/case"pending":return"past_due"/);
  assert.match(source,/case"halted":case"paused":return"suspended"/);
  assert.match(source,/case"cancelled":return"cancelled"/);
  assert.match(source,/case"completed":return"expired"/);
  assert.match(source,/status='past_due'.*grace_expires_at/s);
  assert.match(source,/status='suspended'/);
});

test("renewal accounting is exactly-once and tax invoice mismatch fails closed",()=>{
  const source=read("lib/subscription-billing.ts");
  assert.match(source,/subscription:\$\{event\}:capture/);
  assert.match(source,/subscription:\$\{event\}:deferred/);
  assert.match(source,/issueInvoice/);
  assert.match(source,/subscription_invoice_charge_mismatch/);
  assert.match(source,/accounting_status='exception'/);
});

test("subscription refund maker-checker and provider proration remain capped and idempotent",()=>{
  const billing=read("lib/subscription-billing.ts");
  const refund=read("lib/subscription-refund-reconciliation.ts");
  assert.match(billing,/refund_self_approval_forbidden/);
  assert.match(billing,/UNIQUE\(refund_case_id,from_status\)/);
  assert.match(refund,/kind='provider_proration'/);
  assert.match(refund,/subscription_refunds_exceed_cycle_capture/);
  assert.match(refund,/issueAdjustment/);
  assert.match(refund,/subscription_proration_refund/);
});

test("provider plan must be verified before local activation",()=>{
  const governance=read("lib/subscription-billing-plan-governance.ts");
  const verify=read("lib/razorpay-plan-verification.ts");
  assert.match(governance,/verifyRazorpayPlan/);
  assert.match(governance,/razorpay_plan_mismatch/);
  assert.match(governance,/provider_verified_at/);
  for(const field of ["item.amount","item.currency","body.period","body.interval"])assert.ok(verify.includes(field));
});

test("existing service subscription-plan governance contract remains intact",()=>{
  const governance=read("lib/subscription-plan-governance.ts");
  for(const contract of ["createSubscriptionPlan","updateSubscriptionPlan","listSubscriptionPlans"])assert.match(governance,new RegExp(`export async function ${contract}`));
  assert.match(governance,/addCalendarMonthsClamped/);
});

test("cycle-end plan changes reconcile before accounting and dunning",()=>{
  const scheduled=after(read("lib/subscription-scheduled.ts"),"export async function runSubscriptionScheduledMaintenance");
  const worker=read("worker/index.ts");
  const reconcileIndex=scheduled.indexOf("reconcilePendingSubscriptionPlanChanges");
  const billingIndex=scheduled.indexOf("runSubscriptionBillingSweep");
  const dunningIndex=scheduled.indexOf("enqueueSubscriptionDunningNotifications");
  assert.ok(reconcileIndex>=0&&billingIndex>reconcileIndex&&dunningIndex>billingIndex);
  assert.match(worker,/runSubscriptionScheduledMaintenance/);
  assert.match(worker,/runSubscriptionBillingSweep/);
});

test("subscription-origin payments cannot be counted as a second source-booking payment",()=>{
  const webhook=after(read("app/api/razorpay-webhook/route.ts"),"export async function POST");
  assert.match(webhook,/bookingId=subscriptionOrigin\?undefined/);
  assert.ok(webhook.indexOf("processSubscriptionRefundEvent")<webhook.indexOf("processGatewayEvent"));
  assert.ok(webhook.indexOf("processSubscriptionProviderEvent")<webhook.indexOf("processGatewayEvent"));
});

test("customer and finance mutation routes enforce ownership, role separation and same-origin writes",()=>{
  const customer=read("app/api/subscription-billing/route.ts"),admin=read("app/api/subscription-billing-admin/route.ts"),worker=read("worker/index.ts");
  assert.match(customer,/Cross-origin write blocked/);
  assert.match(customer,/requireCustomerOwnership/);
  assert.match(customer,/authorize\(request,"scheduling\.book"\)/);
  assert.match(admin,/Cross-origin write blocked/);
  assert.match(admin,/finance.manage/);
  assert.match(admin,/pricing.manage/);
  assert.match(worker,/gatewayAuthorizationRequest/);
  assert.match(worker,/\/api\/payment-order/);
  assert.match(worker,/\/api\/pricing-control/);
  assert.match(worker,/\/api\/finance-control/);
});
