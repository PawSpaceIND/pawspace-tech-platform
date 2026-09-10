import test from"node:test";
import assert from"node:assert/strict";
import{DatabaseSync}from"node:sqlite";
import{installWorkersHooks}from"./helpers/module-hooks.mjs";

installWorkersHooks("__CONVERSATION_SCOPE_DB__","__CONVERSATION_SCOPE_ENV__");

const ORIGIN="https://app.pawspace.in";
const OWNER="owner.conversation@pawspace.in";
const PEER="peer.conversation@pawspace.in";
const SALES_MANAGER="manager.sales.conversation@pawspace.in";
const OTHER_CITY_MANAGER="manager.mysuru.conversation@pawspace.in";
const OTHER_TEAM_MANAGER="manager.support.conversation@pawspace.in";
const ADMIN="admin.conversation@pawspace.in";

function makeD1(sqlite){
 const statement=(sql,args)=>({
  bind:(...bound)=>statement(sql,bound),
  first:async()=>sqlite.prepare(sql).get(...args)??null,
  run:async()=>{const info=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(info.changes)}};},
  all:async()=>({results:sqlite.prepare(sql).all(...args)}),
 });
 return{prepare:sql=>statement(sql,[]),batch:async items=>{const out=[];for(const item of items)out.push(await item.run());return out;},exec:async sql=>{sqlite.exec(sql);return{count:0,duration:0};}};
}

async function world(){
 const sqlite=new DatabaseSync(":memory:"),db=makeD1(sqlite);
 globalThis.__CONVERSATION_SCOPE_DB__=db;
 globalThis.__CONVERSATION_SCOPE_ENV__={};
 const{ensureSecurityTables}=await import("../lib/server-auth.ts");
 const{ensureConversationGovernance}=await import("../lib/conversation-governance.ts");
 const{ensureConversationAccessTables}=await import("../lib/conversation-access.ts");
 const{ensureAiHumanHandoff}=await import("../lib/ai-human-handoff.ts");
 await ensureSecurityTables(db);await ensureConversationGovernance(db);await ensureConversationAccessTables(db);await ensureAiHumanHandoff(db);
 const now=Date.now();
 sqlite.exec("CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'test',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
 for(const[id,email,role]of[
  ["USR-OWNER",OWNER,"associate"],["USR-PEER",PEER,"associate"],
  ["USR-SALES-MANAGER",SALES_MANAGER,"manager"],["USR-CITY-MANAGER",OTHER_CITY_MANAGER,"manager"],
  ["USR-TEAM-MANAGER",OTHER_TEAM_MANAGER,"manager"],["USR-ADMIN",ADMIN,"admin"],
 ])sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?, 'active',?,?)").run(id,email,email,role,now,now);

 const member=(id,email,team,services,cities)=>sqlite.prepare("INSERT INTO lead_assignment_memberships (id,employee_email,team_code,service_codes_json,city_ids_json,language_codes_json,active,workload_cap_override,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,?,?,'[]',1,NULL,'seed',?,'seed',?)").run(id,email,team,JSON.stringify(services),JSON.stringify(cities),now,now);
 member("MEM-OWNER",OWNER,"sales",["grooming"],["blr"]);
 member("MEM-PEER",PEER,"sales",["grooming"],["blr"]);
 member("MEM-SALES-MANAGER",SALES_MANAGER,"sales",["grooming"],["blr"]);
 member("MEM-CITY-MANAGER",OTHER_CITY_MANAGER,"sales",["grooming"],["mysuru"]);
 member("MEM-TEAM-MANAGER",OTHER_TEAM_MANAGER,"support",["grooming"],["blr"]);
 sqlite.prepare("INSERT INTO lead_assignment_policies (id,name,status,version,team_code,service_codes_json,city_ids_json,language_codes_json,max_active_workload,continuity_enabled,require_shift,fallback_queue,effective_from,effective_until,approval_reference,created_by,created_at,updated_by,updated_at) VALUES ('POL-SALES-BLR','Sales Bengaluru','active_uat',1,'sales','[\"grooming\"]','[\"blr\"]','[]',100,1,0,'cx-sales',?,NULL,'UAT-SCOPE','seed',?,'seed',?)").run(now-60_000,now,now);

 const lead=(code,city,team,employee,fallback=null,threadAssignedTo=null,withAssignment=true)=>{
  const customer=`CUS-${code}`,leadId=`LEAD-${code}`,threadId=`THREAD-${code}`;
  sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,area,stage,owner,source,created_at,updated_at) VALUES (?,?,?,?, 'New lead','Unassigned','test',?,?)").run(customer,`Customer ${code}`,`+91990000${code.length.toString().padStart(4,"0")}`,city,now,now);
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(customer,city,`Customer ${code}`,`+91990000${code.length.toString().padStart(4,"0")}`,now,now);
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,created_at,updated_at) VALUES (?,?, 'website','grooming','Unassigned','Unassigned','active','day_1',1,?,?,?,?,?)").run(leadId,customer,now,now+600_000,now+1_800_000,now,now);
  if(withAssignment)sqlite.prepare("INSERT INTO lead_assignments (id,idempotency_key,lead_id,employee_email,team_code,policy_id,policy_version,assignment_reason,status,fallback_queue,assigned_at,detail_json,created_by,created_at) VALUES (?,?,?,?,?,'POL-SALES-BLR',1,'new_lead','current',?,?,'{}','seed',?)").run(`ASG-${code}`,`IDEM-${code}`,leadId,employee,team,fallback,now,now);
  sqlite.prepare("INSERT INTO communication_threads (id,customer_id,lead_id,status,assigned_to,created_at,updated_at) VALUES (?,?,?,'open',?,?,?)").run(threadId,customer,leadId,threadAssignedTo,now,now);
  sqlite.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,lead_id,direction,channel,purpose,template_key,payload_json,status,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES (?,?,?,?, 'inbound','whatsapp','transactional','inbound',?,'delivered',?,'{}','customer',?,?)").run(`MSG-${code}`,threadId,customer,leadId,JSON.stringify({text:`private-${code}`,customerPhone:"+919999111122"}),`MSG-IDEM-${code}`,now,now);
  return{customer,leadId,threadId};
 };
 const owned=lead("OWNED","blr","sales",OWNER);
 const peer=lead("PEER","blr","sales",PEER);
 const fallback=lead("FALLBACK","blr","sales",null,"cx-sales");
 const legacy=lead("LEGACY","blr","sales",null,null,null,false);
 const otherCity=lead("OTHER-CITY","mysuru","sales",PEER);
 // Deliberately forged projection: assigned_to names OWNER, canonical assignment belongs to Support.
 const forged=lead("FORGED","blr","support",PEER,null,OWNER);
 for(const item of[owned,forged])sqlite.prepare("INSERT INTO ai_handoffs (id,thread_id,customer_id,reason,queue_code,status,summary_json,requested_by,created_at) VALUES (?,?,?,'customer_requested_human','cx-ai-handoff','queued','{}','ai',?)").run(`HANDOFF-${item.threadId}`,item.threadId,item.customer,now);
 return{sqlite,db,rows:{owned,peer,fallback,legacy,otherCity,forged}};
}

