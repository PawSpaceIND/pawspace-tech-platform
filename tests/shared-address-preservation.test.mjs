import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {preservedSharedAddressBytes} from './helpers/shared-address-reviewed-delta.mjs';
import {freezeServiceAddressSelection,withServiceAddress,doorstepSaveBody} from '../lib/service-address-selection.ts';
const receipt=JSON.parse(readFileSync(new URL('./fixtures/shared-address-reviewed-delta.json',import.meta.url)));
const hash=b=>createHash('sha256').update(b).digest('hex');
test('preserved caller contract executes one frozen address across reservation and doorstep after form edits',()=>{
 const form={customerId:'TEST-CUSTOMER',address:'12 Approved Test Street',pincode:'560034',window:{start:'2026-10-06T04:30:00Z',end:'2026-10-06T06:30:00Z'}};
 const chosen=freezeServiceAddressSelection(form);
 form.address='99 Different Test Street';form.pincode='560001';form.window.start='2026-10-07T04:30:00Z';
 const reservation=withServiceAddress({action:'reserve',requestId:'TEST-REQUEST'},chosen);
 const save=doorstepSaveBody(chosen,'TEST-BOOKING');
 assert.equal(reservation.serviceAddress,'12 Approved Test Street');assert.equal(reservation.servicePincode,'560034');
 assert.equal(save.address,reservation.serviceAddress);assert.equal(save.pincode,reservation.servicePincode);
 assert.equal(chosen.window.start,'2026-10-06T04:30:00Z');
 assert.throws(()=>freezeServiceAddressSelection({...form,pincode:'560 034'}),/six digits only/);
});
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
