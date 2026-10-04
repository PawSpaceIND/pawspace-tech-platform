import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const receipt=JSON.parse(readFileSync(new URL('../fixtures/service-address-v8-reviewed-delta.json',import.meta.url),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function preservedServiceAddressV8Bytes(path,bytes){
 const entry=receipt.files[path];if(!entry)return bytes;
 const digest=hash(bytes);if(digest===entry.beforeSha256||entry.priorReviewedHashes.includes(digest))return bytes;
 assert.equal(digest,entry.afterSha256,'Exact independently reviewed service-address v8 bytes required: '+path);
 let out=bytes.toString();for(const [before,after] of [...entry.replacements].reverse()){
  assert.equal(out.split(after).length,2,'Unique reviewed service-address v8 replacement: '+path);out=out.replace(after,()=>before);
 }
 assert.equal(hash(out),entry.beforeSha256,'Exact current-main service-address bytes restored: '+path);
 return Buffer.isBuffer(bytes)?Buffer.from(out):out;
}
