import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {uiBehaviorSignatures} from './ui-audit-event-contract.mjs';
import {uiProgramContract,uiJsxExpressions} from './ui-audit-logic-contract.mjs';
export const UI_AUDIT_BASE='89d483d971b1ca1ceeaeb96bbff91898168081f2';

/** Verify recorded originals against immutable historical source, not the current implementation. */
export function verifyHistoricalUiContracts(events,programs,readSource) {
 assert.equal(events.base,UI_AUDIT_BASE,'Event history must retain the pinned audit revision.');
 assert.equal(programs.base,UI_AUDIT_BASE,'Program history must retain the pinned audit revision.');
 const sorted=object=>Object.keys(object).sort();
 assert.deepEqual(sorted(programs.jsxOriginal),sorted(programs.files),'Every program needs a historical JSX record.');
 const files=[...new Set([...sorted(events.files),...sorted(programs.files)])];
 for(const file of files) {
  assert.ok(file.startsWith('app/')&&!file.split('/').includes('..'),'History paths must be application sources.');
  const source=readSource(UI_AUDIT_BASE,file);
  if(events.files[file])assert.deepEqual(uiBehaviorSignatures(source,file),events.files[file],file+' historical events');
  if(programs.files[file]) {
   assert.equal(uiProgramContract(source,file),programs.files[file],file+' historical program');
   assert.deepEqual(uiJsxExpressions(source,file),programs.jsxOriginal[file],file+' historical JSX');
  }
 }
 return files.length;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const root=fileURLToPath(new URL('../',import.meta.url));
 const fixture=name=>JSON.parse(fs.readFileSync(resolve(root,'tests/fixtures',name),'utf8'));
 const count=verifyHistoricalUiContracts(fixture('ui-audit-event-contract.json'),fixture('ui-audit-logic-contract.json'),
  (base,file)=>execFileSync('git',['show',`${base}:${file}`],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024}));
 console.log(`Verified ${count} UI source histories against pinned commit ${UI_AUDIT_BASE}.`);
}
