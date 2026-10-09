import {preservedSecurityDependencyBytes} from './helpers/security-dependencies-reviewed-delta.mjs';
import {preservedServiceAddressV8Bytes} from './helpers/service-address-v8-reviewed-delta.mjs';
import './helpers/accepted-ui-test-correction-cases.mjs';
import {preservedAcceptedUiBytes} from './helpers/accepted-ui-reviewed-delta.mjs';
import './helpers/accepted-ui-preservation-cases.mjs';
import './helpers/ci-historical-preservation-composition-cases.mjs';
import {preservedGroomingBackBarBytes} from './helpers/grooming-back-bar-reviewed-delta.mjs';
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
// Admit only the exact reviewed fixture delta before immutable historical reversals.
const reviewedInput=path=>preservedSecurityDependencyBytes(path,readFileSync(new URL('../'+path,import.meta.url)));

for(const[path,entry]of Object.entries(receipt.files))test('Exact reviewed source restoration rejects unrelated edits: '+path,()=>{
 const bytes=preservedTrainingIntegratedBytes(path,preservedCiRuntimeBytes(path,preservedChatQualificationBytes(path,preservedAcceptedUiBytes(path,reviewedInput(path)))));assert.equal(hash(bytes),entry.afterSha256);
 const original=preservedCombinedLocalBytes(path,bytes);assert.equal(hash(original),entry.beforeSha256);
 assert.equal(preservedCombinedLocalBytes(path,original),original);
 for(const text of [bytes+'\nUNREVIEWED', 'X'+bytes.toString().slice(1),bytes.toString().slice(1),bytes.toString().replaceAll('\n','\r\n')])assert.throws(()=>preservedCombinedLocalBytes(path,Buffer.from(text)));
});
test('Grooming lint correction is exact, reversible and refuses mutations',()=>{
 const bytes=preservedAcceptedUiBytes(correction.file,readFileSync(new URL('../'+correction.file,import.meta.url)));assert.equal(hash(bytes),'c31566fd2ccd6579f3f635971b5d6bc4895fc47f4f9aed157e83c81162d14fb4');
 const original=preservedServiceLintBytes(correction.file,bytes);assert.equal(hash(original),correction.beforeSha256);assert.equal(preservedServiceLintBytes(correction.file,original),original);
 for(const text of [bytes+'\nUNREVIEWED','X'+bytes.toString().slice(1),bytes.toString().slice(1),bytes.toString().replaceAll('\n','\r\n')])assert.throws(()=>preservedServiceLintBytes(correction.file,Buffer.from(text)));
});
test('Unrelated source retains identity',()=>{const bytes=Buffer.from('untouched');assert.equal(preservedCombinedLocalBytes('lib/unrelated.ts',bytes),bytes);assert.equal(preservedServiceLintBytes('lib/unrelated.ts',bytes),bytes);});
const training=JSON.parse(readFileSync(new URL('./fixtures/training-integrated-reviewed-delta.json',import.meta.url),'utf8'));
for(const[path,entry]of Object.entries(training.files))test('Exact integrated Training delta rejects unrelated edits: '+path,()=>{
 const bytes=preservedAcceptedUiBytes(path,preservedServiceAddressV8Bytes(path,reviewedInput(path)));assert.equal(hash(bytes),entry.afterSha256);
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

const backBar=JSON.parse(readFileSync(new URL('./fixtures/grooming-back-bar-reviewed-delta.json',import.meta.url),'utf8'));
test('Grooming back-bar CSS restores exact 7e bytes and rejects unrelated mutations',()=>{
 const path=backBar.file,bytes=preservedAcceptedUiBytes(path,reviewedInput(path));
 assert.equal(hash(bytes),backBar.afterSha256);
 const original=preservedGroomingBackBarBytes(path,bytes);
 assert.equal(hash(original),backBar.beforeSha256);
 assert.equal(preservedGroomingBackBarBytes(path,original),original);
 const service=JSON.parse(readFileSync(new URL('./fixtures/service-fix-reviewed-delta.json',import.meta.url),'utf8'));
 assert.equal(backBar.beforeSha256,service.files[path].reviewedHash);
 assert.equal(backBar.historicalSha256,service.files[path].originalHash);
 assert.equal(preservedGroomingBackBarBytes('unrelated',bytes),bytes);
 for(const changed of [bytes+'\nUNREVIEWED',bytes.toString().replace('min-height:60px','min-height:44px'),bytes.toString().replace(backBar.append,backBar.append+backBar.append),bytes.toString().replace(backBar.append,backBar.append.trim()),bytes.toString().replaceAll('\n','\r\n'),'X'+bytes.toString().slice(1)])assert.throws(()=>preservedGroomingBackBarBytes(path,Buffer.from(changed)));
});


test('Exact native add-on pointer retry restores history and rejects assertion mutations',()=>{
 const path='e2e/v2-grooming.spec.ts',bytes=reviewedInput(path);
 assert.equal(hash(bytes),'766d969cf0ea06c1790cd788bbcbcfb052030fb41333784e4578c4c8cdba5230');
 assert.equal(hash(preservedTrainingIntegratedBytes(path,bytes)),'72106356e17dd30c32a66a6d498d7b9fbc4f678e1185a058bf46a0f08f8e784c');
 const original=preservedCombinedLocalBytes(path,bytes);
 assert.equal(hash(original),'1c91a9503698107ea2064a7a8dd5292563fb35463817b403f5f7184c76606498');
 assert.equal(preservedCombinedLocalBytes(path,original),original);
 assert.equal(preservedTrainingIntegratedBytes('unrelated',bytes),bytes);
 const text=bytes.toString();
 const pairs=[['timeout: 2_000','timeout: 20_000'],['disclosure.locator("summary").click();','disclosure.locator("summary").click({ force: true });'],['toHaveAttribute("open", "", { timeout: 2_000 })','toHaveAttribute("open", "", { timeout: 20_000 })'],['await expect(checkbox).toBeChecked();','await checkbox.isChecked();'],['expect(state.bookingWrites).toBe(0)','expect(state.bookingWrites).toBeGreaterThanOrEqual(0)'],['SECOND','OTHER']];
 for(const [before,after] of pairs){assert.ok(text.includes(before),before);assert.throws(()=>preservedCombinedLocalBytes(path,Buffer.from(text.replace(before,after))));}
 for(const changed of [text+'\nUNREVIEWED','X'+text.slice(1),text.slice(1),text.replaceAll('\n','\r\n')])assert.throws(()=>preservedCombinedLocalBytes(path,Buffer.from(changed)));
});

test('Reviewed booking fixture delta rejects current-source assertion mutations',()=>{
 const path='e2e/v2-grooming.spec.ts',raw=readFileSync(new URL('../'+path,import.meta.url));
 assert.equal(hash(preservedSecurityDependencyBytes(path,raw)),'766d969cf0ea06c1790cd788bbcbcfb052030fb41333784e4578c4c8cdba5230');
 const text=raw.toString(),before='await expect(suggestion).toHaveCount(0);';
 assert.ok(text.includes(before));
 for(const changed of [text.replace(before,'await suggestion.isVisible();'),text+'\nUNREVIEWED','X'+text.slice(1),text.replaceAll('\n','\r\n')])assert.throws(()=>preservedSecurityDependencyBytes(path,Buffer.from(changed)));
});
