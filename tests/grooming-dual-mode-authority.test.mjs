import test from 'node:test';
import assert from 'node:assert/strict';
import {installAiHooks,freshAiDb,seedCustomer,inboundMessage,staffActor,applyOwnedDdl} from './helpers/ai-harness.mjs';
import {installRevisionFixture,revisionMigration} from './helpers/grooming-authority-harness.mjs';
import {applyIdempotentSqlMigration} from '../scripts/schema/apply-idempotent-drizzle.mjs';
import {normalizeReplaySafeDdl} from '../scripts/schema/apply-idempotent-drizzle.mjs';
import {splitSqlStatements} from '../scripts/schema/sql-statements.mjs';
import {triggerStatement,resolveTriggerSteps} from '../scripts/schema/apply-remote-migrations.mjs';
installAiHooks();
const {ensureAiHumanHandoff,staffTakeOverConversation}=await import('../lib/ai-human-handoff.ts');
const {createGroomingDualModeAuthority}=await import('../lib/grooming-dual-mode-authority.ts');
const {readPersistedGroomingOwnershipLease:readLease}=await import('../lib/grooming-persisted-ownership-lease.ts');
const {CANONICAL_BOOKING_CORE_DDL}=await import('../lib/canonical-booking-core-schema.ts');
const serviceActor={...staffActor,email:'meta-whatsapp-sales-ai@system.pawspace',principalType:'identity_subject',
 principalKey:'service:meta-whatsapp-sales-ai',roleCode:'service_meta_whatsapp_sales_ai',permissions:['communications.manage']};
async function world() {
 const {sqlite,db}=freshAiDb({PAWSPACE_DEPLOYMENT_ENV:'staging',PAWSPACE_DEPLOYMENT_INCARNATION:'isolated-test-version-1',
  PAWSPACE_AI_EXECUTIVE_ACTIVE:'true',AI_ATLAS_ACTIVE:'true',AI_SALES_ACTIVE:'true',AI_EXTERNAL_COMMUNICATION_ACTIVE:'true'});
 let tail=Promise.resolve();db.batch=items=>{const result=tail.then(async()=>{sqlite.exec('BEGIN IMMEDIATE');try{
  const results=[];for(const item of items)results.push(await item.run());sqlite.exec('COMMIT');return results;
 }catch(e){sqlite.exec('ROLLBACK');throw e;}});tail=result.catch(()=>{});return result;};
 seedCustomer(sqlite,'CUS-G','Grooming','9876500044');
 await inboundMessage(sqlite,db,{threadId:'THREAD-G',customerId:'CUS-G',text:'Grooming',idempotencyKey:'grooming'});
 await ensureAiHumanHandoff(db);applyOwnedDdl(sqlite,'lib/ai-conversation-orchestrator.ts');
 sqlite.exec('DROP TABLE canonical_bookings');for(const sql of CANONICAL_BOOKING_CORE_DDL)sqlite.exec(sql);
 installRevisionFixture(sqlite);
 const now=Date.now();
 sqlite.prepare(`INSERT INTO gce_goals(id,title,goal_type,status,autonomy_mode,service_code,starts_at,approved_by,approved_at,created_by,created_at,updated_at)
 VALUES('GOAL-G','Grooming','booking_conversion','active','execute_within_envelope','grooming',1,'founder',1,'founder',?,?)`).run(now,now);
 sqlite.prepare(`INSERT INTO voice_sales_offers(id,turn_key,thread_id,customer_id,service_code,status,quote_json,actions_json,summary,expires_at,created_at,confirmed_at)
 VALUES('OFFER-G','TURN-G','THREAD-G','CUS-G','grooming','executing','{"amount":1000}','[]','Approved quote',?,?,?)`).run(now+3600000,now,now);
 sqlite.exec("INSERT INTO ai_audience_rollout VALUES(1,'customers','Local test','founder',1)");
 sqlite.exec(`INSERT INTO ai_assistant_profile_versions(id,profile_key,version,status,brand_voice,supported_languages_json,greeting_text,fallback_text,immutable_hash,created_by,created_at,updated_at)
 VALUES('PROFILE','default',1,'active','voice','[]','hello','human','hash','founder',1,1);
 UPDATE ai_assistant_profile_versions SET provider_ref='provider-g',model_ref='model-g';
 INSERT INTO ai_prompt_policy_versions(id,policy_key,version,status,system_prompt,policy_json,immutable_hash,created_by,created_at,updated_at)
 VALUES('PROMPT','default',1,'active','policy','{}','hash','founder',1,1)`);
 const authority=createGroomingDualModeAuthority(db);
 const input=(actor=serviceActor)=>({actor,threadId:'THREAD-G',goalId:'GOAL-G'});
 const issue=(actor=serviceActor,boundary='tool_commit')=>authority.issue(input(actor),boundary);
 const write=()=>db.prepare(`INSERT INTO canonical_bookings(id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,
 package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,total_amount,created_by,created_at,updated_at)
 VALUES('BOOKING-G','COMMAND-G','CUS-G','[]','[]','blr','zone','grooming','full','Full','GROUP-G','PROVIDER-G','2026-10-01','2026-10-02',1000,'founder',1,1)`);
 return {sqlite,db,authority,issue,input,write};
}
const conflict=e=>e instanceof Response&&e.status===409;

