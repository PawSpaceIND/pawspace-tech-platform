import {preservedAcceptedUiBytes} from './accepted-ui-reviewed-delta.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const delta=JSON.parse(readFileSync(new URL('../fixtures/service-fix-reviewed-delta.json',import.meta.url),'utf8'));
const hash=value=>createHash('sha256').update(value).digest('hex');
export const serviceFixReviewedFiles=Object.freeze(Object.keys(delta.files));
/**
 * Reverse ONLY the reviewed service-fix customer-flow delta (workbook "Final testing 27th Sep": Grooming rows 1-6,
 * Taxi rows 1-6) on the exact files it touched, so the historical protected-hash fixtures stay immutable and keep
 * guarding every other byte. Three gates, each fail-closed: the whole file must be byte-identical to the reviewed
 * version (any other edit, however small, is refused), every reviewed hunk must occur exactly once, and the reversal
 * must restore the historical bytes exactly. Historical bytes pass through untouched; unrelated paths are returned as they are.
 */
export function reverseServiceFixDelta(source,path){source=preservedAcceptedUiBytes(path,source);
 const entry=delta.files[path];if(!entry)return source;
 const text=Buffer.isBuffer(source)?source.toString():String(source);
 if(hash(text)===entry.originalHash)return text;
 assert.equal(hash(text),entry.reviewedHash,'Only the exact reviewed service-fix delta is accepted: '+path);
 let out=text;
 for(const hunk of [...entry.hunks].reverse()){
  assert.equal(out.split(hunk.reviewed).length,2,'Exactly one reviewed service-fix hunk: '+path);
  out=out.replace(hunk.reviewed,()=>hunk.original);
 }
 assert.equal(hash(out),entry.originalHash,'Reversal must restore the historical bytes exactly: '+path);
 return out;
}
/** Buffer-preserving form for the protected-hash chain in tests/helpers/food-route-review.mjs. */
export function preservedServiceFixBytes(path,bytes){
 if(!delta.files[path])return bytes;
 const out=reverseServiceFixDelta(bytes,path);
 return Buffer.isBuffer(bytes)?Buffer.from(out):out;
}
