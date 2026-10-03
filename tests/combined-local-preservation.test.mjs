import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {preservedCombinedLocalBytes,preservedServiceLintBytes} from './helpers/combined-local-reviewed-delta.mjs';
const receipt=JSON.parse(readFileSync(new URL('./fixtures/combined-local-reviewed-delta.json',import.meta.url),'utf8'));
const correction=JSON.parse(readFileSync(new URL('./fixtures/service-fix-lint-correction.json',import.meta.url),'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
for(const[path,entry]of Object.entries(receipt.files))test('Exact reviewed source restoration rejects unrelated edits: '+path,()=>{
 const bytes=readFileSync(new URL('../'+path,import.meta.url));assert.equal(hash(bytes),entry.afterSha256);
 const original=preservedCombinedLocalBytes(path,bytes);assert.equal(hash(original),entry.beforeSha256);
 assert.equal(preservedCombinedLocalBytes(path,original),original);
 for(const text of [bytes+'\nUNREVIEWED', 'X'+bytes.toString().slice(1),bytes.toString().slice(1),bytes.toString().replace('\n','\r\n')])assert.throws(()=>preservedCombinedLocalBytes(path,Buffer.from(text)));
});
test('Grooming lint correction is exact, reversible and refuses mutations',()=>{
 const bytes=readFileSync(new URL('../'+correction.file,import.meta.url));assert.equal(hash(bytes),correction.afterSha256);
 const original=preservedServiceLintBytes(correction.file,bytes);assert.equal(hash(original),correction.beforeSha256);assert.equal(preservedServiceLintBytes(correction.file,original),original);
 for(const text of [bytes+'\nUNREVIEWED','X'+bytes.toString().slice(1),bytes.toString().slice(1),bytes.toString().replace('\n','\r\n')])assert.throws(()=>preservedServiceLintBytes(correction.file,Buffer.from(text)));
});
test('Unrelated source retains identity',()=>{const bytes=Buffer.from('untouched');assert.equal(preservedCombinedLocalBytes('lib/unrelated.ts',bytes),bytes);assert.equal(preservedServiceLintBytes('lib/unrelated.ts',bytes),bytes);});