test('migration replay preserves revisions/incarnation and canonical tables',async()=>{
 const w=await world(),before=w.sqlite.prepare('SELECT * FROM grooming_effective_control_revision').get();
 const ownership=w.sqlite.prepare('SELECT * FROM conversation_ownership_revisions').all();
 applyIdempotentSqlMigration(w.sqlite,revisionMigration);
 assert.deepEqual(w.sqlite.prepare('SELECT * FROM grooming_effective_control_revision').get(),before);
 assert.deepEqual(w.sqlite.prepare('SELECT * FROM conversation_ownership_revisions').all(),ownership);
 await w.issue();w.sqlite.close();
});

test('opaque server authority fences canonical booking transaction and rejects client-shaped handles',async()=>{
 const w=await world();await assert.rejects(()=>w.authority.commitCanonicalBatch({serverOwned:true},'tool_commit',[w.write()]),e=>e.status===403);
 const handle=await w.issue();await w.authority.commitCanonicalBatch(handle,'tool_commit',[w.write()]);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM canonical_bookings').get().n,1);
 await assert.rejects(()=>w.authority.commitCanonicalBatch(handle,'tool_commit',[]),conflict);w.sqlite.close();
});

for(const table of ['gce_goals','ai_audience_rollout','executive_runtime_config','ai_kill_switches','whatsapp_conversation_routing_modes','voice_sales_offers'])
 test(`control/terms revision covers ${table} off/on or away/back ABA`,async()=>{
 const w=await world(),handle=await w.issue();
 const ops={gce_goals:"UPDATE gce_goals SET autonomy_mode='recommend'; UPDATE gce_goals SET autonomy_mode='execute_within_envelope'",
 ai_audience_rollout:"UPDATE ai_audience_rollout SET stage='off'; UPDATE ai_audience_rollout SET stage='customers'",
 executive_runtime_config:"INSERT INTO executive_runtime_config VALUES('PAWSPACE_AI_EXECUTIVE_ACTIVE','false','test',1); UPDATE executive_runtime_config SET value='true'",
 ai_kill_switches:"INSERT INTO ai_kill_switches VALUES('global','ai',1,'test','test',1); DELETE FROM ai_kill_switches",
 whatsapp_conversation_routing_modes:"INSERT INTO whatsapp_conversation_routing_modes VALUES('THREAD-G','human_only','test','test',1); UPDATE whatsapp_conversation_routing_modes SET mode='ai_assistant'",
 voice_sales_offers:"UPDATE voice_sales_offers SET quote_json='{\"amount\":1200}'; UPDATE voice_sales_offers SET quote_json='{\"amount\":1000}'"};
 w.sqlite.exec(ops[table]);await assert.rejects(()=>w.authority.commitCanonicalBatch(handle,'tool_commit',[w.write()]),conflict);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM canonical_bookings').get().n,0);w.sqlite.close();
});

