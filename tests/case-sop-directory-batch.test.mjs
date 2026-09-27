import test from 'node:test';
import assert from 'node:assert/strict';
import {listCaseSopRequirementsForCases} from '../lib/case-sop-governance.ts';

test('500-case directory uses bounded D1 binds and preserves requirement ownership',async()=>{
 const reads=[];let schemaBatches=0;
 const db={batch:async()=>{schemaBatches++;},prepare(sql){return {bind(...ids){assert.ok(ids.length<=80);return {async all(){reads.push(ids);return {results:ids.map(id=>({id:`sop-${id}`,case_id:id,status:'pending'}))};}};}};}};
 const ids=Array.from({length:500},(_,i)=>`case-${i}`);
 const grouped=await listCaseSopRequirementsForCases(db,[...ids,ids[0]]);
 assert.equal(schemaBatches,1);assert.equal(reads.length,7);assert.equal(grouped.size,500);
 for(const id of ids)assert.deepEqual(grouped.get(id),[{id:`sop-${id}`,case_id:id,status:'pending'}]);
});

test('empty case directory makes no invalid IN query',async()=>{
 let queries=0;const db={batch:async()=>{},prepare(){return {bind(){queries++;throw new Error('Unexpected query');}};}};
 assert.equal((await listCaseSopRequirementsForCases(db,[])).size,0);assert.equal(queries,0);
});
