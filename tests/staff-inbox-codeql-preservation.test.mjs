import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {preservedStaffInboxCodeqlBytes} from './helpers/staff-inbox-codeql-reviewed-delta.mjs';
const r=JSON.parse(readFileSync(new URL('./fixtures/staff-inbox-codeql-reviewed-delta.json',import.meta.url)));
const hash=b=>createHash('sha256').update(b).digest('hex');
for(const[p,e]of Object.entries(r.files)){
 test('accepted CodeQL correction restores exact prior bytes: '+p,()=>{
  const b=readFileSync(new URL('../'+p,import.meta.url));assert.equal(hash(b),e.afterSha256);assert.equal(hash(preservedStaffInboxCodeqlBytes(p,b)),e.beforeSha256);
 });
 test('unreviewed CodeQL correction mutation refuses: '+p,()=>{
  const b=readFileSync(new URL('../'+p,import.meta.url));assert.throws(()=>preservedStaffInboxCodeqlBytes(p,Buffer.concat([b,Buffer.from('\n/* mutation */\n')])),/Exact accepted staff inbox CodeQL correction required/);
 });
}
