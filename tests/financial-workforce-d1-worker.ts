import {ensureAttendanceLeaveTables,decideLeave} from "../lib/attendance-leave";
import {ensureFuneralMemorialTables,mutateFuneralCase} from "../lib/funeral-memorial-governance";
import {ensureCollectionLedgerTables} from "../lib/collection-ledger";
import {ensureSecurityTables} from "../lib/server-auth";
import {upsertIdentityBinding} from "../lib/identity-binding";
import {issuePlatformSession,platformSessionCookie} from "../lib/platform-session";
import {POST} from "../app/api/funeral-memorial/route";

type Row=Record<string,unknown>;
type Env={DB:D1Database;NODE_ENV?:string;PAWSPACE_PAYMENT_ENV?:string};
function assert(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
const first=(db:D1Database,sql:string,...args:unknown[])=>db.prepare(sql).bind(...args).first<Row>();
async function refused(work:Promise<unknown>,status?:number){try{await work;}catch(error){if(status!==undefined)assert(error instanceof Response&&error.status===status,`expected refusal ${status}, got ${String(error)}`);return;}throw new Error("Expected refusal");}
// Only the timing of reads is controlled. SQL and atomic batches run in native local D1.
function rendezvous(db:D1Database,pattern:string,count=2){let reads=0,release:()=>void=()=>{};const ready=new Promise<void>(r=>{release=r;});return new Proxy(db,{get(target,key){if(key!=="prepare"){const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}return(sql:string)=>{const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(st,k){if(k==="bind")return(...args:unknown[])=>wrap(st.bind(...args));if(k==="first")return async()=>{const row=await st.first();if(sql.includes(pattern)&&reads<count){reads++;if(reads===count)release();await ready;}return row;};const value=Reflect.get(st,k);return typeof value==="function"?value.bind(st):value;}});return wrap(target.prepare(sql));};}});}
async function seedLeave(db:D1Database,prefix:string,balance:number,allowNegative=0){
 await db.batch([
  db.prepare("INSERT INTO leave_policies (id,name,version,status,leave_code,allow_negative,effective_from,created_by,created_at) VALUES (?,?,1,'active_uat',?,?,0,'fixture',0)").bind(prefix,prefix,prefix,allowNegative),
  db.prepare("INSERT INTO employee_leave_balances VALUES (?,?,?,0)").bind(prefix,prefix,balance),
  ...["a","b"].map((suffix,index)=>db.prepare("INSERT INTO leave_requests (id,employee_id,leave_code,start_date,end_date,units,reason,requested_by,created_at) VALUES (?,?,?, ?,?,1,'synthetic request',?,0)").bind(`${prefix}-${suffix}`,prefix,prefix,`2026-10-0${index+2}`,`2026-10-0${index+2}`,prefix)),
 ]);
}
const decide=(db:D1Database,id:string,decision:'approved'|'rejected'='approved')=>decideLeave(db,{requestId:id,decision,reason:"UAT integrity test",actorId:"checker"});
async function seedPayment(db:D1Database,id:string){await db.batch([
 db.prepare("INSERT INTO funeral_cases (id,customer_id,pet_name,pet_species,pickup_address,service_type,created_at,updated_at) VALUES (?,'synthetic','Mia','cat','test only','cremation',0,0)").bind(id),
 db.prepare("INSERT INTO funeral_payments (id,case_id,amount,updated_at) VALUES (?,?,1000,0)").bind(`payment-${id}`,id),
]);}
const pay=(db:D1Database,id:string,extra:Record<string,unknown>={})=>mutateFuneralCase(db,{caseId:id,action:"record_payment",actorId:"synthetic-customer",...extra});
async function paymentFacts(db:D1Database,id:string){return{payment:await first(db,"SELECT * FROM funeral_payments WHERE case_id=?",id),invoice:await first(db,"SELECT COUNT(*) n FROM funeral_invoices WHERE case_id=?",id),journal:await first(db,"SELECT COUNT(*) n,SUM(debit) debit,SUM(credit) credit FROM finance_journal_entries WHERE payment_id=?",`payment-${id}`),marker:await first(db,"SELECT COUNT(*) n FROM collection_ledger_postings WHERE payment_id=?",`payment-${id}`),event:await first(db,"SELECT COUNT(*) n FROM funeral_events WHERE case_id=? AND event_type='payment_recorded'",id)};}
async function run(db:D1Database){
 const passed:string[]=[];
 await ensureAttendanceLeaveTables(db);await ensureFuneralMemorialTables(db);await ensureCollectionLedgerTables(db);
 await db.prepare("UPDATE funeral_service_config SET enabled=1,cash_allowed=1 WHERE service_type='cremation'").run();
 await seedLeave(db,"limited",1);
 const limitedDb=rendezvous(db,"SELECT * FROM leave_requests");
 const outcomes=await Promise.allSettled([decide(limitedDb,"limited-a"),decide(limitedDb,"limited-b")]);
 assert(outcomes.filter(x=>x.status==='fulfilled').length===1,"Only one distinct approval may use the last day");
 assert(Number((await first(db,"SELECT balance FROM employee_leave_balances WHERE employee_id='limited'"))?.balance)===0,"leave balance is zero");
 assert(Number((await first(db,"SELECT SUM(units) total FROM leave_ledger_events WHERE employee_id='limited'"))?.total)===-1,"only one leave debit");passed.push("distinct leave requests cannot overspend one day");
 await seedLeave(db,"negative",1,1);
 const synced=rendezvous(db,"SELECT * FROM leave_requests");
 await Promise.all([decide(synced,"negative-a"),decide(synced,"negative-b")]);
 assert(Number((await first(db,"SELECT balance FROM employee_leave_balances WHERE employee_id='negative'"))?.balance)===-1,"explicit negative policy preserves both debits");passed.push("explicit negative policy remains supported without lost updates");
 await seedLeave(db,"decision",2);
 const decisionDb=rendezvous(db,"SELECT * FROM leave_requests");
 const decisions=await Promise.allSettled([decide(decisionDb,"decision-a"),decide(decisionDb,"decision-a","rejected")]);
 assert(decisions.filter(x=>x.status==='fulfilled').length===1,"approve versus reject has one decision");
 const decision=await first(db,"SELECT status FROM leave_requests WHERE id='decision-a'");
 const ledger=await first(db,"SELECT COUNT(*) n FROM leave_ledger_events WHERE source_request_id='decision-a'");
 assert(Number(ledger?.n)===(decision?.status==='approved'?1:0),"decision matches its ledger");passed.push("approve/reject race cannot overwrite a committed decision");
 await seedLeave(db,"replay",2);const replayDb=rendezvous(db,"SELECT * FROM leave_requests");
 await Promise.allSettled([decide(replayDb,"replay-a"),decide(replayDb,"replay-a")]);
 assert(Number((await first(db,"SELECT balance FROM employee_leave_balances WHERE employee_id='replay'"))?.balance)===1,"same leave replay one debit");passed.push("same leave request cannot debit twice");
 await seedLeave(db,"missing",2);await db.prepare("DELETE FROM leave_policies WHERE id='missing'").run();await refused(decide(db,"missing-a"),409);passed.push("missing leave policy refuses approval");
 await seedLeave(db,"leave-rollback",2);
 await db.prepare("CREATE TRIGGER fault_leave BEFORE UPDATE OF status ON leave_requests WHEN OLD.id='leave-rollback-a' BEGIN SELECT RAISE(ABORT,'injected_leave_failure'); END").run();
 await refused(decide(db,"leave-rollback-a"));
 assert((await first(db,"SELECT status FROM leave_requests WHERE id='leave-rollback-a'"))?.status==='pending'&&Number((await first(db,"SELECT balance FROM employee_leave_balances WHERE employee_id='leave-rollback'"))?.balance)===2&&Number((await first(db,"SELECT COUNT(*) n FROM leave_ledger_events WHERE source_request_id='leave-rollback-a'"))?.n)===0,"leave failure rolls back decision, balance and ledger");
 await db.prepare("DROP TRIGGER fault_leave").run();await decide(db,"leave-rollback-a");passed.push("native D1 leave failure rolls back decision and debit; retry succeeds");
 await seedPayment(db,"repeated");const paymentDb=rendezvous(db,"SELECT * FROM funeral_payments WHERE case_id=");
 await Promise.all([pay(paymentDb,"repeated",{amount:1000}),pay(paymentDb,"repeated",{amount:1000})]);
 await pay(db,"repeated",{amount:1000});
 const facts=await paymentFacts(db,"repeated");
 assert(facts.payment?.status==='paid'&&Number(facts.invoice?.n)===1&&Number(facts.event?.n)===1&&Number(facts.marker?.n)===1&&Number(facts.journal?.n)===2&&Number(facts.journal?.debit)===1000&&Number(facts.journal?.credit)===1000,"payment retries have exactly one balanced collection and invoice");passed.push("concurrent and sequential payment retries have one balanced journal");
 for(const amount of [1,-1,0,NaN,Infinity,"1000",null])await refused(pay(db,"repeated",{amount}),409);
 passed.push("caller amount cannot override stored quote, including paid replay");
 await refused(mutateFuneralCase(db,{caseId:"repeated",action:"set_service_amount",actorId:"finance",amount:2000}),409);
 assert(Number((await first(db,"SELECT amount FROM funeral_payments WHERE case_id='repeated'"))?.amount)===1000,"paid amount is immutable");passed.push("paid quote cannot be reopened by repricing");
 await seedPayment(db,"cash");await pay(db,"cash",{paymentMode:"cash_uat"});
 assert((await first(db,"SELECT verification_status FROM collection_ledger_postings WHERE payment_id='payment-cash'"))?.verification_status==='pending_finance_verification',"cash retains existing finance verification policy");passed.push("cash remains pending Finance verification");
 await seedPayment(db,"rollback");
 let injected=false;
 // A database trigger faults after the payment UPDATE and invoice INSERT, inside the real batch.
 await db.prepare("CREATE TRIGGER fault_collection BEFORE INSERT ON collection_ledger_postings WHEN NEW.payment_id='payment-rollback' BEGIN SELECT RAISE(ABORT,'injected_collection_failure'); END").run();
 try{await pay(db,"rollback");}catch(error){injected=String(error).includes("injected_collection_failure");}
 assert(injected,"injected collection failure reached");
 const rolled=await paymentFacts(db,"rollback");
 assert(rolled.payment?.status==='due'&&Number(rolled.invoice?.n)===0&&Number(rolled.event?.n)===0&&Number(rolled.marker?.n)===0&&Number(rolled.journal?.n)===0,"payment, invoice, event and journal roll back together");
 await db.prepare("DROP TRIGGER fault_collection").run();await pay(db,"rollback");passed.push("native D1 collection failure rolls back all payment effects and retry succeeds");
 await seedPayment(db,"quote-race");
 // Change the quote after its read, before the atomic assertion executes.
 let changed=false;
 const quoteDb=new Proxy(db,{get(target,key){if(key==="prepare")return(sql:string)=>{const wrap=(st:D1PreparedStatement):D1PreparedStatement=>new Proxy(st,{get(statement,method){if(method==="bind")return(...args:unknown[])=>wrap(statement.bind(...args));if(method==="first")return async()=>{const row=await statement.first();if(!changed&&sql==='SELECT * FROM funeral_payments WHERE case_id=?'){changed=true;await target.prepare("UPDATE funeral_payments SET amount=1200 WHERE case_id='quote-race'").run();}return row;};const value=Reflect.get(statement,method);return typeof value==="function"?value.bind(statement):value;}});return wrap(target.prepare(sql));};const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}});
 await refused(pay(quoteDb,"quote-race",{amount:1000}),409);assert((await paymentFacts(db,"quote-race")).payment?.status==='due',"stale quote remains unpaid");passed.push("repricing between read and payment refuses stale amount");
 await ensureSecurityTables(db);
 const binding=await upsertIdentityBinding(db,{identitySource:"customer_otp",principalType:"identity_subject",principalKey:"synthetic",subjectType:"customer",subjectId:"synthetic",actorId:"test",reason:"native D1 payment ownership proof"});
 const session=await issuePlatformSession(db,{bindingId:String(binding?.id),identitySource:"customer_otp",principalType:"identity_subject",principalKey:"synthetic",subjectType:"customer",subjectId:"synthetic"});
 const cookie=platformSessionCookie(session.token,session.ttlSeconds).split(";")[0];
 const post=(body:Record<string,unknown>,signed=true)=>POST(new Request("https://api.pawspace.test/api/funeral-memorial",{method:"POST",headers:{"content-type":"application/json",...(signed?{cookie}:{})},body:JSON.stringify(body)}));
 await seedPayment(db,"route");
 assert((await post({action:"pay_online_sandbox",caseId:"route",amount:1})).status===409,"route rejects underpayment");
 assert((await post({action:"pay_online_sandbox",caseId:"route",amount:1000},false)).status===401,"anonymous route payment denied");
 await seedPayment(db,"other-customer");await db.prepare("UPDATE funeral_cases SET customer_id='other' WHERE id='other-customer'").run();
 assert((await post({action:"pay_online_sandbox",caseId:"other-customer",amount:1000})).status===403,"cross-customer route payment denied");
 const routePayments=await Promise.all([post({action:"pay_online_sandbox",caseId:"route",amount:1000}),post({action:"pay_online_sandbox",caseId:"route",amount:1000})]);
 assert(routePayments.every(response=>response.status===200),`route retries succeed: ${routePayments.map(r=>r.status)}`);
 assert((await post({action:"pay_cash",caseId:"route",amount:1000})).status===200,"cross-mode paid retry stays read-only");
 const routeFacts=await paymentFacts(db,"route");assert(Number(routeFacts.marker?.n)===1&&Number(routeFacts.journal?.n)===2&&routeFacts.payment?.payment_mode==='internal_uat',"route retries do not repost or change payment instrument");
 passed.push("real authenticated route rejects underpayment and cross-customer access; retry posts once");
 return{ok:true,passed,nativeD1:true};
}
const worker={async fetch(request:Request,env:Env){if(env.NODE_ENV!=="test")return new Response("Test worker only",{status:403});const path=new URL(request.url).pathname;if(path==='/health')return Response.json({ok:true});try{
 if(path==='/guard'){
  for(const action of ['pay_cash','pay_online_sandbox','record_payment']){const response=await POST(new Request('https://synthetic.invalid/api/funeral-memorial',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,caseId:'missing'})}));assert(response.status===403,`${action} must fail closed before database/auth mutation`);}
  const tables=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%'").all();assert(tables.results.length===0,"disabled payment route must not create tables");return Response.json({ok:true,disabledBeforeWrites:true});
 }
 if(path!=='/run')return new Response("Not found",{status:404});return Response.json(await run(env.DB));
 }catch(error){return Response.json({ok:false,error:error instanceof Error?error.message:String(error),stack:error instanceof Error?error.stack:null},{status:500});}}};

export default worker;
