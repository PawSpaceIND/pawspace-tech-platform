import {reverseSittingRowSelection} from './sitting-finance-row-selection-review.mjs';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const receipt=JSON.parse(readFileSync(new URL('../fixtures/ui-sitting-target-safety-preservation.json',import.meta.url),'utf8'));
// Reverse only the frozen Sitting identity repair; all historical UI hashes remain pinned.
export function reverseSittingTargetSafety(source,file){
 if(file!==receipt.file)return source;
 source=reverseSittingRowSelection(source,file);
 for(const [before,after] of [...receipt.replacements].reverse()){
  assert.equal(source.split(after).length,2,'Exactly one reviewed Sitting target-safety change');
  source=source.replace(after,before);
 }
 return source;
}
