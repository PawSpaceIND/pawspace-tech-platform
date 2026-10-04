import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const entry=JSON.parse(readFileSync(new URL('../fixtures/grooming-auto-refusal-reviewed-delta.json',import.meta.url),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function preservedGroomingAutoRefusalBytes(path,bytes){
 if(path!==entry.file)return bytes;
 if(hash(bytes)===entry.beforeSha256)return bytes;
 assert.equal(hash(bytes),entry.afterSha256,'Exact reviewed Grooming refusal correction required');
 let text=bytes.toString();
 for(const[before,after]of [...entry.replacements].reverse()){
  assert.equal(text.split(after).length,2,'Unique Grooming refusal reversal');text=text.replace(after,()=>before);
 }
 assert.equal(hash(text),entry.beforeSha256,'Exact prior Grooming source restored');
 return Buffer.isBuffer(bytes)?Buffer.from(text):text;
}
