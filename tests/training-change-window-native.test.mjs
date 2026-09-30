import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {freshWorld,seedBooking,TRAINER} from './helpers/training-lifecycle-harness.mjs';
const {materializeTrainingProgramme}=await import('../lib/training-programme.ts');
const {mutateTrainingSession}=await import('../lib/training-session-lifecycle.ts');

async function fixture(t){
 const seed=freshWorld();t.after(()=>seed.sqlite.close());seedBooking(seed,{id:'NATIVE-WINDOW',group:'NATIVE-WINDOW-G',sessions:2});
 const {sessions}=await materializeTrainingProgramme(seed.db,{bookingId:'NATIVE-WINDOW',actorId:'qa'});
 const mf=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',modules:true,script:"export default {fetch(){return new Response('isolated Training change-window test')}}",compatibilityDate:'2026-09-01',d1Databases:{DB:'training-change-window-test'},d1Persist:false,cf:false,outboundService:async()=>{throw new Error('Training change-window proof forbids external requests');}}));
 t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
 // Copy only this synthetic fixture's real schema and rows; every mutation below uses native D1.
 const tables=seed.sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
 for(const table of tables)await db.prepare(table.sql).run();
 for(const table of tables){const rows=seed.sqlite.prepare(`SELECT * FROM "${table.name}"`).all();for(const row of rows){const keys=Object.keys(row);await db.prepare(`INSERT INTO "${table.name}" (${keys.map(k=>`"${k}"`).join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).bind(...Object.values(row)).run();}}
 const session=sessions[0];const request=(database,key)=>mutateTrainingSession(database,{sessionId:session.id,action:'request_reschedule',actorId:TRAINER,idempotencyKey:key,reason:'Synthetic customer request for another time',customerReschedule:true});
 return{db,session,request};
}

test('native local D1 refuses past/invalid Training dates and accepts one future request exactly once',{timeout:60000},async t=>{
 const f=await fixture(t);
 for(const [key,start] of [['past',new Date(Date.now()-3600000).toISOString()],['invalid','not-a-date']]){
  await f.db.prepare('UPDATE training_sessions SET scheduled_start=? WHERE id=?').bind(start,f.session.id).run();
  let error;try{await f.request(f.db,key);}catch(e){error=e;}assert.ok(error instanceof Response);assert.equal(error.status,409);
 }
 await f.db.prepare('UPDATE training_sessions SET scheduled_start=? WHERE id=?').bind(new Date(Date.now()+48*3600000).toISOString(),f.session.id).run();
 const done=await f.request(f.db,'future');assert.equal(done.status,'reschedule_requested');assert.equal((await f.request(f.db,'future')).duplicatePrevented,true);
 assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM training_session_recovery_cases').first()).n,1);
 assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM training_session_events WHERE event_type='request_reschedule'").first()).n,1);
});

test('native local D1 rolls back a customer reschedule when the start changes immediately before its batch',{timeout:60000},async t=>{
 const f=await fixture(t);let injected=false;
 const sqlByStatement=new WeakMap();
 const prepare=sql=>{const raw=f.db.prepare(sql);const wrap=statement=>new Proxy(statement,{get(target,key){if(key==='bind')return(...args)=>{const bound=target.bind(...args);sqlByStatement.set(bound,sql);return bound;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});sqlByStatement.set(raw,sql);return wrap(raw);};
 const transport={prepare,batch:async statements=>{
  if(!injected&&statements.some(s=>sqlByStatement.get(s)?.startsWith("UPDATE training_sessions SET status='reschedule_requested'"))){injected=true;await f.db.prepare('UPDATE training_sessions SET scheduled_start=? WHERE id=?').bind(new Date(Date.now()+3600000).toISOString(),f.session.id).run();}
  return f.db.batch(statements);
 }};
 let error;try{await f.request(transport,'race');}catch(e){error=e;}assert.equal(injected,true);assert.ok(error instanceof Response);assert.equal(error.status,409);
 assert.equal((await f.db.prepare('SELECT status FROM training_sessions WHERE id=?').bind(f.session.id).first()).status,'scheduled');
 assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM training_session_recovery_cases').first()).n,0);
 assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM training_session_events WHERE event_type='request_reschedule'").first()).n,0);
});