test('employee canonical continuation works with every model/switch off; internal generation remains gated',async()=>{
 const w=await world();await staffTakeOverConversation(w.db,{actor:staffActor,threadId:'THREAD-G',customerId:'CUS-G',reason:'Employee Grooming continuation'});
 Object.assign(globalThis.__PAWSPACE_TEST_ENV__,{PAWSPACE_AI_EXECUTIVE_ACTIVE:'false',AI_ATLAS_ACTIVE:'false',AI_SALES_ACTIVE:'false'});
 w.sqlite.exec("UPDATE ai_audience_rollout SET stage='off'");const handle=await w.issue(staffActor);
 await w.authority.commitCanonicalBatch(handle,'tool_commit',[w.write()]);
 await assert.rejects(()=>w.issue(staffActor,'generation'),conflict);w.sqlite.close();
});

test('fresh terms confirmation, scope and deployment incarnation resolve exclusively on server',async()=>{
 const w=await world(),handle=await w.issue();
 globalThis.__PAWSPACE_TEST_ENV__.PAWSPACE_DEPLOYMENT_INCARNATION='isolated-test-version-2';
 await assert.rejects(()=>w.authority.commitCanonicalBatch(handle,'tool_commit',[w.write()]),conflict);
 delete globalThis.__PAWSPACE_TEST_ENV__.PAWSPACE_DEPLOYMENT_INCARNATION;await assert.rejects(()=>w.issue(),conflict);
 globalThis.__PAWSPACE_TEST_ENV__.PAWSPACE_DEPLOYMENT_INCARNATION='isolated-test-version-3';
 w.sqlite.exec("UPDATE voice_sales_offers SET confirmed_at=NULL,status='pending'");await assert.rejects(()=>w.issue(),conflict);
 w.sqlite.exec("UPDATE voice_sales_offers SET service_code='dog_training'");await assert.rejects(()=>w.issue(),conflict);w.sqlite.close();
});

test('partial installation cannot issue authority or accept an already issued final write',async()=>{
 const w=await world(),handle=await w.issue();w.sqlite.exec('DROP TRIGGER conversation_revision_update');
 await assert.rejects(()=>w.issue(),conflict);await assert.rejects(()=>w.authority.commitCanonicalBatch(handle,'tool_commit',[w.write()]),conflict);
 applyIdempotentSqlMigration(w.sqlite,revisionMigration);await w.issue();w.sqlite.close();
});

test('trigger protection forbids revision reset/delete; saturation rolls back control source write',async()=>{
 const w=await world();assert.throws(()=>w.sqlite.exec('UPDATE conversation_ownership_revisions SET revision=1'),/must_increase/);
 assert.throws(()=>w.sqlite.exec('DELETE FROM conversation_ownership_revisions'),/tombstone_required/);
 assert.throws(()=>w.sqlite.exec('DELETE FROM grooming_effective_control_revision'),/tombstone_required/);
 w.sqlite.exec('UPDATE grooming_effective_control_revision SET revision=9007199254740991');
 assert.throws(()=>w.sqlite.exec("UPDATE ai_audience_rollout SET stage='off'"),/CHECK constraint failed/);
 assert.equal(w.sqlite.prepare('SELECT stage FROM ai_audience_rollout').get().stage,'customers');w.sqlite.close();
});

test('control writer race after resolution is fenced inside canonical batch and rollback leaves no booking',async()=>{
 const w=await world(),handle=await w.issue();const original=w.db.batch;let injected=false;
 // Intercept the FINAL canonical batch (not activeGoalContext schema readiness).
 w.db.batch=items=>{if(!injected&&items.length>=5){injected=true;w.sqlite.exec("UPDATE ai_audience_rollout SET stage='off'");}return original(items);};
 await assert.rejects(()=>w.authority.commitCanonicalBatch(handle,'tool_commit',[w.write()]),conflict);
 assert.equal(injected,true);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM canonical_bookings').get().n,0);w.sqlite.close();
});

