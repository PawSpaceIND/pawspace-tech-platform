import test from 'node:test';
import assert from 'node:assert/strict';
import { installAiHooks, freshAiDb, seedCustomer, inboundMessage } from './helpers/ai-harness.mjs';
installAiHooks(); process.env.PAWSPACE_LOCAL_PREVIEW = 'off';
const { ensureCustomer360Tables } = await import('../lib/customer-360.ts');
const api = await import('../app/api/conversations/route.ts');
const { ensureSecurityTables } = await import('../lib/server-auth.ts');
const { ensureConversationAccessTables } = await import('../lib/conversation-access.ts');
const { ensureWhatsAppInboxProductivity } = await import('../lib/whatsapp-inbox-productivity.ts');
const { ensureWhatsAppTemplateLifecycle } = await import('../lib/whatsapp-template-lifecycle.ts');
const { ensureLeadIntakeAdAttribution } = await import('../lib/lead-intake-ad-attribution.ts');
const { requiredPermission } = await import('../lib/api-gateway.ts');
const origin = 'https://app.pawspace.in';
const owner = 'inbox.owner@pawspace.test', peer = 'inbox.peer@pawspace.test', restricted = 'inbox.restricted@pawspace.test';
function request(path = '', body, email = owner, requestOrigin = origin) {
  return new Request(origin + '/api/conversations' + path, { method: body ? 'POST' : 'GET', headers: { 'oai-authenticated-user-email': email, ...(body ? { origin: requestOrigin, 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function call(path, body, email) { const response = await api[body ? 'POST' : 'GET'](request(path, body, email)); return { status: response.status, body: await response.json() }; }
async function world(t) {
  const { sqlite, db } = freshAiDb(); t.after(() => sqlite.close());
  await ensureSecurityTables(db); await ensureCustomer360Tables(db); await ensureConversationAccessTables(db); await ensureWhatsAppInboxProductivity(db); await ensureWhatsAppTemplateLifecycle(db);
  const now = Date.now();
  for (const [email, role] of [[owner, 'admin'], [peer, 'admin'], [restricted, 'associate']]) sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,? ,?,'active',?,?)").run(email, email, 'Synthetic staff', role, now, now);
  for (const suffix of ['A', 'B', 'C']) {
    seedCustomer(sqlite, 'CUS-' + suffix, 'Synthetic customer ' + suffix, '+91990000000' + suffix);
    await inboundMessage(sqlite, db, { threadId: 'THREAD-' + suffix, customerId: 'CUS-' + suffix, text: 'Synthetic enquiry', channel: 'whatsapp', idempotencyKey: 'inbox-in-' + suffix });
    sqlite.prepare('UPDATE communication_threads SET assigned_to=?,updated_at=? WHERE id=?').run(suffix === 'B' ? peer : owner, now, 'THREAD-' + suffix);
    sqlite.prepare("UPDATE communication_messages SET provider='sandbox_simulator',created_at=? WHERE thread_id=?").run(now - 25 * 60 * 60_000, 'THREAD-' + suffix);
    sqlite.prepare("INSERT INTO whatsapp_uat_sessions (customer_id,provider,last_inbound_at) VALUES (?,'sandbox_simulator',?)").run('CUS-' + suffix, now - 25 * 60 * 60_000);
    sqlite.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,opt_out,source,updated_by,updated_at) VALUES (?,0,1,1,0,0,0,'synthetic','test',?)").run('CUS-' + suffix, now);
  }
  const template = (key, { language = 'en_US', category = 'utility', status = 'approved', variables = [], body = 'PawSpace has a service update. Reply here for help.', reconciled = 'approved' } = {}) => {
    sqlite.prepare('INSERT INTO whatsapp_uat_templates (template_key,status,category,approved_language,updated_by,updated_at) VALUES (?,?,?,?,?,?)').run(key, status, category, language, 'test', now);
    sqlite.prepare("INSERT INTO whatsapp_template_lifecycle (template_key,display_name,body,variables_json,meta_reconciliation_status,meta_reference,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,?,?,'META-SYNTHETIC','test',?,'test',?)").run(key, key, body, JSON.stringify(variables), reconciled, now, now);
  };
  template('service_update'); template('with_variable', { variables: ['{{1}}'], body: 'Hi {{1}}' }); template('marketing_offer', { category: 'marketing' }); template('local_only', { reconciled: 'not_submitted' }); template('draft_only', { status: 'draft' });
  return { sqlite, db, now };
}


const { actorCanAccessConversation } = await import('../lib/conversation-access.ts');
// Review-only D1 adapter. SQL and bindings are unchanged; batches commit synchronously in a
// real SQLite transaction. An explicit hook models another committed request immediately
// before the queue batch starts. No source, gateway or outbound transport is changed.
function atomicBoundary(db, sqlite, beforeQueue) {
  const originalPrepare = db.prepare.bind(db);
  const statement = (sql, args = []) => {
    const actual = originalPrepare(sql).bind(...args);
    return { ...actual, _sql: sql, _args: args, bind: (...bound) => statement(sql, bound) };
  };
  db.prepare = sql => statement(sql);
  db.batch = async items => {
    if (items.some(item => /^INSERT INTO communication_messages /.test(item._sql))) await beforeQueue?.();
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const out = items.map(item => { const r = sqlite.prepare(item._sql).run(...item._args); return {success:true,meta:{changes:Number(r.changes)}}; });
      sqlite.exec('COMMIT'); return out;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  };
}
function templateRequest(clientRequestId, templateKey='service_update') { return {action:'template_reply',threadId:'THREAD-A',templateKey,language:'en_US',clientRequestId}; }
function restrictedOwner(sqlite, now) {
  sqlite.prepare("UPDATE app_users SET role_code='associate' WHERE email=?").run(owner);
  sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,area,stage,owner,source,created_at,updated_at) VALUES ('CUS-A','Synthetic A','+919900000001','blr','New lead','Unassigned','test',?,?)").run(now,now);
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,created_at,updated_at) VALUES ('LEAD-A','CUS-A','website','grooming','Unassigned','Unassigned','active','day_1',1,?,?,?,?,?)").run(now,now,now,now,now);
  sqlite.prepare("UPDATE communication_threads SET lead_id='LEAD-A' WHERE id='THREAD-A'").run();
  for (const [id,email] of [['MEM-A',owner],['MEM-B',peer]]) sqlite.prepare("INSERT INTO lead_assignment_memberships (id,employee_email,team_code,service_codes_json,city_ids_json,language_codes_json,active,created_by,created_at,updated_by,updated_at) VALUES (?,?,'sales','[\"grooming\"]','[\"blr\"]','[]',1,'seed',?,'seed',?)").run(id,email,now,now);
  sqlite.prepare("INSERT INTO lead_assignments (id,idempotency_key,lead_id,employee_email,team_code,policy_id,policy_version,assignment_reason,status,assigned_at,detail_json,created_by,created_at) VALUES ('ASG-A','IDEM-A','LEAD-A',?,'sales','SYNTHETIC',1,'new_lead','current',?,'{}','seed',?)").run(owner,now,now);
}

test('independent: concurrent different templates using one request ID must refuse the loser', async t => {
  const {sqlite,db,now}=await world(t);
  sqlite.prepare("INSERT INTO whatsapp_uat_templates (template_key,status,category,approved_language,updated_by,updated_at) VALUES ('second_update','approved','utility','en_US','test',?)").run(now);
  sqlite.prepare("INSERT INTO whatsapp_template_lifecycle (template_key,display_name,body,variables_json,meta_reconciliation_status,meta_reference,created_by,created_at,updated_by,updated_at) VALUES ('second_update','Second update','A different approved update.','[]','approved','META-SYNTHETIC','test',?,'test',?)").run(now,now);
  let arrived=0, release; const both=new Promise(resolve=>release=resolve);
  atomicBoundary(db,sqlite,async()=>{ if(++arrived===2) release(); await both; });
  const results=await Promise.all([call('',templateRequest('fingerprint-race-1')),call('',templateRequest('fingerprint-race-1','second_update'))]);
  const messages=sqlite.prepare("SELECT template_key,payload_json,policy_json FROM communication_messages WHERE direction='outbound'").all();
  console.log('FINGERPRINT_RACE',JSON.stringify({statuses:results.map(r=>r.status),receipts:results.map(r=>r.body.data),messages}));
  assert.equal(messages.length,1);
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
});

test('independent: canonical reassignment before atomic queue must refuse former owner', async t => {
  const {sqlite,db,now}=await world(t); restrictedOwner(sqlite,now);
  const actor={email:owner,roleCode:'associate',permissions:['communications.manage'],developmentPreview:false};
  assert.equal(await actorCanAccessConversation(db,actor,'THREAD-A'),true);
  atomicBoundary(db,sqlite,()=>{sqlite.prepare("UPDATE lead_assignments SET employee_email=? WHERE id='ASG-A'").run(peer);});
  const result=await call('',templateRequest('assignment-race-1'));
  const allowedAfter=await actorCanAccessConversation(db,actor,'THREAD-A');
  const outbox=sqlite.prepare('SELECT COUNT(*) n FROM communication_outbox').get().n;
  console.log('ASSIGNMENT_RACE',JSON.stringify({status:result.status,body:result.body,allowedAfter,outbox}));
  assert.equal(allowedAfter,false);
  assert.ok([403,409].includes(result.status)); assert.equal(outbox,0);
});

test('independent: canonical customer relink before atomic queue must not create a mismatched message', async t => {
  const {sqlite,db}=await world(t);
  atomicBoundary(db,sqlite,()=>{sqlite.prepare("UPDATE communication_threads SET customer_id='CUS-B' WHERE id='THREAD-A'").run();});
  const result=await call('',templateRequest('customer-race-1'));
  const mismatches=sqlite.prepare("SELECT m.customer_id messageCustomer,t.customer_id threadCustomer FROM communication_messages m JOIN communication_threads t ON t.id=m.thread_id WHERE m.direction='outbound' AND m.customer_id!=t.customer_id").all();
  console.log('CUSTOMER_RACE',JSON.stringify({status:result.status,body:result.body,mismatches}));
  assert.equal(mismatches.length,0); assert.ok([403,409].includes(result.status));
});

test('independent: global opt-out committed before atomic queue must create no new outbound', async t => {
  const {sqlite,db}=await world(t);
  const {recordGlobalOptOut}=await import('../lib/communication-governance.ts');
  atomicBoundary(db,sqlite,async()=>{await recordGlobalOptOut(db,{customerId:'CUS-A',source:'synthetic-review',actorId:owner});});
  const result=await call('',templateRequest('consent-race-1'));
  const outbox=sqlite.prepare('SELECT COUNT(*) n FROM communication_outbox').get().n;
  console.log('CONSENT_RACE',JSON.stringify({status:result.status,body:result.body,outbox,consent:sqlite.prepare("SELECT global_opt_out,whatsapp_allowed FROM communication_consent WHERE customer_id='CUS-A'").get()}));
  assert.equal(outbox,0); assert.equal(result.status,409);
});


test('independent control: unchanged authorized state queues using the atomic adapter', async t => {
  const {sqlite,db}=await world(t); atomicBoundary(db,sqlite);
  const result=await call('',templateRequest('atomic-control-1'));
  assert.equal(result.status,201); assert.equal(result.body.data.externalDelivery,false);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM communication_outbox').get().n,1);
});

test('independent control: concurrent identical fingerprints share one durable atomic queue', async t => {
  const {sqlite,db}=await world(t); let arrived=0,release;const both=new Promise(resolve=>release=resolve);
  atomicBoundary(db,sqlite,async()=>{if(++arrived===2)release();await both;});
  const results=await Promise.all([call('',templateRequest('atomic-identical-1')),call('',templateRequest('atomic-identical-1'))]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);
  assert.equal(results[0].body.data.messageId,results[1].body.data.messageId);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM communication_outbox').get().n,1);
});

test('independent control: concurrent partial read and favourite updates preserve both personal fields', async t => {
  await world(t);
  const results=await Promise.all([call('',{action:'priority',threadId:'THREAD-A',unread:false}),call('',{action:'priority',threadId:'THREAD-A',favourite:true})]);
  assert.ok(results.every(r=>r.status===200));
  const state=(await call('?threadId=THREAD-A')).body.data.operatorState;
  assert.deepEqual(state,{unread:0,favourite:1});
  assert.deepEqual((await call('?threadId=THREAD-A',undefined,peer)).body.data.operatorState,{unread:1,favourite:0});
});

// Additional owner regressions. The seven independent cases above are preserved verbatim.
function databaseSnapshot(sqlite) {
  return JSON.stringify(sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(table => ({
    ...table, rows: sqlite.prepare(`SELECT * FROM "${table.name.replaceAll('"','""')}" ORDER BY rowid`).all(),
  })));
}
const policyRaces = [
  ['canonical reassignment', (sqlite, now) => restrictedOwner(sqlite, now), (sqlite) => sqlite.prepare("UPDATE lead_assignments SET employee_email=? WHERE id='ASG-A'").run(peer)],
  ['customer relink', null, sqlite => sqlite.prepare("UPDATE communication_threads SET customer_id='CUS-B' WHERE id='THREAD-A'").run()],
  ['central opt-out', null, async (_sqlite, db) => (await import('../lib/communication-governance.ts')).recordGlobalOptOut(db, {customerId:'CUS-A',source:'synthetic-race',actorId:owner})],
  ['contact opt-out', null, sqlite => sqlite.prepare("UPDATE customer_contact_preferences SET opt_out=1 WHERE customer_id='CUS-A'").run()],
  ['WhatsApp consent withdrawal', null, sqlite => sqlite.prepare("UPDATE customer_contact_preferences SET whatsapp_consent=0 WHERE customer_id='CUS-A'").run()],
  ['AI takeover', null, (sqlite, _db, now) => sqlite.prepare("INSERT INTO whatsapp_conversation_routing_modes (thread_id,mode,updated_by,reason,updated_at) VALUES ('THREAD-A','ai_assistant','test','Synthetic race',?)").run(now)],
  ['thread closure', null, sqlite => sqlite.prepare("UPDATE communication_threads SET status='closed' WHERE id='THREAD-A'").run()],
  ['provider kill switch', null, sqlite => sqlite.prepare("UPDATE whatsapp_uat_provider_controls SET disabled=1 WHERE provider='sandbox_simulator'").run()],
  ['template approval withdrawal', null, sqlite => sqlite.prepare("UPDATE whatsapp_uat_templates SET status='paused' WHERE template_key='service_update'").run()],
  ['approved body replacement', null, sqlite => sqlite.prepare("UPDATE whatsapp_template_lifecycle SET body='Changed approved body' WHERE template_key='service_update'").run()],
  ['language replacement', null, sqlite => sqlite.prepare("UPDATE whatsapp_uat_templates SET approved_language='en' WHERE template_key='service_update'").run()],
  ['new inbound window', null, (sqlite, _db, now) => sqlite.prepare("UPDATE whatsapp_uat_sessions SET last_inbound_at=? WHERE customer_id='CUS-A'").run(now)],
];
for (const [name, setup, change] of policyRaces) test(`commit refusal after ${name} leaves every database row byte-identical`, async t => {
  const {sqlite,db,now}=await world(t); setup?.(sqlite,now);
  let committedState;
  atomicBoundary(db,sqlite,async()=>{await change(sqlite,db,now);committedState=databaseSnapshot(sqlite);});
  const result=await call('',{...templateRequest('zero-write-'+name.replaceAll(' ','-')),commitGuard:{sql:'1=1',binds:[]},actorEmail:peer});
  assert.equal(result.status,409);
  assert.ok(committedState,'the mutation must occur immediately before the atomic queue');
  assert.equal(databaseSnapshot(sqlite),committedState,'no message, outbox, session, thread, personal state or success audit changed after the independently committed mutation');
});

test('accepted receipt replay after committed opt-out is non-mutating', async t => {
  const {sqlite,db}=await world(t);atomicBoundary(db,sqlite);
  const body=templateRequest('accepted-optout-replay');
  const accepted=await call('',body);assert.equal(accepted.status,201);
  await (await import('../lib/communication-governance.ts')).recordGlobalOptOut(db,{customerId:'CUS-A',source:'synthetic',actorId:owner});
  const before=databaseSnapshot(sqlite), replay=await call('',body);
  assert.equal(replay.status,200);assert.equal(replay.body.data.messageId,accepted.body.data.messageId);
  // Replay is read-only at the queue boundary; the existing API records the receipt audit again.
  const after=JSON.parse(databaseSnapshot(sqlite)), prior=JSON.parse(before);
  assert.deepEqual(after.filter(table=>table.name!=='security_audit_events'),prior.filter(table=>table.name!=='security_audit_events'));
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM communication_outbox').get().n,1);
});

test('a queue write failure rolls back the new message and every dependent effect', async t => {
  const {sqlite,db}=await world(t);
  sqlite.exec("CREATE TRIGGER synthetic_outbox_failure BEFORE INSERT ON communication_outbox BEGIN SELECT RAISE(ABORT,'synthetic outbox unavailable'); END");
  let before;atomicBoundary(db,sqlite,()=>{before=databaseSnapshot(sqlite);});
  assert.equal((await call('',templateRequest('atomic-write-failure'))).status,500);
  assert.equal(databaseSnapshot(sqlite),before);
});

test('no-option legacy callers keep free-text interactive policy, queued shape and duplicate behavior', async t => {
  const {sqlite,db}=await world(t);atomicBoundary(db,sqlite);
  const {queueWhatsAppUatOutbound}=await import('../lib/whatsapp-uat-adapter.ts');
  sqlite.prepare("UPDATE whatsapp_uat_sessions SET last_inbound_at=? WHERE customer_id='CUS-A'").run(Date.now());
  const input={provider:'sandbox_simulator',threadId:'THREAD-A',customerId:'CUS-A',text:'Synthetic legacy reply',interactive:{kind:'reply_buttons',buttons:[{id:'help',title:'Help'}]},idempotencyKey:'legacy-interactive-1',createdBy:owner};
  const first=await queueWhatsAppUatOutbound(db,input),before=databaseSnapshot(sqlite),retry=await queueWhatsAppUatOutbound(db,input);
  assert.deepEqual(Object.keys(first).sort(),['duplicatePrevented','externalDelivery','messageId','queued','status']);
  assert.equal(first.queued,true);assert.equal(retry.messageId,first.messageId);assert.equal(retry.duplicatePrevented,true);
  assert.equal(databaseSnapshot(sqlite),before);
  assert.deepEqual(JSON.parse(sqlite.prepare('SELECT payload_json FROM communication_messages WHERE id=?').get(first.messageId).payload_json),{text:input.text,interactive:input.interactive});
});

test('no-option legacy template callers retain language and provider/window/consent refusal policy', async t => {
  const {sqlite,db}=await world(t);atomicBoundary(db,sqlite);
  const {queueWhatsAppUatOutbound}=await import('../lib/whatsapp-uat-adapter.ts');
  const input={provider:'sandbox_simulator',threadId:'THREAD-A',customerId:'CUS-A',text:'Synthetic legacy template',templateKey:'service_update',language:'en_US',idempotencyKey:'legacy-template-1',createdBy:owner};
  const first=await queueWhatsAppUatOutbound(db,input);
  assert.equal(first.queued,true);assert.deepEqual(JSON.parse(sqlite.prepare('SELECT payload_json FROM communication_messages WHERE id=?').get(first.messageId).payload_json),{text:input.text,language:input.language});
  assert.equal((await queueWhatsAppUatOutbound(db,{...input,templateKey:null,idempotencyKey:'legacy-expired'})).reason,'approved_template_required_outside_session');
  sqlite.prepare("UPDATE whatsapp_uat_provider_controls SET disabled=1 WHERE provider='sandbox_simulator'").run();
  assert.equal((await queueWhatsAppUatOutbound(db,{...input,idempotencyKey:'legacy-killed'})).reason,'provider_kill_switch');
  sqlite.prepare("UPDATE whatsapp_uat_provider_controls SET disabled=0 WHERE provider='sandbox_simulator'").run();
  sqlite.prepare("UPDATE customer_contact_preferences SET whatsapp_consent=0 WHERE customer_id='CUS-A'").run();
  assert.equal((await queueWhatsAppUatOutbound(db,{...input,idempotencyKey:'legacy-no-consent'})).reason,'whatsapp_consent_required');
});

test('the exact approved body is preserved including surrounding whitespace', async t => {
  const {sqlite,db}=await world(t);atomicBoundary(db,sqlite);
  const body='\n  Synthetic approved body, exactly recorded.  \n';
  sqlite.prepare("UPDATE whatsapp_template_lifecycle SET body=? WHERE template_key='service_update'").run(body);
  const result=await call('',templateRequest('exact-approved-body'));
  assert.equal(result.status,201);
  assert.equal(JSON.parse(sqlite.prepare('SELECT payload_json FROM communication_messages WHERE id=?').get(result.body.data.messageId).payload_json).text,body);
});
