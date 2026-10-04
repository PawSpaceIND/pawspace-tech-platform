import {preservedServiceAddressV8Bytes} from './service-address-v8-reviewed-delta.mjs';
import {preservedGroomingBackBarBytes} from './grooming-back-bar-reviewed-delta.mjs';
import {preservedChatLedgerBytes} from './chat-ledger-reviewed-delta.mjs';
import {preservedChatQualificationBytes} from './chat-qualification-reviewed-delta.mjs';
import {preservedCiRuntimeBytes} from './ci-runtime-reviewed-delta.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const receipt=JSON.parse(readFileSync(new URL('../fixtures/combined-local-reviewed-delta.json',import.meta.url),'utf8'));
const training=JSON.parse(readFileSync(new URL('../fixtures/training-integrated-reviewed-delta.json',import.meta.url),'utf8'));
const correction=JSON.parse(readFileSync(new URL('../fixtures/service-fix-lint-correction.json',import.meta.url),'utf8'));
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
// Composition only; historical fixtures and the existing owner helpers stay immutable.
// PR 1272: reverse only the exact reviewed verified-captured-retry gateway-link delta and its exact
// .gitleaksignore fingerprint append; every historical layer below then runs unchanged.
export function preservedCapturedRetryLinkBytes(path,bytes){return capturedRetry.files[path]?reverse(bytes,capturedRetry.files[path],path):bytes;}
export function preservedTrainingIntegratedBytes(path,bytes){
 bytes=preservedCapturedRetryLinkBytes(path,bytes);
 bytes=preservedServiceAddressV8Bytes(path,bytes);
 if(path==='e2e/v2-grooming.spec.ts'&&hash(bytes)==='16132dcb56b13354e8a060c5a5eefbe9c8d5bd8984f1b97ae5345bb539c968ca'){
  const prior=`  const review = page.getByRole("group", { name: "Current location", exact: true });\n  // The Google-capable picker has its own location action. Exercise the retained\n  // review/cancel path through its actual disclosure rather than that other button.\n  if (!await review.isVisible()) await page.getByText("Use device location instead", { exact: true }).click();`;
  const reviewed=`  const essentialOnly = page.getByRole("button", { name: "Essential Only" });\n  if (await essentialOnly.isVisible()) await essentialOnly.click();\n  const disclosure = page.locator("details").filter({ has: page.locator("summary", { hasText: "Use device location instead" }) });\n  if (await disclosure.getAttribute("open") === null) {\n    await disclosure.locator("summary").focus();\n    await disclosure.locator("summary").press("Enter");\n    await expect(disclosure).toHaveAttribute("open", "");\n  }\n  const review = page.getByRole("group", { name: "Current location", exact: true });\n  // The Google-capable picker has its own location action. Exercise the retained\n  // review/cancel path through its actual disclosure rather than that other button.`;
  const text=bytes.toString();assert.equal(text.split(reviewed).length,2,'Unique reviewed location test repair');
  const out=text.replace(reviewed,prior);assert.equal(hash(out),'72106356e17dd30c32a66a6d498d7b9fbc4f678e1185a058bf46a0f08f8e784c');
  bytes=Buffer.isBuffer(bytes)?Buffer.from(out):out;
 }
 return training.files[path]?reverse(bytes,training.files[path],path):bytes;
}
export function preservedCombinedLocalBytes(path,bytes){bytes=preservedGroomingBackBarBytes(path,bytes);bytes=preservedCiRuntimeBytes(path,preservedChatQualificationBytes(path,preservedChatLedgerBytes(path,bytes)));if(receipt.files[path]&&hash(bytes)===receipt.files[path].beforeSha256)return bytes;bytes=preservedTrainingIntegratedBytes(path,bytes);return receipt.files[path]?reverse(bytes,receipt.files[path],path):bytes;}
export function preservedServiceLintBytes(path,bytes){
 if(path!==correction.file)return bytes;
 // PR 1266: a controlled <details open> prop reclosed the add-on picker during
 // async quote rerenders in mobile WebKit. Reverse only this reviewed one-line fix
 // before the already pinned service and lint reversals.
 if(hash(bytes)==='c31566fd2ccd6579f3f635971b5d6bc4895fc47f4f9aed157e83c81162d14fb4'){
  const after='<details className={styles.addOnPicker}>';
  const before='<details className={styles.addOnPicker} open={chosenAddOns.length > 0}>';
  const text=bytes.toString();assert.equal(text.split(after).length,2,'Unique reviewed add-on disclosure');
  const prior=text.replace(after,before);
  assert.equal(hash(prior),correction.afterSha256,'Exact pre-disclosure Grooming source restored');
  bytes=Buffer.isBuffer(bytes)?Buffer.from(prior):prior;
 }
 return reverse(bytes,correction,path);
}
