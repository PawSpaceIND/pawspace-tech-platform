import {preservedBrandStyleBytes} from './helpers/approved-brand-style.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import postcss from 'postcss';
import {staffSemanticContract} from './helpers/staff-presentation-contract.mjs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const contract=JSON.parse(read('tests/fixtures/staff-operations-contract.json'));
for(const [path,expected] of Object.entries(contract.files))test('Operations UI preserves non-style source: '+path,()=>{
 assert.equal(staffSemanticContract(read(path),path),expected.semantic);
 assert.equal((read(path).match(/<StaffModule>/g)||[]).length,expected.mainRoots);
});
test('Training, gateway, partner, customer and business engines retain their baseline bytes',()=>{
 for(const [p,hash] of Object.entries(contract.protected))assert.equal(createHash('sha256').update(preservedBrandStyleBytes(p)).digest('hex'),hash,p);
});
test('Training recovery rules, prompts and mutations are not presentation changes',()=>{
 const p='app/team/operations/boarding/page.tsx',s=read(p),hash=staffSemanticContract(s,p);
 for(const [a,b] of [['idempotencyKey:','changedKey:'],['note.trim().length<5','note.trim().length<0'],['assign_replacement','force_assignment']]){
  assert.ok(s.includes(a));assert.notEqual(staffSemanticContract(s.replace(a,b),p),hash);
 }
});
test('Training CSS additions are opt-in and do not alter existing admin rules',()=>{
 const css=read('app/admin/admin.module.css'),marker='\n/* Opt-in staff Training presentation. Existing admin/customer rules above remain unchanged. */',markerIndex=css.indexOf(marker);
 assert.ok(markerIndex>0,'Training presentation marker must remain present');const before=css.slice(0,markerIndex),beforeHash=createHash('sha256').update(before).digest('hex');
 assert.equal(beforeHash,contract.adminCssPrefixHash);const added=css.slice(markerIndex),parsed=postcss.parse(added);
 parsed.walkRules(rule=>{assert.ok(rule.selector.includes(':global([data-staff-module])'),rule.selector);});
 assert.doesNotMatch(added,/display\s*:\s*none|visibility\s*:\s*hidden/);
 assert.match(added,/trainingMetrics article:nth-child\(n\) \{ display:flex/);
});

import {trainingOpsActionsForStatus} from '../lib/training-ops-actions.ts';
test('executed Training action policy keeps completed and unknown sessions non-actionable',()=>{
 for(const state of ['scheduled','accepted','reschedule_requested','on_the_way','arrived','completed','cancelled','no_show','unknown','']){
  const recovery=['scheduled','accepted','reschedule_requested'].includes(state);
  assert.deepEqual(trainingOpsActionsForStatus(state),{
   reschedule:recovery,replaceTrainer:recovery,
   noShow:['scheduled','accepted','on_the_way','arrived'].includes(state),cancel:recovery,
  },state);
 }
});
