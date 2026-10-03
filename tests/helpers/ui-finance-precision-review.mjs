import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const receipt=JSON.parse(readFileSync(new URL('../fixtures/ui-finance-precision-next-preservation.json',import.meta.url),'utf8'));
export function reverseFinancePrecision(source,file){
 const item=receipt.files.find(row=>row.file===file);if(!item)return source;
 assert.equal(source.split(item.after).length,2,'Exactly one reviewed currency formatter');
 return source.replace(item.after,item.before);
}
