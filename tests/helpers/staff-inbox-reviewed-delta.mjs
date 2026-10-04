import {preservedStaffInboxCodeqlBytes} from './staff-inbox-codeql-reviewed-delta.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const receipt=JSON.parse(readFileSync(new URL('../fixtures/staff-inbox-reviewed-delta.json',import.meta.url),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function preservedStaffInboxBytes(path,bytes){bytes=preservedStaffInboxCodeqlBytes(path,bytes);
 const entry=receipt.files[path];if(!entry)return bytes;
 if(hash(bytes)===entry.beforeSha256)return bytes;
 assert.equal(hash(bytes),entry.afterSha256,'Exact independently reviewed staff inbox bytes required: '+path);
 let out=bytes.toString();for(const [before,after] of entry.replacements){assert.equal(out.split(after).length,2,'Unique staff inbox restoration: '+path);out=out.replace(after,()=>before);}
 assert.equal(hash(out),entry.beforeSha256,'Exact prior staff inbox bytes restored: '+path);
 return Buffer.isBuffer(bytes)?Buffer.from(out):out;
}
