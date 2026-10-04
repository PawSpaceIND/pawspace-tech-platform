import type {ChatQualificationApproval} from './chat-bounded-qualification';
import type {PlatformSessionActor} from './platform-session';
import type {AuthenticatedActor} from './server-auth';
export type ChatRouteQualification={approval:ChatQualificationApproval;turnKey:string;informationOnly:true};
/** Deployment-only approval: never take these attestations or identity values from a request. */
export async function resolveChatRouteQualification(db:D1Database,env:Record<string,unknown>,actor:AuthenticatedActor,session:PlatformSessionActor|null,body:Record<string,unknown>):Promise<ChatRouteQualification|null>{
 const raw=String(env.PAWSPACE_CHAT_QUALIFICATION_APPROVAL_JSON??'').trim();
 if(!raw){if(body.qualification===true)throw new Response('Chat qualification is not admitted',{status:403});return null;}
 const deny=()=>{throw new Response('Chat qualification scope is not admitted',{status:403});};
 let config;try{config=JSON.parse(raw);}catch{return deny();}
 const a=config?.approval as ChatQualificationApproval|undefined,turns=config?.turns;
 if(env.PAWSPACE_DEPLOYMENT_ENV!=='staging'||env.PAWSPACE_ISOLATED_FINANCE_TEST!=='true'||env.PAWSPACE_FINANCE_TEST_DESCRIPTOR!=='FINANCE-TEST-OPS-GROOMING-01'||actor.developmentPreview||actor.roleCode!=='customer'||!session||session.subjectType!=='customer'||session.subjectId!=='CUS0000'||session.sessionId!==config.sessionId||!a||a.customerId!==session.subjectId||a.billingVerified!==true||a.transportVerified!==true||a.sourceSha!==env.PAWSPACE_STAGING_BUILD_SHA||!config.approvalReceipt||!config.billingReceipt||!config.transportReceipt||!Array.isArray(turns)||turns.length!==a.maxTurns||turns.length<1||turns.length>2||body.mode!=='authenticated'||body.bot||body.start||body.choiceId||body.cancelCallId||body.requestedStart||body.serviceDate||body.bookingId||body.petId||body.serviceCode||body.leadId||body.phone||body.email||body.name||body.customerId&&body.customerId!==a.customerId)return deny();
 if(Date.now()<a.startsAt||Date.now()>=a.expiresAt)return deny();
 const turn=turns.find((item:Record<string,unknown>)=>item?.key===body.idempotencyKey);
 if(!turn||typeof body.message!=='string'||typeof turn.message!=='string'||body.message!==turn.message)return deny();
 const thread=await db.prepare("SELECT customer_id,status FROM communication_threads WHERE id=?").bind(a.threadId).first<{customer_id:string;status:string}>();
 if(!thread||thread.customer_id!==a.customerId||thread.status==='closed')return deny();
 const index=turns.indexOf(turn);
 if(index>0){const prior=await db.prepare("SELECT policy_decision FROM ai_conversation_turns WHERE idempotency_key=? AND customer_id=? AND thread_id=?").bind(`ai:chat-qualification:${a.jobId}:${turns[index-1].key}`,a.customerId,a.threadId).first<{policy_decision:string}>();if(prior?.policy_decision!=='qualification_read_only')return deny();}
 return{approval:Object.freeze({...a}),turnKey:String(turn.key),informationOnly:true};
}