function request(email,path,method="GET",body){const headers={"oai-authenticated-user-email":email};if(body!==undefined){headers.origin=ORIGIN;headers["content-type"]="application/json";}return new Request(`${ORIGIN}${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});}
async function conversations(email,path="/api/conversations?status=open",method="GET",body){const route=await import("../app/api/conversations/route.ts");return route[method](request(email,path,method,body));}

test("conversation list enforces current assignment plus team, service and city scope",async()=>{
 const{rows}=await world();
 const ids=async email=>{const body=await(await conversations(email)).json();return body.data.threads.map(row=>row.id).sort();};
 assert.deepEqual(await ids(OWNER),[rows.fallback.threadId,rows.legacy.threadId,rows.owned.threadId].sort(),"associate sees own work and matching unassigned/legacy queue only");
 assert.deepEqual(await ids(PEER),[rows.fallback.threadId,rows.legacy.threadId,rows.peer.threadId].sort(),"peer cannot inherit another employee's assigned work");
 assert.deepEqual(await ids(SALES_MANAGER),[rows.fallback.threadId,rows.legacy.threadId,rows.owned.threadId,rows.peer.threadId].sort(),"manager sees the matching team/city/service scope");
 assert.deepEqual(await ids(OTHER_CITY_MANAGER),[rows.otherCity.threadId],"same-team manager remains city-scoped");
 assert.deepEqual(await ids(OTHER_TEAM_MANAGER),[rows.forged.threadId],"same-city manager remains team-scoped");
 assert.deepEqual(await ids(ADMIN),Object.values(rows).map(row=>row.threadId).sort(),"admin retains platform-wide operations visibility");
});

test("thread assigned_to is never authority for detail or writes",async()=>{
 const{sqlite,rows}=await world();
 const detail=await conversations(OWNER,`/api/conversations?threadId=${rows.forged.threadId}`);
 assert.equal(detail.status,403);
 assert.ok(!(await detail.text()).includes("private-FORGED"),"denial must not disclose transcript data");
 const before=sqlite.prepare("SELECT status,assigned_to,updated_at FROM communication_threads WHERE id=?").get(rows.forged.threadId);
 const events=Number(sqlite.prepare("SELECT COUNT(*) count FROM conversation_audit_events").get().count);
 const denied=await conversations(OWNER,"/api/conversations","POST",{action:"status",threadId:rows.forged.threadId,status:"closed",reason:"forged ownership must fail"});
 assert.equal(denied.status,403);
 assert.deepEqual(sqlite.prepare("SELECT status,assigned_to,updated_at FROM communication_threads WHERE id=?").get(rows.forged.threadId),before);
 assert.equal(Number(sqlite.prepare("SELECT COUNT(*) count FROM conversation_audit_events").get().count),events,"denied business write creates no conversation event");
 assert.equal(sqlite.prepare("SELECT outcome FROM security_audit_events ORDER BY created_at DESC LIMIT 1").get().outcome,"denied","the blocked mutation is security-audited");
});

test("matching assignment and legacy active-policy fallback retain legitimate detail and mutation",async()=>{
 const{sqlite,rows}=await world();
 for(const threadId of[rows.owned.threadId,rows.legacy.threadId])assert.equal((await conversations(OWNER,`/api/conversations?threadId=${threadId}`)).status,200);
 const updated=await conversations(SALES_MANAGER,"/api/conversations","POST",{action:"status",threadId:rows.peer.threadId,status:"pending_customer",reason:"Awaiting customer details"});
 assert.equal(updated.status,200);
 assert.equal(sqlite.prepare("SELECT status FROM communication_threads WHERE id=?").get(rows.peer.threadId).status,"pending_customer");
});

test("WhatsApp controls and AI handoff queue use the same row policy",async()=>{
 const{sqlite,rows}=await world();
 const whatsapp=await import("../app/api/whatsapp/conversation-control/route.ts");
 const denied=await whatsapp.POST(request(OWNER,"/api/whatsapp/conversation-control","POST",{action:"set_mode",threadId:rows.forged.threadId,mode:"human_only",reason:"Attempt outside owned scope"}));
 assert.equal(denied.status,403);
 const routingTable=sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='whatsapp_conversation_routing_modes'").get();
 assert.equal(routingTable?Number(sqlite.prepare("SELECT COUNT(*) count FROM whatsapp_conversation_routing_modes").get().count):0,0,"denial creates no routing mutation");
 const handoff=await import("../app/api/ai-human-handoff/route.ts");
 const response=await handoff.GET(request(OWNER,"/api/ai-human-handoff?mode=queue"));
 assert.equal(response.status,200);
 const body=await response.json();
 assert.deepEqual(body.data.queue.map(item=>item.threadId),[rows.owned.threadId],"cross-team handoff is absent from both rows and totals");
 assert.deepEqual(body.data.byStatus,{queued:1});
});

test("CRM chat detail applies the same canonical ownership as the inbox list",async()=>{
 const{rows}=await world();
 const crm=await import("../app/api/crm/chat/route.ts");
 const denied=await crm.GET(request(OWNER,`/api/crm/chat?threadId=${rows.forged.threadId}`));
 assert.equal(denied.status,403);
 assert.ok(!(await denied.text()).includes("private-FORGED"));
 const own=await crm.GET(request(OWNER,`/api/crm/chat?threadId=${rows.owned.threadId}`));
 assert.equal(own.status,200,await own.text());
});

test("CRM send and routing actions cannot cross the canonical assignment boundary",async()=>{
 const{sqlite,rows}=await world();
 const crm=await import("../app/api/crm/chat/route.ts");
 const before=sqlite.prepare("SELECT COUNT(*) n FROM communication_messages").get().n;
 for(const action of ['send_message','set_mode','simulate_inbound']){
  const denied=await crm.POST(request(OWNER,"/api/crm/chat","POST",{action,threadId:rows.forged.threadId,customerId:rows.forged.customer,text:'outside assignment',mode:'chatbot_only',reason:'Attempt outside owned scope',clientRequestId:'crm-denied-send'}));
  assert.equal(denied.status,403,`${action}: ${await denied.text()}`);
 }
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_messages").get().n,before);
 const table=sqlite.prepare("SELECT name FROM sqlite_master WHERE name='whatsapp_conversation_routing_modes'").get();
 assert.equal(table?sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_conversation_routing_modes").get().n:0,0);
});

test("CRM retry after a committed send reuses one message and refuses changed content",async()=>{
 const{sqlite,rows}=await world();
 const{makeD1}=await import('./helpers/taxi-harness.mjs');
 const db=makeD1(sqlite);globalThis.__CONVERSATION_SCOPE_DB__=db;
 const{ensureWhatsAppUatTables}=await import('../lib/whatsapp-uat-adapter.ts');
 const{ensureCustomer360Tables}=await import('../lib/customer-360.ts');
 await ensureWhatsAppUatTables(db);await ensureCustomer360Tables(db);
 sqlite.prepare("INSERT INTO customer_contact_preferences (customer_id,whatsapp_consent,updated_by,updated_at) VALUES (?,1,'test',?)").run(rows.owned.customer,Date.now());
 sqlite.prepare("INSERT INTO whatsapp_uat_sessions (customer_id,provider,last_inbound_at) VALUES (?,'meta_whatsapp',?)").run(rows.owned.customer,Date.now());
 const crm=await import('../app/api/crm/chat/route.ts');
 const body={action:'send_message',threadId:rows.owned.threadId,customerId:rows.owned.customer,text:'Confirmed, your request is received',clientRequestId:'crm-stable-request-1'};
 db.onSql('INSERT INTO security_audit_events',()=>{throw new Error('audit temporarily unavailable after message commit');});
 const interrupted=await crm.POST(request(OWNER,'/api/crm/chat','POST',body));
 assert.equal(interrupted.status,500);
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE direction='outbound'").get().n,1);
 const retry=await crm.POST(request(OWNER,'/api/crm/chat','POST',body));
 assert.equal(retry.status,200,await retry.text());
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE direction='outbound'").get().n,1);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM communication_outbox').get().n,1);
 const changed=await crm.POST(request(OWNER,'/api/crm/chat','POST',{...body,text:'Different message'}));
 assert.equal(changed.status,409);
 const languageChange=await crm.POST(request(OWNER,'/api/crm/chat','POST',{...body,language:'kn'}));
 assert.equal(languageChange.status,409);
 const missingKey=await crm.POST(request(OWNER,'/api/crm/chat','POST',{...body,clientRequestId:undefined}));
 assert.equal(missingKey.status,400);
 const{setWhatsAppConversationMode}=await import('../lib/whatsapp-conversation-control.ts');
 await setWhatsAppConversationMode(db,{threadId:rows.owned.threadId,mode:'ai_assistant',actorEmail:OWNER,reason:'AI owns this thread for regression'});
 const aiOwned=await crm.POST(request(OWNER,'/api/crm/chat','POST',{...body,clientRequestId:'crm-another-request'}));
 assert.equal(aiOwned.status,409);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM communication_outbox').get().n,1);
});

test("CRM inbound simulator requires an explicit test environment and cannot create a Meta session",async()=>{
 const{sqlite,rows}=await world();
 const crm=await import('../app/api/crm/chat/route.ts');
 const body={action:'simulate_inbound',threadId:rows.owned.threadId,customerId:rows.owned.customer,text:'Test inbound'};
 for(const env of [{},{PAWSPACE_DEPLOYMENT_ENV:'production',PAWSPACE_PAYMENT_ENV:'sandbox',PAWSPACE_COMMUNICATION_ENV:'uat'},{PAWSPACE_DEPLOYMENT_ENV:'staging',PAWSPACE_PAYMENT_ENV:'live',PAWSPACE_COMMUNICATION_ENV:'uat'}]){
  globalThis.__CONVERSATION_SCOPE_ENV__={...env,PAWSPACE_WORKSPACE_IDENTITY_TRUST:"openai-dispatch"};
  const denied=await crm.POST(request(OWNER,'/api/crm/chat','POST',body));
  assert.equal(denied.status,403,await denied.text());
 }
 globalThis.__CONVERSATION_SCOPE_ENV__={PAWSPACE_WORKSPACE_IDENTITY_TRUST:'openai-dispatch',PAWSPACE_DEPLOYMENT_ENV:'staging',PAWSPACE_PAYMENT_ENV:'sandbox',PAWSPACE_COMMUNICATION_ENV:'uat'};
 const simulated=await crm.POST(request(OWNER,'/api/crm/chat','POST',body));
 assert.equal(simulated.status,201,await simulated.text());
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_uat_sessions WHERE provider='meta_whatsapp'").get().n,0);
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_uat_sessions WHERE provider='sandbox_simulator'").get().n,1);
});
