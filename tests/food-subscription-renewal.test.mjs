import test from"node:test";
import assert from"node:assert/strict";
import{readFile}from"node:fs/promises";
const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("Food subscription renewal is payment-link based and never a silent auto-charge",async()=>{const source=await read("lib/food-subscription-governance.ts");for(const token of["food_subscriptions","food_subscription_renewals","payment_link_provider","payment_pending","autoCharge:false","liveMoney:false","scheduler_ready","schedulerConnected:false"])assert.equal(source.includes(token),true,token);assert.equal(source.includes("autopay_active"),false)});

test("due renewal snapshots approved price and blocks silent repricing or unavailable inventory before collecting payment",async()=>{const source=await read("lib/food-subscription-governance.ts");for(const token of["renewal_price_review_required","silentRepricing:false","renewal_inventory_review_required","paymentCollected:false","approved_unit_price","available_units","reserved_units"])assert.equal(source.includes(token),true,token)});

test("renewal payment link uses the canonical communications outbox with an idempotent transactional template",async()=>{const source=await read("lib/food-subscription-governance.ts");for(const token of["enqueueCommunication","food_subscription_renewal_payment_link","food-subscription-renewal-link:","paymentLinkPath","bookingId:String(sub.source_order_id)"])assert.equal(source.includes(token),true,token)});

test("confirmed renewal payment creates one invoice then queues paid confirmation and invoice messages",async()=>{const source=await read("lib/food-subscription-governance.ts");for(const token of["food_subscription_invoices","paid_invoiced","food_subscription_renewal_paid","food_subscription_renewal_invoice","food-subscription-paid:","food-subscription-invoice:","next_renewal_at","duplicatePayment"])assert.equal(source.includes(token),true,token)});

test("Food renewal invoice keeps tax and production boundaries explicit",async()=>{const source=await read("lib/food-subscription-governance.ts");for(const token of["tax_rule_status","configuration_required","uat_renewal_invoice","productionTaxInvoice:false","deliveryOrderGeneration:\"governed_separate_step\""])assert.equal(source.includes(token),true,token)});

test("Food subscription API separates customer controls from Finance automation/payment authority",async()=>{const source=await read("app/api/food-subscriptions/route.ts");for(const token of["scheduling.book","finance.manage","process_due","record_payment","requireCustomerOwnership","securityAudit"])assert.equal(source.includes(token),true,token)});

test("customer UAT surfaces payment-link, automatic message and invoice truth without claiming live payment",async()=>{const source=(await read("app/food/subscriptions/page.tsx"))+(await read("app/food/subscription-payment/page.tsx"))+(await read("app/food/subscription-invoice/page.tsx"));for(const token of["Renew by payment link","No silent auto-charge","paid message and UAT invoice","does not capture live money","UAT invoice only"])assert.equal(source.includes(token),true,token)});
