import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const receipt=JSON.parse(readFileSync(new URL('../fixtures/atlas-handoff-deadline-preservation.json',import.meta.url),'utf8'));
const cancellation=JSON.parse(readFileSync(new URL('../fixtures/callback-terminal-cancellation-preservation.json',import.meta.url),'utf8'));
// Keep immutable historical contracts; reverse only the explicit functional deadline repair.
export function reverseAtlasHandoffDeadline(source,file){
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