test('canonical failure rolls back preceding booking and both revision increments',async()=>{
 const w=await world(),handle=await w.issue();const before=w.sqlite.prepare('SELECT revision FROM grooming_effective_control_revision').get().revision;
 await assert.rejects(()=>w.authority.commitCanonicalBatch(handle,'tool_commit',[w.write(),w.db.prepare('SELECT abs(-9223372036854775808)')]),conflict);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM canonical_bookings').get().n,0);
 assert.equal(w.sqlite.prepare('SELECT revision FROM grooming_effective_control_revision').get().revision,before);w.sqlite.close();
});

test('missing schema cannot silently issue a fallback authority',async()=>{
 const w=await world();w.sqlite.exec('DROP TABLE grooming_revision_installation');
 await assert.rejects(()=>w.issue(),/no such table/);w.sqlite.close();
});

test('database incarnation is replay-stable and differs for independent installs',async()=>{
 const first=await world();const firstIncarnation=first.sqlite.prepare('SELECT database_incarnation FROM grooming_effective_control_revision').get().database_incarnation;
 first.sqlite.close();const second=await world();
 assert.notEqual(second.sqlite.prepare('SELECT database_incarnation FROM grooming_effective_control_revision').get().database_incarnation,firstIncarnation);second.sqlite.close();
});

test('terms changed between resolution and final canonical write are fenced',async()=>{
 const w=await world(),handle=await w.issue();const original=w.db.batch;let injected=false;
 w.db.batch=items=>{if(!injected&&items.length>=5){injected=true;w.sqlite.exec(`UPDATE voice_sales_offers SET expires_at=1`);}return original(items);};
 await assert.rejects(()=>w.authority.commitCanonicalBatch(handle,'tool_commit',[w.write()]),conflict);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM canonical_bookings').get().n,0);w.sqlite.close();
});

test('failed partial migration stays closed; replay finishes installation without resetting revisions',async()=>{
 const w=await world();w.sqlite.exec('DROP TRIGGER grooming_control_ai_audience_rollout_update; DELETE FROM grooming_revision_installation');
 await assert.rejects(()=>w.issue(),conflict);const before=w.sqlite.prepare('SELECT revision FROM grooming_effective_control_revision').get().revision;
 applyIdempotentSqlMigration(w.sqlite,revisionMigration);
 assert.equal(w.sqlite.prepare('SELECT revision FROM grooming_effective_control_revision').get().revision,before);
 await w.issue();w.sqlite.close();
});

test('server-owned generation discards reply after control off/on cycle',async()=>{
 const w=await world(),handle=await w.issue(serviceActor,'generation');let started,finish;
 const begun=new Promise(r=>{started=r;});
 const reply=w.authority.generate(handle,{provider:'provider-g',modelRef:'model-g',status:'connected',run:()=>{started();return new Promise(r=>{finish=r;});}});
 await begun;w.sqlite.exec("UPDATE ai_audience_rollout SET stage='off'; UPDATE ai_audience_rollout SET stage='customers'");finish('Stale draft');
 await assert.rejects(()=>reply,conflict);w.sqlite.close();
});

test('unprivileged employee or non-service AI identity cannot obtain a mutation capability',async()=>{
 const w=await world();await assert.rejects(()=>w.issue({...staffActor,permissions:[]}),e=>e.status===403);
 await assert.rejects(()=>w.issue({...serviceActor,principalType:'email',principalKey:serviceActor.email}),e=>e.status===403);w.sqlite.close();
});

 test('a same-name stale/no-op trigger is not accepted as a complete installation',async()=>{
  const w=await world();w.sqlite.exec(`DROP TRIGGER conversation_revision_update;
   CREATE TRIGGER conversation_revision_update AFTER UPDATE ON communication_threads BEGIN SELECT 1; END;`);
  await assert.rejects(()=>w.issue(),conflict);w.sqlite.close();
});

