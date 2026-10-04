import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const receipt=JSON.parse(readFileSync(new URL('../fixtures/grooming-back-bar-reviewed-delta.json',import.meta.url),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function preservedGroomingBackBarBytes(path,bytes){
 if(path!==receipt.file||[receipt.beforeSha256,receipt.historicalSha256].includes(hash(bytes)))return bytes;
 assert.equal(hash(bytes),receipt.afterSha256,'Exact reviewed Grooming back-bar CSS required');
 const text=bytes.toString();
 assert.equal(text.split(receipt.append).length,2,'Unique reviewed back-bar append required');
 assert.ok(text.endsWith(receipt.append),'Reviewed back-bar append must remain terminal');
 const out=text.slice(0,-receipt.append.length);
 assert.equal(hash(out),receipt.beforeSha256,'Exact immutable 7e Grooming CSS restored');
 return Buffer.isBuffer(bytes)?Buffer.from(out):out;
}
