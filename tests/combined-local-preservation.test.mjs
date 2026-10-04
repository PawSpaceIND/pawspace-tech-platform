import './helpers/chat-ledger-preservation-cases.mjs';
import './helpers/chat-qualification-preservation-cases.mjs';
import {preservedChatQualificationBytes} from './helpers/chat-qualification-reviewed-delta.mjs';
import './helpers/grooming-auto-refusal-preservation-cases.mjs';
import './helpers/ci-historical-preservation-composition-cases.mjs';
import './helpers/ci-runtime-preservation-cases.mjs';
import {preservedCiRuntimeBytes} from './helpers/ci-runtime-reviewed-delta.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {preservedCombinedLocalBytes,preservedServiceLintBytes,preservedTrainingIntegratedBytes} from './helpers/combined-local-reviewed-delta.mjs';
const receipt=JSON.parse(readFileSync(new URL('./fixtures/combined-local-reviewed-delta.json',import.meta.url),'utf8'));
const correction=JSON.parse(readFileSync(new URL('./fixtures/service-fix-lint-correction.json',import.meta.url),'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
for(const[path,entry]of Object.entries(receipt.files))test('Exact reviewed source restoration rejects unrelated edits: '+path,()=>{
 const bytes=preservedTrainingIntegratedBytes(path,preservedCiRuntimeBytes(path,preservedChatQualificationBytes(path,readFileSync(new URL('../'+path,import.meta.url)))));assert.equal(hash(bytes),entry.afterSha256);
 const original=preservedCombinedLocalBytes(path,bytes);assert.equal(hash(original),entry.beforeSha256);
 assert.equal(preservedCombinedLocalBytes(path,original),original);
 for(const text of [bytes+'\nUNREVIEWED', 'X'+bytes.toString().slice(1),bytes.toString().slice(1),bytes.toString().replaceAll('\n','\r\n')])assert.throws(()=>preservedCombinedLocalBytes(path,Buffer.from(text)));
});
test('Grooming lint correction is exact, reversible and refuses mutations',()=>{
 const bytes=readFileSync(new URL('../'+correction.file,import.meta.url));assert.equal(hash(bytes),correction.afterSha256);
 const original=preservedServiceLintBytes(correction.file,bytes);assert.equal(hash(original),correction.beforeSha256);assert.equal(preservedServiceLintBytes(correction.file,original),original);
 for(const text of [bytes+'\nUNREVIEWED','X'+bytes.toString().slice(1),bytes.toString().slice(1),bytes.toString().replaceAll('\n','\r\n')])assert.throws(()=>preservedServiceLintBytes(correction.file,Buffer.from(text)));
});
test('Unrelated source retains identity',()=>{const bytes=Buffer.from('untouched');assert.equal(preservedCombinedLocalBytes('lib/unrelated.ts',bytes),bytes);assert.equal(preservedServiceLintBytes('lib/unrelated.ts',bytes),bytes);});
const training=JSON.parse(readFileSync(new URL('./fixtures/training-integrated-reviewed-delta.json',import.meta.url),'utf8'));
for(const[path,entry]of Object.entries(training.files))test('Exact integrated Training delta rejects unrelated edits: '+path,()=>{
 const bytes=readFileSync(new URL('../'+path,import.meta.url));assert.equal(hash(bytes),entry.afterSha256);
 const original=preservedTrainingIntegratedBytes(path,bytes);assert.equal(hash(original),entry.beforeSha256);assert.equal(preservedTrainingIntegratedBytes(path,original),original);
 for(const text of [bytes+'\nUNREVIEWED','X'+bytes.toString().slice(1),bytes.toString().slice(1),bytes.toString().replaceAll('\n','\r\n')])assert.throws(()=>preservedTrainingIntegratedBytes(path,Buffer.from(text)));
});

// Exercise the integrated product projection as well as exact source restoration.
const {projectTrainerSession}=await import('../lib/training-provider-projection.ts');
test('integrated handover projection retains operational proof and excludes raw contacts and staff notes',()=>{
 const input={id:'SESSION',owner_handover_minutes:15,owner_handover_completed_at:123,staff_notes:'Private staff detail',customer_email:'synthetic@example.test',customer_phone:'9100000000'};
 const completed=projectTrainerSession(input);assert.deepEqual(completed.ownerHandover,{durationMinutes:15,completedAt:123});
 for(const field of ['staff_notes','customer_email','customer_phone'])assert.equal(Object.hasOwn(completed,field),false);
 assert.equal(projectTrainerSession({...input,owner_handover_completed_at:null}).ownerHandover,null);
});
