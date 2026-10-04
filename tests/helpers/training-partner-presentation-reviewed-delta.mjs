import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const receipt=JSON.parse(readFileSync(new URL('../fixtures/training-partner-presentation-reviewed-delta.json',import.meta.url)));
const hash=value=>createHash('sha256').update(value).digest('hex');
export function preservedTrainingPartnerPresentationBytes(path,bytes){
 const entry=receipt.files[path];if(!entry)return bytes;
 if(hash(bytes)===entry.beforeSha256||entry.historicalPassthroughSha256.includes(hash(bytes)))return bytes;
 assert.equal(hash(bytes),entry.afterSha256,'Exact reviewed Training presentation required: '+path);
 assert.equal(bytes.toString(),entry.afterText,'Exact Training postimage');
 assert.equal(hash(entry.beforeText),entry.beforeSha256,'Exact Training baseline');
 return Buffer.isBuffer(bytes)?Buffer.from(entry.beforeText):entry.beforeText;
}
