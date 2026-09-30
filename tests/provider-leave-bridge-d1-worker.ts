import {seedBridgeWorld} from "./provider-leave-bridge-fixture";
import {requestLeave,decideLeave} from "../lib/attendance-leave";
type Row=Record<string,unknown>;
const first=(db:D1Database,sql:string,...args:unknown[])=>db.prepare(sql).bind(...args).first<Row>();
function assert(v:unknown,message:string):asserts v{if(!v)throw new Error(message);}
async function fail(work:Promise<unknown>){try{await work;}catch{return;}throw new Error("Expected failure");}
const request=(db:D1Database)=>requestLeave(db,{employeeId:"EMP-P",leaveCode:"CL",startDate:"2030-10-05",endDate:"2030-10-05",units:1,reason:"Synthetic family leave",actorId:"provider@test"});
const decide=(db:D1Database,id:string,decision:'approved'|'rejected')=>decideLeave(db,{requestId:id,decision,reason:"Synthetic manager decision",actorId:"manager@test"});
export async function runBridgeRegression(db:D1Database){
 await seedBridgeWorld(db);
 await db.prepare("CREATE TRIGGER fail_create BEFORE INSERT ON provider_recovery_cases BEGIN SELECT RAISE(ABORT,'injected creation failure'); END").run();
 await fail(request(db));
 assert(Number((await first(db,"SELECT COUNT(*) n FROM leave_requests"))?.n)===0,"creation failure must roll back leave request");
 assert(Number((await first(db,"SELECT COUNT(*) n FROM provider_unavailability"))?.n)===0,"creation failure must roll back dispatch block");
 await db.prepare("DROP TRIGGER fail_create").run();
 const a=await request(db),b=await request(db);
 assert(b.providerLeave?.recoveryCasesOpened===1,"each overlapping request owns a recovery");
 await db.prepare("CREATE TRIGGER fail_reject BEFORE UPDATE ON provider_unavailability BEGIN SELECT RAISE(ABORT,'injected rejection failure'); END").run();
 await fail(decide(db,a.id,'rejected'));
 assert((await first(db,"SELECT status FROM leave_requests WHERE id=?",a.id))?.status==='pending',"failed cleanup must roll back rejection");
 assert(Number((await first(db,"SELECT COUNT(*) n FROM leave_decision_events WHERE request_id=?",a.id))?.n)===0,"failed cleanup must roll back decision reason");
 await db.prepare("DROP TRIGGER fail_reject").run();await decide(db,a.id,'rejected');
 assert((await first(db,"SELECT status FROM provider_leave_blocks WHERE request_id=?",a.id))?.status==='rejected',"rejection retry clears block");
 assert((await first(db,"SELECT status FROM provider_recovery_cases WHERE json_extract(detail_json,'$.leaveRequestId')=?",b.id))?.status==='open',"rejecting one request preserves other recovery");
 await db.prepare("CREATE TRIGGER fail_approve BEFORE INSERT ON booking_customer_notifications BEGIN SELECT RAISE(ABORT,'injected approval failure'); END").run();
 await fail(decide(db,b.id,'approved'));
 assert((await first(db,"SELECT status FROM leave_requests WHERE id=?",b.id))?.status==='pending',"notification failure must roll back approval");
 assert(Number((await first(db,"SELECT balance FROM employee_leave_balances WHERE employee_id='EMP-P'"))?.balance)===10,"failed approval leaves balance intact");
 assert(Number((await first(db,"SELECT COUNT(*) n FROM leave_decision_events WHERE request_id=?",b.id))?.n)===0,"failed approval leaves no reason");
 assert(Number((await first(db,"SELECT COUNT(*) n FROM leave_ledger_events"))?.n)===0,"failed approval leaves no debit");
 assert(Number((await first(db,"SELECT COUNT(*) n FROM booking_customer_notifications"))?.n)===0,"failed approval leaves no partial notifications");
 await db.prepare("DROP TRIGGER fail_approve").run();const approved=await decide(db,b.id,'approved');
 assert(approved.providerLeave?.notificationsQueued===2,"second overlapping leave escalates its own recovery");
 assert(Number((await first(db,"SELECT balance FROM employee_leave_balances WHERE employee_id='EMP-P'"))?.balance)===9,"approval debits once");
 assert((await first(db,"SELECT reason FROM leave_decision_events WHERE request_id=?",b.id))?.reason==='Synthetic manager decision',"decision reason retained");
 await fail(decide(db,b.id,'approved'));
 assert(Number((await first(db,"SELECT COUNT(*) n FROM booking_customer_notifications"))?.n)===2,"replay queues no duplicate notifications");

 const c=await request(db);let changed=false;
 const raceDb=new Proxy(db,{get(target,key){if(key!=="prepare"){const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}return(sql:string)=>{const wrap=(st:D1PreparedStatement):D1PreparedStatement=>new Proxy(st,{get(statement,method){if(method==='bind')return(...args:unknown[])=>wrap(statement.bind(...args));if(method==='all')return async()=>{const rows=await statement.all();if(!changed&&sql.startsWith('SELECT id,booking_id FROM provider_recovery_cases')){changed=true;await db.prepare("UPDATE provider_recovery_cases SET status='resolved' WHERE json_extract(detail_json,'$.leaveRequestId')=?").bind(c.id).run();}return rows;};const value=Reflect.get(statement,method);return typeof value==='function'?value.bind(statement):value;}});return wrap(target.prepare(sql));};}});
 await fail(decide(raceDb,c.id,'approved'));
 assert(changed,"recovery race injected after actual read");
 assert((await first(db,"SELECT status FROM leave_requests WHERE id=?",c.id))?.status==='pending',"stale recovery cannot commit leave decision");
 assert(Number((await first(db,"SELECT balance FROM employee_leave_balances WHERE employee_id='EMP-P'"))?.balance)===9,"stale recovery cannot debit leave");
 assert(Number((await first(db,"SELECT COUNT(*) n FROM booking_customer_notifications"))?.n)===2,"stale recovery cannot queue outdated notification");
 await decide(db,c.id,'approved');
 assert(Number((await first(db,"SELECT COUNT(*) n FROM booking_customer_notifications"))?.n)===2,"fresh approval preserves resolved Operations recovery");
 assert(Number((await first(db,"SELECT COUNT(*) n FROM attendance_snapshot_checks"))?.n)===0,"assertion rows cleaned up");
 return{ok:true,passed:["creation rollback", "independent overlapping recovery ownership", "rejection cleanup rollback and retry", "approval notification rollback and retry", "single debit and immutable reason", "notification replay prevention", "stale Operations recovery snapshot refusal"]};
}
const worker={async fetch(request:Request,env:{DB:D1Database}){if(new URL(request.url).pathname==='/health')return new Response('ok');try{return Response.json(await runBridgeRegression(env.DB));}catch(error){return Response.json({ok:false,error:String(error),stack:error instanceof Error?error.stack:null},{status:500});}}};

export default worker;
