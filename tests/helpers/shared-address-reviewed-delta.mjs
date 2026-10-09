import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const receipt=JSON.parse(readFileSync(new URL('../fixtures/shared-address-reviewed-delta.json',import.meta.url)));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
/** Exact composed source only; restore current-main bytes before older preservation layers. */
export function preservedSharedAddressBytes(path,bytes){
 const entry=receipt.files[path];if(!entry)return bytes;
 if(hash(bytes)===entry.beforeSha256||entry.priorApprovedPassthroughSha256.includes(hash(bytes)))return bytes;
 assert.equal(hash(bytes),entry.afterSha256,'Exact reviewed shared address composition required: '+path);
 assert.equal(bytes.toString(),entry.afterText,'Exact reviewed shared address postimage');
 assert.equal(hash(entry.beforeText),entry.beforeSha256,'Current main source must restore exactly');
 return Buffer.isBuffer(bytes)?Buffer.from(entry.beforeText):entry.beforeText;
}
