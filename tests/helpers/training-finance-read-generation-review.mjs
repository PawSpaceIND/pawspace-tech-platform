import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const receipt=JSON.parse(readFileSync(new URL('../fixtures/training-finance-read-generation-preservation.json',import.meta.url),'utf8'));
// Reverse exactly the reviewed functional repair before historical UI preservation checks.
export function reverseTrainingReadGeneration(source,file){
 if(file!==receipt.file)return source;
 for(const [before,after] of [...receipt.replacements].reverse()){
  assert.equal(source.split(after).length,2,'Exactly one reviewed Training read-generation change');
  source=source.replace(after,before);
 }
 return source;
}
