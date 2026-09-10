import {ensurePartnerSettlementTables,createSandboxPayoutInstruction,approveSandboxPayoutInstruction} from '../lib/partner-settlement-governance';
import {ensureSubscriptionWalletTables,mutateSubscriptionWallet} from '../lib/subscription-wallet';
type Env={DB:D1Database};
function check(condition:unknown,message:string):asserts condition{if(!condition)throw new Error(message)}
async function fails(action:()=>Promise<unknown>){try{await action()}catch{return}throw new Error('Expected injected write failure')}
async function run(db:D1Database){
 await ensurePartnerSettlementTables(db);await ensureSubscriptionWalletTables(db);
 const prefix=crypto.randomUUID(),statementId=`S-${prefix}`,subscriptionId=`SUB-${prefix}`,bookingId=`B-${prefix}`,customerId=`C-${prefix}`,now=Date.now();
 await db.prepare("INSERT INTO partner_settlement_statements (id,provider_id,period_code,earned_amount,payable_amount,status,policy_status,approved_by,created_at,updated_at) VALUES (?,?,'2026-09',1000,1000,'approved','approved','approver',?,?)").bind(statementId,`P-${prefix}`,now,now).run();
 const payout=await createSandboxPayoutInstruction(db,{statementId,idempotencyKey:prefix,actor:'maker'});
 const instructionId=String(payout.id);
 await db.prepare("CREATE TRIGGER integrity_payout_failure BEFORE UPDATE ON partner_payout_instruction_approvals BEGIN SELECT RAISE(ABORT,'injected metadata failure'); END").run();
 try{await fails(()=>approveSandboxPayoutInstruction(db,{instructionId,level:1,actor:'checker1'}))}finally{await db.prepare('DROP TRIGGER integrity_payout_failure').run()}
 const payoutAfter=await db.prepare('SELECT p.status,a.level_1_by FROM partner_payout_instructions p JOIN partner_payout_instruction_approvals a ON a.instruction_id=p.id WHERE p.id=?').bind(instructionId).first<{status:string;level_1_by:string|null}>();
 check(payoutAfter?.status==='approval_required'&&payoutAfter.level_1_by===null,'Payout failure left partial approval');
 const eventsAfter=await db.prepare('SELECT COUNT(*) n FROM partner_settlement_events WHERE statement_id=?').bind(statementId).first<{n:number}>();check(eventsAfter?.n===0,'Failed approval committed an event');
 await approveSandboxPayoutInstruction(db,{instructionId,level:1,actor:'checker1'});
 await fails(()=>approveSandboxPayoutInstruction(db,{instructionId,level:2,actor:'checker1'}));
 await approveSandboxPayoutInstruction(db,{instructionId,level:2,actor:'checker2'});
 await db.prepare('CREATE TABLE IF NOT EXISTS canonical_bookings(id TEXT PRIMARY KEY,customer_id TEXT,service_code TEXT,package_code TEXT,status TEXT)').run();
 await db.prepare("INSERT INTO canonical_bookings VALUES (?,?,'grooming','G','completed')").bind(bookingId,customerId).run();
 await db.prepare("INSERT INTO customer_grooming_subscriptions VALUES (?,?,'P','G',5,1,0,'active',?,?,?,'v1',?,?)").bind(subscriptionId,customerId,now,now+86400000,`PUR-${prefix}`,now,now).run();
 await db.prepare("INSERT INTO booking_subscription_usage VALUES (?,?,?, ?,1,0,'reserved',?,?)").bind(`U-${prefix}`,bookingId,customerId,subscriptionId,now,now).run();
 const input={subscriptionId,action:'consume' as const,bookingId,idempotencyKey:`consume-${prefix}`,actorId:customerId};
 await db.prepare("CREATE TRIGGER integrity_wallet_failure BEFORE UPDATE ON customer_grooming_subscriptions BEGIN SELECT RAISE(ABORT,'injected wallet failure'); END").run();
 try{await fails(()=>mutateSubscriptionWallet(db,input))}finally{await db.prepare('DROP TRIGGER integrity_wallet_failure').run()}
 const wallet=await db.prepare('SELECT sessions_reserved,sessions_consumed FROM customer_grooming_subscriptions WHERE id=?').bind(subscriptionId).first<{sessions_reserved:number;sessions_consumed:number}>();
 const usage=await db.prepare('SELECT status FROM booking_subscription_usage WHERE booking_id=?').bind(bookingId).first<{status:string}>();
 check(wallet?.sessions_reserved===1&&wallet.sessions_consumed===0&&usage?.status==='reserved','Failed consume left partial state');
 await mutateSubscriptionWallet(db,input);const replay=await mutateSubscriptionWallet(db,input);check(replay.duplicatePrevented,'Consume retry not idempotent');
 const finalWallet=await db.prepare('SELECT sessions_reserved,sessions_consumed FROM customer_grooming_subscriptions WHERE id=?').bind(subscriptionId).first<{sessions_reserved:number;sessions_consumed:number}>();
 check(finalWallet?.sessions_reserved===0&&finalWallet.sessions_consumed===1,'Consume charged wrong number of credits');
 return{ok:true,payoutRollback:true,distinctCheckers:true,subscriptionRollback:true,subscriptionRetry:true,liveMoney:false};
}
const worker={async fetch(request:Request,env:Env){const path=new URL(request.url).pathname;if(path==='/health')return Response.json({ok:true});if(path!=='/run')return new Response('Not found',{status:404});try{return Response.json(await run(env.DB))}catch(error){return Response.json({ok:false,error:error instanceof Error?error.message:String(error)}, {status:500})}}};

export default worker;
