import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const receipt=JSON.parse(readFileSync(new URL('../fixtures/chat-qualification-reviewed-delta.json',import.meta.url))),hash=b=>createHash('sha256').update(b).digest('hex');
export function preservedChatQualificationBytes(path,bytes){
 const e=receipt.files[path];if(!e||hash(bytes)===e.beforeSha256||hash(bytes)===e.historicalBeforeSha256)return bytes;
 assert.equal(hash(bytes),e.afterSha256,'Exact reviewed chat qualification required: '+path);let text=bytes.toString();
 for(const[before,after]of [...e.replacements].reverse()){assert.equal(text.split(after).length,2,'Unique chat qualification reversal: '+path);text=text.replace(after,()=>before);}
 assert.equal(hash(text),e.beforeSha256,'Exact pre-qualification chat restored: '+path);return Buffer.isBuffer(bytes)?Buffer.from(text):text;
}