test('mandatory payment/status reconciliation is independent of AI control revision and saturation',async()=>{
 const w=await world(),handle=await w.issue();await w.authority.commitCanonicalBatch(handle,'tool_commit',[w.write()]);
 w.sqlite.exec(`INSERT INTO booking_payments(id,booking_id,customer_id,amount,amount_due_now,method,mode,status,idempotency_key,created_at,updated_at)
  VALUES('PAYMENT-G','BOOKING-G','CUS-G',1000,1000,'upi','prepaid','created','PAY-COMMAND-G',1,1)`);
 await staffTakeOverConversation(w.db,{actor:staffActor,threadId:'THREAD-G',customerId:'CUS-G',reason:'Employee owns pending payment'});
 w.sqlite.exec(`UPDATE grooming_effective_control_revision SET revision=9007199254740991;
  UPDATE booking_payments SET status='captured' WHERE id='PAYMENT-G';
  UPDATE canonical_bookings SET status='completed' WHERE id='BOOKING-G'`);
 assert.equal(w.sqlite.prepare('SELECT status FROM booking_payments').get().status,'captured');
 assert.equal(w.sqlite.prepare('SELECT status FROM canonical_bookings').get().status,'completed');w.sqlite.close();
});

test('attached employee-owned lead cannot be re-enabled merely by an AI thread assignment',async()=>{
 const w=await world();w.sqlite.exec(`UPDATE communication_threads SET lead_id='LEAD-X';
  INSERT INTO ai_lead_ownership(lead_id,contact_id,status,created_at,updated_at) VALUES('LEAD-X','CUS-G','human_escalated',1,1)`);
 await assert.rejects(()=>w.issue(),conflict);
 w.sqlite.exec("UPDATE ai_lead_ownership SET status='ai_owned'");await w.issue();w.sqlite.close();
});

test('mixed snapshot during scope resolution refuses capability rather than binding new epoch to old scope',async()=>{
 const w=await world();const prepare=w.db.prepare;let changed=false;
 w.db.prepare=sql=>{const result=prepare(sql);if(!String(sql).startsWith('SELECT customer_id,booking_id,lead_id,'))return result;
  return {bind:(...args)=>{const bound=result.bind(...args);return {...bound,first:async()=>{const row=await bound.first();
   if(!changed){changed=true;w.sqlite.exec("UPDATE communication_threads SET lead_id='changed-scope'");}return row;}};}};};
 await assert.rejects(()=>w.issue(),conflict);assert.equal(changed,true);w.sqlite.close();
});

for(const scope of ['provider','model'])test(`review P1: selected ${scope} kill switch blocks issuance`,async()=>{
 const w=await world();w.sqlite.exec("UPDATE ai_assistant_profile_versions SET provider_ref='provider-g',model_ref='model-g'");
 w.sqlite.prepare('INSERT INTO ai_kill_switches VALUES(?,?,1,?,?,1)').run(scope,`${scope}-g`,'review scoped kill','test');
 await assert.rejects(()=>w.issue(),conflict);w.sqlite.close();
});

test('review P1: currency ABA on an existing booking invalidates authority without any offer update',async()=>{
 const w=await world();await w.authority.commitCanonicalBatch(await w.issue(),'tool_commit',[w.write()]);
 w.sqlite.exec("UPDATE communication_threads SET booking_id='BOOKING-G'");const handle=await w.issue();
 w.sqlite.exec("UPDATE canonical_bookings SET currency='USD'; UPDATE canonical_bookings SET currency='INR'");
 await assert.rejects(()=>w.authority.commitCanonicalBatch(handle,'tool_commit',[
  w.db.prepare("UPDATE canonical_bookings SET package_name='MUST-NOT-COMMIT'")]),conflict);w.sqlite.close();
});

