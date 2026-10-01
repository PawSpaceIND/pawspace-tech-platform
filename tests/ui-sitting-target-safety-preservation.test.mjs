import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {reverseSittingTargetSafety} from './helpers/ui-sitting-target-safety-review.mjs';
const receipt=JSON.parse(readFileSync(new URL('./fixtures/ui-sitting-target-safety-preservation.json',import.meta.url),'utf8'));
const source=readFileSync(new URL('../'+receipt.file,import.meta.url),'utf8');
const hash=text=>createHash('sha256').update(text).digest('hex');
test('frozen Sitting repair reverses exactly to the UI head and retains its two-decimal formatter',()=>{
 assert.equal(hash(source),receipt.afterHash);
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
