import {reverseFinancePrecision} from './helpers/ui-finance-precision-review.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
const receipt=JSON.parse(readFileSync(new URL('./fixtures/ui-boarding-finance-next-preservation.json',import.meta.url),'utf8'));
test('Boarding Finance preserves every original source byte after exact presentation reversal',()=>{
 let source=reverseFinancePrecision(readFileSync(new URL('../'+receipt.file,import.meta.url),'utf8'),receipt.file);
 for(const [before,after] of [...receipt.replacements].reverse()){
 assert.equal(source.split(after).length,2,'Exactly one scoped reviewed hook');source=source.replace(after,before);
 }
 assert.equal(createHash('sha256').update(source).digest('hex'),receipt.beforeHash);
});
installWorkersHooks('__BOARDING_FINANCE_NEXT_TEST__');
const {default:Workspace,BoardingFinanceBooking,BoardingFinanceQueue}=await import('../app/team/finance/boarding/boarding-finance-workspace.tsx');
const denied=()=>{throw new Error('SSR must never invoke Finance authority');};
test('actual Boarding loader keeps its existing labeled input, disabled/empty gate and Finance route',()=>{
 const html=renderToStaticMarkup(h(Workspace,{initialBookingId:''}));
 assert.match(html,/class="boarding"/);assert.match(html,/class="bookingLookup"/);
 assert.match(html,/aria-label="Boarding booking ID"/);assert.match(html,/disabled=""/);
 assert.match(html,/href="\/team\/finance"/);assert.match(html,/Loading pending Boarding requests/);
});
test('actual Boarding loaded snapshot retains canonical values and completion gate',()=>{
 const data={bookingId:'UI-ONLY',stay:{booking_status:'confirmed',stay_status:'active',total_amount:1398,payment_status:'captured',city_id:'blr'},cancellations:[],refunds:[{id:'R',status:'sandbox_pending',amount:279.6}],changes:[],settlement:null,reconciliation:null};
 const html=renderToStaticMarkup(h(BoardingFinanceBooking,{data,busy:false,on:Object.fromEntries(['approveCancel','recordRefund','applyDateChange','issueInvoice','configureTax','prepareSettlement','reconcile'].map(k=>[k,denied]))}));
 assert.match(html,/₹1,398/);assert.match(html,/₹279\.60/);assert.match(html,/captured/);
 assert.match(html,/button disabled="">Prepare canonical settlement/);
 assert.match(html,/Record sandbox refund/);assert.match(html,/No live payout|no live payout/);
 const queue=renderToStaticMarkup(h(BoardingFinanceQueue,{queue:{items:[],limit:100},error:'',busy:false,onOpen:denied}));
 assert.match(queue,/No Boarding booking is waiting/);
});
