import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {preservedSharedAddressBytes} from './helpers/shared-address-reviewed-delta.mjs';
const receipt=JSON.parse(readFileSync(new URL('./fixtures/shared-address-reviewed-delta.json',import.meta.url)));
const hash=b=>createHash('sha256').update(b).digest('hex');
for(const [path,entry] of Object.entries(receipt.files)){
 test('composed address source restores exact current-main bytes: '+path,()=>{
  const source=readFileSync(new URL('../'+path,import.meta.url));
  assert.equal(hash(source),entry.afterSha256);
  assert.equal(hash(preservedSharedAddressBytes(path,source)),entry.beforeSha256);
 });
 test('unreviewed address source mutation cannot pass historical pins: '+path,()=>{
  const source=readFileSync(new URL('../'+path,import.meta.url));
  assert.throws(()=>preservedSharedAddressBytes(path,Buffer.concat([source,Buffer.from('\n/* unreviewed mutation */\n')])),/Exact reviewed shared address composition required/);
 });
}
