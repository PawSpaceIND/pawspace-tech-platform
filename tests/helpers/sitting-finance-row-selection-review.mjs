import {reverseSittingTouch} from './sitting-finance-touch-review.mjs';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const receipt=JSON.parse(readFileSync(new URL('../fixtures/sitting-finance-row-selection-preservation.json',import.meta.url),'utf8'));
export function reverseSittingRowSelection(source,file){
 if(file!==receipt.file)return source;
 source=reverseSittingTouch(source,file);
 for(const [before,after] of [...receipt.replacements].reverse()){
  assert.equal(source.split(after).length,2,'Exactly one reviewed Sitting row-selection change');
  source=source.replace(after,before);
 }
 return source;
}
