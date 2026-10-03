import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import ts from "typescript";
const source=readFileSync("lib/customer-payment-display.ts","utf8");
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const compiled={exports:{}};new Function("exports","module",js)(compiled.exports,compiled);
const {customerPaymentVerified}=compiled.exports;
const base={ready:true,bookingStatus:"completed",paymentMode:"pay_after_service",paymentStatus:"created",transactionId:null,amountDueNow:0,totalAmount:1146.65};
for(const [name,overrides,expected] of [
 ["hosted completed created pay-after null transaction",{},false],
 ["pending Finance cash collection",{paymentStatus:"pending"},false],
 ["actual captured prepaid",{paymentMode:"prepay",paymentStatus:"captured",transactionId:"pay_verified"},true],
 ["prepaid missing transaction",{paymentMode:"prepay",paymentStatus:"captured"},false],
 ["unpaid first deposit",{paymentMode:"split",paymentStage:"first_instalment",amountDueNow:500},false],
 ["captured deposit outstanding balance",{paymentMode:"split",paymentStatus:"captured",transactionId:"pay_deposit",paymentStage:"outstanding_balance",amountDueNow:500},true],
 ["zero-total no capture",{totalAmount:0,paymentMode:"prepay"},false],
 ["credits zero payable no capture",{paymentMode:"prepay",amountDueNow:0},false],
 ["Finance-approved captured cash",{paymentStatus:"captured"},true]
])test(name,()=>assert.equal(customerPaymentVerified({...base,...overrides}),expected));
test("missing projection fails closed",()=>assert.equal(customerPaymentVerified(null),false));
test("view uses canonical evidence and suppresses misleading controller copy",()=>{
 const view=readFileSync("app/mobile-app/booking-confirmation/booking-confirmation-view.tsx","utf8");
 assert.match(view,/const verified = customerPaymentVerified\(projection\)/);
 assert.match(view,/success && verified && <section/);
 assert.match(view,/success && !verified && <section/);
 assert.match(view,/!\["captured", "settled"\]\.includes\(state.phase\)/);
 assert.match(view,/const success = canonicalReady/);
});

test("refund copy takes priority over pay-after collection copy",()=>{
 const view=readFileSync("app/mobile-app/booking-confirmation/booking-confirmation-view.tsx","utf8");
 const message=view.slice(view.indexOf('<p role="status">{["refunded", "partially_refunded"]'));
 assert.ok(message.length>0);
 assert.ok(message.indexOf('"A refund is recorded') < message.indexOf('projection?.paymentMode === "pay_after_service"'));
 for(const paymentStatus of ["refunded","partially_refunded"])assert.equal(customerPaymentVerified({...base,paymentStatus}),false);
});
