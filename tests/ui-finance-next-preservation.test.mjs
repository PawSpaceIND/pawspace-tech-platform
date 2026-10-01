import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
const receipt=JSON.parse(readFileSync(new URL('./fixtures/ui-finance-next-preservation.json',import.meta.url),'utf8'));
for(const [file,hash] of Object.entries(receipt.beforeHashes))test(`Finance business bytes unchanged: ${file}`,()=>{
 let source=readFileSync(new URL('../'+file,import.meta.url),'utf8').replace('\nimport styles from "./finance-content.module.css";','');
 for(const [before,after] of [...receipt.reversals[file.split('/').at(-1)]].reverse())source=source.replaceAll(after,before);
 assert.equal(createHash('sha256').update(source).digest('hex'),hash);
});
installWorkersHooks('__FINANCE_NEXT_RENDER__');
const {FinanceLedger,paymentStateText,bookingWorkspaceHref}=await import('../app/team/finance/finance-ledger.tsx');
const item={bookingId:'FINANCE-UI',serviceCode:'boarding',packageName:'UI fixture stay',bookingStatus:'confirmed',scheduledStart:null,bookingTotal:1398,paymentId:'PAY-UI',paymentStatus:'captured',paymentMode:'prepaid',amountDueNow:1398,scheduleStatus:'paid',balanceAmount:0,capturedAmount:1398,refundedAmount:279.60,netCollected:1118.40,gatewayStatus:'captured',reconciliationStatus:'matched',varianceAmount:0,openExceptions:0,invoiceNumber:'UI-INVOICE'};
const data={services:[{code:'boarding',label:'Boarding',workspace:'/team/finance/boarding',bookings:1,paidBookings:1,captured:1398,refunded:279.60,attention:0}],items:[item],openExceptions:0,limit:100};
test('actual Finance ledger retains canonical amounts, state, workspaces and both keyboard scroll regions',()=>{
 const html=renderToStaticMarkup(createElement(FinanceLedger,{data,loading:false,service:'boarding',onService:()=>{throw new Error('SSR cannot select services');}}));
 assert.match(html,/class="ledger"/);assert.match(html,/class="filters"/);
 assert.equal((html.match(/class="tableRegion"/g)||[]).length,2);
 assert.equal((html.match(/tabindex="0"/g)||[]).length,2);
 assert.ok(html.includes(paymentStateText(item)));assert.ok(html.includes(bookingWorkspaceHref(item)));
 for(const amount of [1398,279.60,1118.40])assert.ok(html.includes(new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:2}).format(amount)));
 assert.match(html,/UI-INVOICE/);assert.match(html,/aria-pressed="true"/);
 assert.doesNotMatch(html,/Publish GST setting/);
});
test('actual Finance ledger retains loading filter lock and empty filtered state',()=>{
 const loading=renderToStaticMarkup(createElement(FinanceLedger,{data:null,loading:true,service:'',onService:()=>{}}));
 assert.ok(loading.includes('Loading bookings across services…'));assert.match(loading,/disabled=""/);assert.doesNotMatch(loading,/<table/);
 const empty=renderToStaticMarkup(createElement(FinanceLedger,{data:{...data,items:[]},loading:false,service:'boarding',onService:()=>{}}));
 assert.match(empty,/No bookings yet/);assert.match(empty,/colSpan="11"|colspan="11"/);
});
