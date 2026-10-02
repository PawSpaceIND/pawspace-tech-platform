import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const {reversals}=JSON.parse(readFileSync(new URL('../fixtures/guest-continuity-preservation.json',import.meta.url),'utf8'));
export function reverseGuestContinuity(source,file){
 for(const [before,after]of [...(reversals[file]||[])].reverse()){assert.equal(source.split(after).length,2,'Exactly one reviewed guest continuity change');source=source.replace(after,before);}
 return source;
}
