import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {reverseSittingTargetSafety} from './helpers/ui-sitting-target-safety-review.mjs';
import {reverseSittingRowSelection} from './helpers/sitting-finance-row-selection-review.mjs';
const receipt=JSON.parse(readFileSync(new URL('./fixtures/ui-sitting-target-safety-preservation.json',import.meta.url),'utf8'));
const source=readFileSync(new URL('../'+receipt.file,import.meta.url),'utf8');
const hash=text=>createHash('sha256').update(text).digest('hex');
test('frozen Sitting repair reverses exactly to the UI head and retains its two-decimal formatter',()=>{
 // Strip only the independently pinned row-selection and touch additions before this historical hash.
 assert.equal(hash(reverseSittingRowSelection(source,receipt.file)),receipt.afterHash);
 const original=reverseSittingTargetSafety(source,receipt.file);
 assert.equal(hash(original),receipt.beforeHash);
 assert.ok(original.includes('minimumFractionDigits:2,maximumFractionDigits:2'));
 assert.equal(source.match(/minimumFractionDigits:2,maximumFractionDigits:2/g).length,1);
});
test('review reversal rejects changes to request authority, read invalidation and lookup locking',()=>{
 for(const [before,after] of [['bookingId:targetId','bookingId:bookingId.trim()'],['readVersion.current++;setBookingId(value)','setBookingId(value)'],['disabled={actionBusy}','disabled={false}']]){
  assert.ok(source.includes(before));
  assert.throws(()=>reverseSittingTargetSafety(source.replace(before,after),receipt.file),/Exactly one reviewed Sitting/);
 }
});

// Render the real workspace: a lookup alone must not expose controls for an unloaded booking.
import {registerHooks} from 'node:module';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__SITTING_PRESERVATION_TEST__');
registerHooks({resolve(specifier,context,next){
 if(specifier==='../../../components/ui'&&context.parentURL?.includes('/finance/sitting/sitting-finance-workspace.tsx'))return {url:new URL('../../../components/ui/index.ts',context.parentURL).href,shortCircuit:true};
 return next(specifier,context);
}});
const {default:Sitting}=await import('../app/team/finance/sitting/sitting-finance-workspace.tsx');
test('an unloaded Sitting lookup renders its ID without exposing finance actions',()=>{
 const html=renderToStaticMarkup(h(Sitting,{initialBookingId:'SIT-LOOKUP-ONLY'}));
 assert.match(html,/value="SIT-LOOKUP-ONLY"/);
 assert.match(html,/Load booking/);
 for(const action of ['Approve explicitly','Record sandbox refund','Approve date change'])assert.ok(!html.includes(action),action);
 assert.ok(!html.includes('Booking total'));
 const empty=renderToStaticMarkup(h(Sitting,{initialBookingId:''}));
 assert.match(empty,/<button disabled="">Load booking<\/button>/);
});
