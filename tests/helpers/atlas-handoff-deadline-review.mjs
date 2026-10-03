import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const chatReceipt=JSON.parse(readFileSync(new URL('../fixtures/reviewed-three-chat-preservation.json',import.meta.url),'utf8'));
const receipt=JSON.parse(readFileSync(new URL('../fixtures/atlas-handoff-deadline-preservation.json',import.meta.url),'utf8'));
// Keep immutable historical contracts; reverse only the explicit functional deadline repair.
export function reverseReviewedThreeChat(source,file){
 const chat=chatReceipt[file];
 if(chat){source=source.toString();for(const[before,after]of [...chat.replacements].reverse()){assert.equal(source.split(after).length,2,'Exactly one reviewed three-chat change: '+file);source=source.replace(after,before);}}
 return source;
}
export function reverseAtlasHandoffDeadline(source,file){
 source=reverseReviewedThreeChat(source,file);
 const entry=receipt[file];if(!entry)return source;
 source=source.toString();
 for(const [before,after] of [...entry.replacements].reverse()){
  assert.equal(source.split(after).length,2,'Exactly one reviewed Atlas deadline change: '+file);
  source=source.replace(after,before);
 }
 return source;
}
