import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotCsv} from '../lib/report-snapshot-export.ts';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__ENTERPRISE_VISUAL_DB__');

test('snapshot CSV retains real ledger rows, date scope, quotes and formula safety',()=>{
 const csv=snapshotCsv([{bookingId:'b-1',gross:1200,net:-20,status:'paid',note:'=HYPERLINK("bad")'}],{period:'All loaded records'});
 assert.match(csv,/All loaded records/); assert.match(csv,/"bookingId","gross","net","status","note"/);
 assert.match(csv,/"b-1","1200","-20","paid","'=HYPERLINK\(""bad""\)"/);
 assert.doesNotMatch(csv,/2026-03-01|audited export/);
});
test('CSV preserves heterogeneous columns and null values instead of losing records',()=>{
 const csv=snapshotCsv([{a:0},{b:null,c:'line\n"two"'}],{});
 assert.match(csv,/"a","b","c"/); assert.match(csv,/"0","",""/); assert.match(csv,/"line\n""two"""/);
});
for(const [name,props,expected] of [
 ['split',{mode:'split',totalAmount:1000,amountDueNow:400},['₹0.00','₹400.00','₹600.00']],
 ['balance',{mode:'split',stage:'balance',paidAmount:400,totalAmount:1000,amountDueNow:600},['₹400.00','₹600.00','₹0.00']],
 ['pay after',{mode:'pay_after_service',totalAmount:1000,amountDueNow:1000},['₹0.00','₹0.00','₹1,000.00']],
])test(`${name} payment visual shows accurate allocation without pre-confirming payment`,async()=>{
 const {renderToStaticMarkup}=await import('react-dom/server'); const React=await import('react');
 const {default:Payment}=await import('../app/mobile-app/booking-payment-page.tsx');
 const html=renderToStaticMarkup(React.createElement(Payment,{serviceName:'Test service',...props}));
 const breakdown=html.match(/aria-label="Payment breakdown"[\s\S]*?<\/dl>/)?.[0]; assert.ok(breakdown);
 for(const value of expected)assert.ok(breakdown.includes(value),value);
 assert.doesNotMatch(html,/Payment verified|data-done="true"/);
 if(props.mode==='pay_after_service')assert.doesNotMatch(html,/aria-label="Payment progress"/);
});
