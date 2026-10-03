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

// Preservation assertions supplement executable payment evidence; they do not certify live UI.
import {createHash} from 'node:crypto';

const baseline=JSON.parse(readFileSync('tests/fixtures/task2-uat-ui-repair-baseline.json','utf8'));
const hash=s=>createHash('sha256').update(s).digest('hex');
const read=p=>readFileSync(p,'utf8');
test('stay repair preserves booking, identity, guest draft and theme wiring byte for byte',()=>{
 for(const [p,expected] of Object.entries(baseline.unchanged))assert.equal(hash(read(p)),expected,p);
});
test('stay repair only appends scoped hero visibility and in-flow navigation rules',()=>{
 const p='app/v2/stay-experience.module.css',now=read(p);const marker='/* Stay discovery has a dedicated hero;';const addition=now.slice(now.indexOf(marker));let original=now;for(const pair of baseline.repairs[p].reversals)original=original.replace(pair.after,pair.before);assert.equal(hash(original),baseline.repairs[p].oldHash);
 assert.match(addition,/\.page \.art img\s*\{ display:block !important;/);
 assert.match(addition,/\.page \.dock\s*\{ position:static; left:auto; bottom:auto; transform:none;/);
 assert.match(addition,/@media\(max-width:760px\)\s*\{ \.page \.dock \{ width:100%;/);
 assert.match(addition,/:global\(body\):has\(\.page\) :global\(\.paw-appearance-trigger\).*position:relative !important; inset:auto !important;/);
 assert.doesNotMatch(addition,/display:none|pointer-events|visibility:hidden|opacity:0/);
});

function reverse(source,repair){for(const pair of repair.reversals){assert.equal(source.split(pair.after).length,2,'Reviewed replacement must occur exactly once');source=source.replace(pair.after,pair.before);}return source;}
for(const [path,repair] of Object.entries(baseline.repairs))test('Reviewed repair reverses exactly and rejects unrelated mutation: '+path,()=>{
 const source=readFileSync(path,'utf8');assert.equal(hash(source),repair.newHash);
 assert.equal(hash(reverse(source,repair)),repair.oldHash);
 assert.notEqual(hash(reverse(source+'\n/* unauthorized mutation probe */\n',repair)),repair.oldHash);
 const exact=repair.reversals[0].after,mid=Math.floor(exact.length/2);const broken=source.replace(exact,exact.slice(0,mid)+'/* replacement mutation */'+exact.slice(mid));assert.throws(()=>reverse(broken,repair));
});