test('review P1: repair invalidates authority created before an untracked mutation gap',async()=>{
 const w=await world(),handle=await w.issue();
 w.sqlite.exec("DROP TRIGGER conversation_revision_update; UPDATE communication_threads SET assigned_to='staff-gap'; UPDATE communication_threads SET assigned_to='ai-orchestrator'");
 applyIdempotentSqlMigration(w.sqlite,revisionMigration);
 await assert.rejects(()=>w.authority.commitCanonicalBatch(handle,'tool_commit',[w.write()]),conflict);w.sqlite.close();
});

for(const table of ['ai_assistant_profile_versions','ai_prompt_policy_versions'])test(`review P2: selected ${table} expires after refresh before final batch`,async()=>{
 const w=await world();w.sqlite.prepare(`UPDATE ${table} SET effective_to=?`).run(Date.now()+2000);
 const handle=await w.issue(),original=w.db.batch;let waited=false;
 w.db.batch=async items=>{if(!waited&&items.length>=5){waited=true;await new Promise(r=>setTimeout(r,2100));}return original(items);};
 await assert.rejects(()=>w.authority.commitCanonicalBatch(handle,'tool_commit',[w.write()]),conflict);
 assert.equal(waited,true);w.sqlite.close();
});

for(const scope of ['provider','model']) {
 test(`selected ${scope} kill before generation prevents provider execution`,async()=>{
  const w=await world(),handle=await w.issue(serviceActor,'generation');let calls=0;
  w.sqlite.prepare('INSERT INTO ai_kill_switches VALUES(?,?,1,?,?,1)').run(scope,`${scope}-g`,'scoped kill','test');
  await assert.rejects(()=>w.authority.generate(handle,{provider:'provider-g',modelRef:'model-g',status:'connected',run:async()=>{calls++;return 'reply';}}),conflict);
  assert.equal(calls,0);w.sqlite.close();
 });
 test(`selected ${scope} kill at final batch rejects canonical booking race`,async()=>{
  const w=await world(),handle=await w.issue(),original=w.db.batch;let injected=false;
  w.db.batch=items=>{if(!injected&&items.length>=7){injected=true;
   w.sqlite.prepare('INSERT INTO ai_kill_switches VALUES(?,?,1,?,?,1)').run(scope,`${scope}-g`,'scoped kill race','test');}return original(items);};
  await assert.rejects(()=>w.authority.commitCanonicalBatch(handle,'tool_commit',[w.write()]),conflict);
  assert.equal(injected,true);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM canonical_bookings').get().n,0);w.sqlite.close();
 });
}

test('actual provider/model must match the selected server profile before any generation',async()=>{
 const w=await world(),handle=await w.issue(serviceActor,'generation');let calls=0;
 for(const wrong of [{provider:'other',modelRef:'model-g'},{provider:'provider-g',modelRef:'other'}])
  await assert.rejects(()=>w.authority.generate(handle,{...wrong,status:'connected',run:async()=>{calls++;return 'reply';}}),conflict);
 assert.equal(calls,0);w.sqlite.close();
});

test('provider scoped kill policy normalizes selected identifier exactly as existing switch writer',async()=>{
 const w=await world();w.sqlite.exec("UPDATE ai_assistant_profile_versions SET provider_ref='PROVIDER-G'; INSERT INTO ai_kill_switches VALUES('provider','provider-g',1,'scoped kill','test',1)");
 await assert.rejects(()=>w.issue(),conflict);w.sqlite.close();
});

test('intact migration replay preserves installation authority and does not invalidate an unchanged handle',async()=>{
 const w=await world(),handle=await w.issue();const before=w.sqlite.prepare('SELECT * FROM grooming_revision_installation_epoch').get();
 applyIdempotentSqlMigration(w.sqlite,revisionMigration);
 assert.deepEqual(w.sqlite.prepare('SELECT * FROM grooming_revision_installation_epoch').get(),before);
 await w.authority.commitCanonicalBatch(handle,'tool_commit',[w.write()]);w.sqlite.close();
});

