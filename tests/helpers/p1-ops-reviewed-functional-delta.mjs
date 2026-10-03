import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const contract=JSON.parse(readFileSync(new URL('../fixtures/p1-ops-reviewed-functional-delta.json',import.meta.url),'utf8'));
export function reverseReviewedP1Ops(source,file){
 const entry=contract.files[file];if(!entry)return source;
 assert.equal(createHash('sha256').update(source).digest('hex'),entry.reviewedHash,'Only the exact independently reviewed P1 Operations source is admitted');
 for(const [before,after] of [...entry.replacements].reverse()){assert.equal(source.split(after).length,2,'Exactly one reviewed functional delta');source=source.replace(after,before);}
 assert.equal(createHash('sha256').update(source).digest('hex'),entry.beforeHash,'Every original source byte remains after exact reviewed delta reversal');return source;
}
