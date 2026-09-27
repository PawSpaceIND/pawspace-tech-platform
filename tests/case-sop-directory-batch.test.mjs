import test from 'node:test';
import assert from 'node:assert/strict';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__CASE_SOP_DB__','__CASE_SOP_ENV__');
const {listCaseSopRequirementsForCases}=await import('../lib/case-sop-governance.ts');

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

test('repeat SOP sync has bounded reads, no duplicate writes, and still materializes new module versions',async()=>{
 const{freshSqlite,makeD1}=await import('./helpers/voice-harness.mjs');const sqlite=freshSqlite();
 sqlite.exec(`CREATE TABLE unified_cases(id TEXT PRIMARY KEY,case_type TEXT,status TEXT,booking_id TEXT,service_code TEXT,provider_id TEXT,created_at INTEGER);
 CREATE TABLE canonical_bookings(id TEXT PRIMARY KEY,service_code TEXT,provider_id TEXT);
 CREATE TABLE lms_modules(id TEXT PRIMARY KEY,title TEXT,service_code TEXT,version INTEGER,status TEXT,required INTEGER,created_at INTEGER);
 CREATE TABLE unified_case_events(id TEXT PRIMARY KEY,idempotency_key TEXT UNIQUE,case_id TEXT,event_type TEXT,actor_id TEXT,detail_json TEXT,created_at INTEGER);
 INSERT INTO lms_modules VALUES('safety','Safe care','grooming',1,'published',1,1);`);
 for(let i=0;i<100;i++){sqlite.prepare('INSERT INTO canonical_bookings VALUES(?,?,?)').run(`b${i}`,'grooming','provider');sqlite.prepare('INSERT INTO unified_cases VALUES(?,?,?,?,?,?,?)').run(`c${i}`,'operations','open',`b${i}`,null,null,i);}
 const base=makeD1(sqlite);let reads=0,writes=0;const db={...base,prepare(sql){if(sql.startsWith('SELECT'))reads++;if(sql.startsWith('INSERT'))writes++;return base.prepare(sql);}};
 const{syncCaseSopRequirements}=await import('../lib/case-sop-governance.ts');
 assert.equal((await syncCaseSopRequirements(db,{actorId:'qa'})).created,100);
 reads=0;writes=0;assert.equal((await syncCaseSopRequirements(db,{actorId:'qa'})).created,0);
 assert.ok(reads<15,`read count ${reads}`);assert.equal(writes,0);
 sqlite.exec("UPDATE lms_modules SET version=2");assert.equal((await syncCaseSopRequirements(db,{actorId:'qa'})).created,100);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM unified_case_sop_requirements').get().n,200);
});
