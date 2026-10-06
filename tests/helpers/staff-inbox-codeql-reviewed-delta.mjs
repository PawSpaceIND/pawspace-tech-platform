import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const receipt=JSON.parse(readFileSync(new URL('../fixtures/staff-inbox-codeql-reviewed-delta.json',import.meta.url)));
const hash=b=>createHash('sha256').update(b).digest('hex');
export function preservedStaffInboxCodeqlBytes(path,bytes){
 const e=receipt.files[path];if(!e)return bytes;
 if(hash(bytes)===e.beforeSha256||e.historicalPassthroughSha256.includes(hash(bytes)))return bytes;
 assert.equal(hash(bytes),e.afterSha256,'Exact accepted staff inbox CodeQL correction required: '+path);
 assert.equal(bytes.toString(),e.afterText);
 assert.equal(hash(e.beforeText),e.beforeSha256);
 return Buffer.isBuffer(bytes)?Buffer.from(e.beforeText):e.beforeText;
}
