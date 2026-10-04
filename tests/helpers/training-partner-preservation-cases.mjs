import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {preservedTrainingPartnerPresentationBytes as preserve} from './training-partner-presentation-reviewed-delta.mjs';
const receipt=JSON.parse(readFileSync(new URL('../fixtures/training-partner-presentation-reviewed-delta.json',import.meta.url)));
for(const [path,e]of Object.entries(receipt.files)){
 const bytes=readFileSync(new URL('../../'+path,import.meta.url));
 test('Training presentation exact baseline restored: '+path,()=>{assert.equal(preserve(path,bytes).toString(),e.beforeText);assert.equal(preserve(path,e.beforeText),e.beforeText);});
 for(const [name,mutate]of [['append',s=>s+'UNREVIEWED'],['delete',s=>s.slice(1)],['duplicate',s=>s+s],['change',s=>'X'+s.slice(1)]])test('Training presentation rejects '+name+': '+path,()=>assert.throws(()=>preserve(path,mutate(bytes.toString()))));
}
