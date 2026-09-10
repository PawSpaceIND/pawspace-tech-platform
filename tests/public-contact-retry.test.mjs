import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {installWorkersHooks,runWithWorkersDb} from './helpers/module-hooks.mjs';
installWorkersHooks('__CONTACT_RETRY_DB__','__CONTACT_RETRY_ENV__');
const route=await import('../app/api/public-contact/route.ts');
const owners=await import('../lib/lead-owner-identity.ts');
const assignment=await import('../lib/lead-assignment-governance.ts');
const sample={name:'Synthetic Walking Lead',phone:'9000000882',email:'contact-retry@example.test',area:'Bengaluru',service:'Dog Walking',message:'Local audit only',whatsappConsent:false,requestId:'6b249c1e-7a09-4d3a-93b6-761b2f551afd'};
function world(){
 const sqlite=new DatabaseSync(':memory:');let fault='';
 const statement=(sql,args=[])=>({sql,args,bind:(...values)=>statement(sql,values),first:async()=>sqlite.prepare(sql).get(...args)??null,all:async()=>({results:sqlite.prepare(sql).all(...args)}),run:async()=>execute(sql,args)});
 const execute=(sql,args)=>{if(fault&&sql.includes(fault))throw new Error('Injected database write failure');const r=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(r.changes),rows_written:Number(r.changes)}};};
 const db={prepare:sql=>statement(sql),batch:async items=>{sqlite.exec('BEGIN');try{const results=items.map(s=>execute(s.sql,s.args));sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}},exec:async sql=>sqlite.exec(sql)};
 const count=table=>sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)?sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n:0;
 const submit=(body=sample,ip='198.51.100.71')=>runWithWorkersDb(db,async()=>{const response=await route.POST(new Request('https://pawspace.test/api/public-contact',{method:'POST',headers:{'content-type':'application/json','cf-connecting-ip':ip},body:JSON.stringify(body)}));return{status:response.status,body:await response.json()};});
 const warm=()=>submit({...sample,name:''},'198.51.100.72');
 return{sqlite,db,count,submit,warm,failAt:needle=>{fault=needle;}};
}
const assertOne=w=>{for(const table of ['crm_contacts','crm_activities','crm_tasks','lead_work_items'])assert.equal(w.count(table),1,table);};
async function rosterMember(w,email,services,cities,team='sales'){
 w.sqlite.exec("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY,email TEXT UNIQUE,status TEXT,name TEXT,role_code TEXT)");
 w.sqlite.prepare("INSERT INTO app_users VALUES (?,?, 'active','QA Associate','associate')").run(email,email);
 await assignment.saveLeadAssignmentMember(w.db,{employeeEmail:email,teamCode:team,serviceCodes:services,cityIds:cities,active:true,actorId:'qa.setup@pawspace.test'});
}

test('same public submission retry preserves one lead, contact, task and activity',async()=>{
 const w=world();const first=await w.submit(),retry=await w.submit();assert.equal(first.status,201);assert.equal(retry.status,200);assert.equal(retry.body.leadId,first.body.leadId);assert.equal(retry.body.duplicatePrevented,true);assertOne(w);assert.equal(w.count('lead_owner_mapping_exceptions'),1);w.sqlite.close();
});
for(const field of ['phone','service','whatsappConsent','gclid'])test(`reused submission key cannot change ${field}`,async()=>{
 const w=world();const first=await w.submit();const value=field==='phone'?'9000000883':field==='service'?'Boarding':field==='whatsappConsent'?true:'DIFFERENT-CLICK';const conflict=await w.submit({...sample,[field]:value});assert.equal(first.status,201);assert.equal(conflict.status,409);assertOne(w);w.sqlite.close();
});
test('concurrent retries commit exactly one connected lead transaction',async()=>{
 const w=world();await w.warm();const results=await Promise.all(Array.from({length:4},()=>w.submit()));assert.equal(results.filter(r=>r.status===201).length,1);assert.equal(results.filter(r=>r.status===200).length,3);assert.equal(new Set(results.map(r=>r.body.leadId)).size,1);assertOne(w);w.sqlite.close();
});
test('failed lead transaction rolls back receipt contact task lead and ownership exception',async()=>{
 const w=world();await w.warm();w.failAt('INSERT INTO lead_work_items');assert.equal((await w.submit()).status,500);for(const table of ['crm_contacts','crm_activities','crm_tasks','lead_work_items','public_contact_submissions','lead_owner_mapping_exceptions'])assert.equal(w.count(table),0,table);w.failAt('');assert.equal((await w.submit()).status,201);assertOne(w);w.sqlite.close();
});
test('active roster selection excludes wrong service city and team',async()=>{
 const w=world();await w.warm();await owners.ensureLeadOwnerTables(w.db);await rosterMember(w,'aa.training@pawspace.test',['training'],['Bengaluru']);await rosterMember(w,'ab.chennai@pawspace.test',['dog_walking'],['Chennai']);await rosterMember(w,'ac.support@pawspace.test',['dog_walking'],['Bengaluru'],'support');await rosterMember(w,'zz.walking@pawspace.test',['dog_walking'],['Bengaluru']);assert.equal((await w.submit()).status,201);for(const table of ['crm_contacts','lead_work_items','crm_tasks'])assert.equal(w.sqlite.prepare(`SELECT owner FROM ${table}`).get().owner,'zz.walking@pawspace.test');assert.equal(w.count('lead_owner_mapping_exceptions'),0);w.sqlite.close();
});
test('out-of-scope roster leaves the lead visibly unassigned',async()=>{
 const w=world();await w.warm();await owners.ensureLeadOwnerTables(w.db);await rosterMember(w,'qa.chennai@pawspace.test',['dog_walking'],['Chennai']);assert.equal((await w.submit()).status,201);assert.equal(w.sqlite.prepare('SELECT owner FROM lead_work_items').get().owner,'Unassigned');assert.equal(w.count('lead_owner_mapping_exceptions'),1);w.sqlite.close();
});
for(const [label,canonical] of [['General enquiry','general_inquiry'],['Doorstep Vet','vet'],['Pet Farewell Support','funeral']])test(`advertised ${label} maps to configured lead service ${canonical}`,async()=>{
 const w=world();await w.warm();await owners.ensureLeadOwnerTables(w.db);await rosterMember(w,'qa.scope@pawspace.test',[canonical],['Bengaluru']);assert.equal((await w.submit({...sample,service:label})).status,201);assert.equal(w.sqlite.prepare('SELECT owner FROM lead_work_items').get().owner,'qa.scope@pawspace.test');w.sqlite.close();
});
for(const malformed of ['{','{}','null','[17]','[""]'])test(`malformed owner scope fails closed: ${malformed}`,async()=>{
 const w=world();await w.warm();await owners.ensureLeadOwnerTables(w.db);await rosterMember(w,'qa.scope@pawspace.test',['dog_walking'],['Bengaluru']);w.sqlite.prepare('UPDATE lead_assignment_memberships SET service_codes_json=?').run(malformed);const failed=await w.submit();assert.equal(failed.status,500);assert.equal(w.count('lead_work_items'),0);assert.equal(w.count('public_contact_submissions'),0);w.sqlite.close();
});