test('governed migration planner skips every intact trigger pair and repairs a stale pair',async()=>{
 const w=await world();
 const steps=splitSqlStatements(normalizeReplaySafeDdl(revisionMigration)).flatMap(sql=>{
  const trigger=triggerStatement(sql);return trigger?[{type:'trigger',...trigger,sql}]:[];
 });
 const live=new Map(w.sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all().map(row=>[row.name,row.sql]));
 assert.equal(steps.length,114);assert.ok(resolveTriggerSteps(steps,live).every(decision=>decision==='skip'));
 const name='conversation_revision_update';live.set(name,`CREATE TRIGGER ${name} AFTER UPDATE ON communication_threads BEGIN SELECT 1; END`);
 const decisions=resolveTriggerSteps(steps,live);
 assert.deepEqual(steps.flatMap((step,index)=>step.name===name?[decisions[index]]:[]),['drop','create']);
 assert.ok(steps.every((step,index)=>step.name===name||decisions[index]==='skip'));w.sqlite.close();
});

test('installation table recreation gets a fresh incarnation even if its numeric epoch repeats',async()=>{
 const w=await world(),handle=await w.issue();const before=w.sqlite.prepare('SELECT * FROM grooming_revision_installation_epoch').get();
 w.sqlite.exec('DROP TABLE grooming_revision_installation_epoch');applyIdempotentSqlMigration(w.sqlite,revisionMigration);
 const after=w.sqlite.prepare('SELECT * FROM grooming_revision_installation_epoch').get();assert.notEqual(after.incarnation,before.incarnation);
 await assert.rejects(()=>w.authority.commitCanonicalBatch(handle,'tool_commit',[w.write()]),conflict);w.sqlite.close();
});

test('commercial-field audit: every canonical booking column except lifecycle status/touch time invalidates an ABA handle',async()=>{
 const w=await world();await w.authority.commitCanonicalBatch(await w.issue(),'tool_commit',[w.write()]);
 w.sqlite.exec("UPDATE communication_threads SET booking_id='BOOKING-G'");
 const columns=w.sqlite.prepare('PRAGMA table_info(canonical_bookings)').all().map(c=>c.name).filter(c=>!['status','updated_at'].includes(c));
 const unchangedOffer=w.sqlite.prepare('SELECT quote_json,actions_json,confirmed_at FROM voice_sales_offers').get();
 for(const column of columns) {
  const handle=await w.issue(),before=w.sqlite.prepare(`SELECT ${column} value FROM canonical_bookings WHERE id='BOOKING-G'`).get().value;
  const other=typeof before==='number'?before+1:`${before}-changed`;
  w.sqlite.prepare(`UPDATE canonical_bookings SET ${column}=? WHERE id='BOOKING-G'`).run(other);
  w.sqlite.prepare(`UPDATE canonical_bookings SET ${column}=? WHERE id=?`).run(before,column==='id'?other:'BOOKING-G');
  await assert.rejects(()=>w.authority.commitCanonicalBatch(handle,'tool_commit',[]),conflict,column);
 }
 assert.deepEqual(w.sqlite.prepare('SELECT quote_json,actions_json,confirmed_at FROM voice_sales_offers').get(),unchangedOffer);w.sqlite.close();
});

for(const table of ['ai_assistant_profile_versions','ai_prompt_policy_versions'])test(`${table} expiry at discretionary send batch also rolls back canonical write`,async()=>{
 const w=await world();w.sqlite.prepare(`UPDATE ${table} SET effective_to=?`).run(Date.now()+2000);
 const handle=await w.issue(serviceActor,'discretionary_send'),original=w.db.batch;let waited=false;
 w.db.batch=async items=>{if(!waited&&items.length>=6){waited=true;await new Promise(r=>setTimeout(r,2100));}return original(items);};
 await assert.rejects(()=>w.authority.commitCanonicalBatch(handle,'discretionary_send',[w.db.prepare("UPDATE communication_threads SET ticket_id='MUST-NOT-WRITE'")]),conflict);
 assert.equal(w.sqlite.prepare('SELECT ticket_id FROM communication_threads').get().ticket_id,null);w.sqlite.close();
});
