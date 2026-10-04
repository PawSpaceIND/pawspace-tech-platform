import {preservedChatLedgerBytes} from './chat-ledger-reviewed-delta.mjs';
import {preservedChatQualificationBytes} from './chat-qualification-reviewed-delta.mjs';
import {preservedCiRuntimeBytes} from './ci-runtime-reviewed-delta.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const receipt=JSON.parse(readFileSync(new URL('../fixtures/combined-local-reviewed-delta.json',import.meta.url),'utf8'));
const training=JSON.parse(readFileSync(new URL('../fixtures/training-integrated-reviewed-delta.json',import.meta.url),'utf8'));
const correction=JSON.parse(readFileSync(new URL('../fixtures/service-fix-lint-correction.json',import.meta.url),'utf8'));
const hash=s=>createHash('sha256').update(s).digest('hex');
function reverse(source,entry,path){
 const text=source.toString();if(hash(text)===entry.beforeSha256)return source;
 assert.equal(hash(text),entry.afterSha256,'Exact reviewed local source required: '+path);
 let out=text;for(const[before,after]of [...entry.replacements].reverse()){
  assert.equal(out.split(after).length,2,'Unique reviewed local replacement: '+path);out=out.replace(after,()=>before);
 }
 assert.equal(hash(out),entry.beforeSha256,'Exact original local source restored: '+path);
 return Buffer.isBuffer(source)?Buffer.from(out):out;
}
// Composition only; historical fixtures and the existing owner helpers stay immutable.
export function preservedTrainingIntegratedBytes(path,bytes){return training.files[path]?reverse(bytes,training.files[path],path):bytes;}
export function preservedCombinedLocalBytes(path,bytes){bytes=preservedCiRuntimeBytes(path,preservedChatQualificationBytes(path,preservedChatLedgerBytes(path,bytes)));if(receipt.files[path]&&hash(bytes)===receipt.files[path].beforeSha256)return bytes;bytes=preservedTrainingIntegratedBytes(path,bytes);return receipt.files[path]?reverse(bytes,receipt.files[path],path):bytes;}
export function preservedServiceLintBytes(path,bytes){return path===correction.file?reverse(bytes,correction,path):bytes;}
