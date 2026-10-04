import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {preservedServiceAddressV8Bytes} from './helpers/service-address-v8-reviewed-delta.mjs';
const receipt=JSON.parse(readFileSync(new URL('./fixtures/service-address-v8-reviewed-delta.json',import.meta.url),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const [path,entry] of Object.entries(receipt.files))test('v8 exact restoration and mutation refusal: '+path,()=>{
 const bytes=readFileSync(new URL('../'+path,import.meta.url));assert.equal(hash(bytes),entry.afterSha256);
 const before=preservedServiceAddressV8Bytes(path,bytes);assert.equal(hash(before),entry.beforeSha256);assert.equal(preservedServiceAddressV8Bytes(path,before),before);
 for(const mutated of [Buffer.concat([bytes,Buffer.from('\nUNREVIEWED')]),Buffer.from('X'+bytes.toString().slice(1)),bytes.subarray(1),Buffer.from(bytes.toString().replaceAll('\n','\r\n'))])assert.throws(()=>preservedServiceAddressV8Bytes(path,mutated));
 for(const [old,replacement] of entry.replacements){assert.equal(bytes.toString().split(replacement).length,2);assert.throws(()=>preservedServiceAddressV8Bytes(path,Buffer.from(bytes.toString().replace(replacement,replacement+'/* UNREVIEWED */'))));}
});
test('v8 preservation leaves unrelated files untouched',()=>{const bytes=Buffer.from('unchanged');assert.equal(preservedServiceAddressV8Bytes('lib/unrelated.ts',bytes),bytes);});
