import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const coinsGateway=JSON.parse(readFileSync(new URL('../fixtures/customer-coins-gateway-preservation.json',import.meta.url),'utf8'));
const chatCorrections=JSON.parse(readFileSync(new URL('../fixtures/chat-pr1265-correction-preservation.json',import.meta.url),'utf8'));
const chatReceipt=JSON.parse(readFileSync(new URL('../fixtures/reviewed-three-chat-preservation.json',import.meta.url),'utf8'));
const receipt=JSON.parse(readFileSync(new URL('../fixtures/atlas-handoff-deadline-preservation.json',import.meta.url),'utf8'));
const cancellation=JSON.parse(readFileSync(new URL('../fixtures/callback-terminal-cancellation-preservation.json',import.meta.url),'utf8'));
// Keep immutable historical contracts; reverse only the explicit functional deadline repair.
export function reversePr1265Correction(source,file){
 source=reverseCoinsGatewayCorrection(source,file);
 const correction=chatCorrections.find(entry=>entry.file===file);
 if(correction){
  source=source.toString();const hash=value=>createHash('sha256').update(value).digest('hex');
  if(hash(source)!==correction.beforeSha256){
   assert.equal(hash(source),correction.afterSha256,'Exact reviewed PR1265 correction: '+file);
   for(const[before,after]of [...correction.replacements].reverse()){assert.equal(source.split(after).length,2,'Exactly one reviewed PR1265 correction: '+file);source=source.replace(after,before);}
   assert.equal(hash(source),correction.beforeSha256,'Immutable prior chat source: '+file);
  }
 }
 return source;
}
export function reverseCoinsGatewayCorrection(source,file){
 if(file===coinsGateway.file){
  source=source.toString();const hash=value=>createHash('sha256').update(value).digest('hex');
  if(hash(source)!==coinsGateway.beforeSha256){
   for(const[before,after]of [...coinsGateway.replacements].reverse()){
    assert.equal(source.split(after).length,2,'Exactly one reviewed coins gateway correction');
    source=source.replace(after,before);
   }
  }
 }
 return source;
}
export function reverseReviewedThreeChat(source,file){
 source=reversePr1265Correction(source,file);
 const chat=chatReceipt[file];
 if(chat){source=source.toString();for(const[before,after]of [...chat.replacements].reverse()){assert.equal(source.split(after).length,2,'Exactly one reviewed three-chat change: '+file);source=source.replace(after,before);}}
 return source;
}
export function reverseAtlasHandoffDeadline(source,file){
 source=reverseReviewedThreeChat(source,file);
 if(file===cancellation.file){
  source=source.toString();
  const digest=value=>createHash('sha256').update(value).digest('hex');
  if(digest(source)!==cancellation.beforeSha256){
   assert.equal(digest(source),cancellation.afterSha256,'Exact reviewed callback cancellation source');
   for(const [before,after] of [...cancellation.replacements].reverse()){
    assert.equal(source.split(after).length,2,'Exactly one reviewed callback cancellation change');
    source=source.replace(after,before);
   }
   assert.equal(digest(source),cancellation.beforeSha256,'Immutable pre-cancellation source');
  }
 }
 const entry=receipt[file];if(!entry)return source;
 source=source.toString();
 for(const [before,after] of [...entry.replacements].reverse()){
  assert.equal(source.split(after).length,2,'Exactly one reviewed Atlas deadline change: '+file);
  source=source.replace(after,before);
 }
 return source;
}
