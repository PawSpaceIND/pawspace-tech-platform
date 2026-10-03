import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const receipt=JSON.parse(readFileSync(new URL('../fixtures/sitting-finance-touch-preservation.json',import.meta.url),'utf8'));
export function reverseSittingTouch(source,file){
 if(file!==receipt.file)return source;
 for(const [before,after] of [...receipt.replacements].reverse()){
  assert.equal(source.split(after).length,2,'Exactly one reviewed Sitting touch presentation change');
  source=source.replace(after,before);
 }
 return source;
}
