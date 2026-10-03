import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const receipt=JSON.parse(readFileSync(new URL('../fixtures/atlas-handoff-deadline-preservation.json',import.meta.url),'utf8'));
// Keep immutable historical contracts; reverse only the explicit functional deadline repair.
export function reverseAtlasHandoffDeadline(source,file){
 const entry=receipt[file];if(!entry)return source;
 source=source.toString();
 for(const [before,after] of [...entry.replacements].reverse()){
  assert.equal(source.split(after).length,2,'Exactly one reviewed Atlas deadline change: '+file);
  source=source.replace(after,before);
 }
 return source;
}
