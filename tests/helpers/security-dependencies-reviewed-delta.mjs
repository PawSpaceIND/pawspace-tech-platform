import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const receipt=JSON.parse(readFileSync(new URL('../fixtures/security-dependencies-reviewed-delta.json',import.meta.url))),hash=b=>createHash('sha256').update(b).digest('hex');
// Admit only the exact security patch; retain every historical preservation hash.
export function preservedSecurityDependencyBytes(path,bytes){
 const entry=receipt.files[path];if(!entry||hash(bytes)===entry.beforeSha256)return bytes;
 assert.equal(hash(bytes),entry.afterSha256,'Exact reviewed security dependency delta required: '+path);
 let text=bytes.toString();for(const[before,after]of [...entry.replacements].reverse()){
  assert.equal(text.split(after).length,2,'Unique security dependency reversal: '+path);text=text.replace(after,()=>before);
 }
 assert.equal(hash(text),entry.beforeSha256,'Exact original dependency bytes restored: '+path);
 return Buffer.isBuffer(bytes)?Buffer.from(text):text;
}
