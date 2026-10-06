import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
// PR 1272: the exact reviewed verified-captured-retry gateway-link delta and its exact .gitleaksignore append.
// Kept in its own module so the accepted-UI layer can reverse the .gitleaksignore append before its own
// exact check, without an import cycle through combined-local-reviewed-delta.mjs.
const capturedRetry=JSON.parse(readFileSync(new URL('../fixtures/gateway-link-captured-retry-reviewed-delta.json',import.meta.url),'utf8'));
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
export function preservedCapturedRetryLinkBytes(path,bytes){return capturedRetry.files[path]?reverse(bytes,capturedRetry.files[path],path):bytes;}
// Hash-guarded entry for layers that may also see already-restored bytes: reverses only the exact reviewed
// after-state; any other input is returned unchanged for the caller's own exact check to accept or refuse.
export function preservedExactCapturedRetryLinkBytes(path,bytes){const e=capturedRetry.files[path];return e&&hash(bytes.toString())===e.afterSha256?reverse(bytes,e,path):bytes;}
