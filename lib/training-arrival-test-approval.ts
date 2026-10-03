import {uatCustomerTestingEnabled,UAT_CUSTOMER_PERSONAS,UAT_CUSTOMER_SOURCE} from './uat-customer-testing';
import {governedJsonError} from './governed-http-error';
type Row=Record<string,unknown>;
const deny=(message:string)=>governedJsonError({error:message,code:'training_arrival_simulation_denied'},403);
export async function ensureTrainingArrivalApprovals(db:D1Database){await db.prepare("CREATE TABLE IF NOT EXISTS training_arrival_test_approvals (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,customer_id TEXT NOT NULL,approved_by TEXT NOT NULL,reason TEXT NOT NULL,expires_at INTEGER NOT NULL,used_key TEXT,used_at INTEGER,created_at INTEGER NOT NULL)").run();}
async function runtime(request:Request|undefined){const{env}=await import('cloudflare:workers');if(!request||!uatCustomerTestingEnabled(request,env as unknown as Record<string,unknown>))throw deny('Arrival simulation is restricted to explicitly enabled isolated staging test access');}
async function fixture(db:D1Database,sessionId:string){
 const row=await db.prepare("SELECT s.id session_id,s.booking_id,s.provider_id,b.customer_id,b.status booking_status,s.status,c.source,c.primary_phone FROM training_sessions s JOIN canonical_bookings b ON b.id=s.booking_id JOIN canonical_customers c ON c.id=b.customer_id WHERE s.id=? AND b.service_code='dog_training'").bind(sessionId).first<Row>();
 const persona=UAT_CUSTOMER_PERSONAS.find(p=>p.id===String(row?.customer_id));
 if(!row||!persona||row.source!==UAT_CUSTOMER_SOURCE||String(row.primary_phone)!==persona.phone||['cancelled','completed','refunded','failed','expired'].includes(String(row.booking_status)))throw deny('This session is not an active approved synthetic Training customer fixture');
 return row;
}
export async function approveTrainingArrivalTest(db:D1Database,input:{request:Request;sessionId:string;providerId:string;reason:string;actorId:string}){
 await runtime(input.request);const row=await fixture(db,input.sessionId);if(row.provider_id!==input.providerId)throw deny('Synthetic session provider changed');if(input.reason.trim().length<8)throw governedJsonError({error:'A clear fixture-test approval reason is required'},400);
 await ensureTrainingArrivalApprovals(db);const id=`TRSIM-${crypto.randomUUID()}`,now=Date.now(),expiresAt=now+3600000;
 await db.prepare('INSERT INTO training_arrival_test_approvals (id,session_id,booking_id,provider_id,customer_id,approved_by,reason,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(id,row.session_id,row.booking_id,row.provider_id,row.customer_id,input.actorId,input.reason.trim(),expiresAt,now).run();
 return{approvalId:id,expiresAt,sessionId:input.sessionId,providerId:input.providerId,label:'Sandbox simulation — not a physical visit',physicalVisitVerified:false};
}
export async function trainingArrivalSimulationGuard(db:D1Database,input:{request?:Request;sessionId:string;providerId:string;approvalId:string;reason:string;idempotencyKey:string}){
 await runtime(input.request);const row=await fixture(db,input.sessionId);await ensureTrainingArrivalApprovals(db);
 const a=await db.prepare('SELECT * FROM training_arrival_test_approvals WHERE id=?').bind(input.approvalId).first<Row>();
 if(!a||a.session_id!==input.sessionId||a.booking_id!==row.booking_id||a.customer_id!==row.customer_id||a.provider_id!==input.providerId||row.provider_id!==input.providerId||Number(a.expires_at)<=Date.now()||a.used_key)throw deny('The scoped arrival-test approval is missing, expired, used or belongs to another fixture');
 if(input.reason.trim().length<8)throw governedJsonError({error:'A clear simulation reason is required'},400);
 const sql="EXISTS(SELECT 1 FROM training_arrival_test_approvals a JOIN training_sessions s ON s.id=a.session_id JOIN canonical_bookings b ON b.id=s.booking_id JOIN canonical_customers c ON c.id=b.customer_id WHERE a.id=? AND a.session_id=? AND a.provider_id=? AND s.provider_id=a.provider_id AND b.id=a.booking_id AND b.service_code='dog_training' AND b.customer_id=a.customer_id AND c.source=? AND c.primary_phone=? AND a.used_key IS NULL AND a.expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))";
 const binds=[input.approvalId,input.sessionId,input.providerId,UAT_CUSTOMER_SOURCE,String(row.primary_phone)];
 return{sql,binds,statement:db.prepare(`UPDATE training_arrival_test_approvals SET used_key=?,used_at=? WHERE id=? AND ${sql}`).bind(input.idempotencyKey,Date.now(),input.approvalId,...binds),approvalId:input.approvalId,label:'Sandbox simulation — not a physical visit'};
}
export async function availableTrainingArrivalSimulation(db:D1Database,input:{request:Request;sessionId:string;providerId:string}){
 const none={eligible:false,approvalId:null as string|null,label:null as string|null};try{await runtime(input.request);await fixture(db,input.sessionId);const table=await db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='training_arrival_test_approvals'").first();if(!table)return none;const a=await db.prepare('SELECT id FROM training_arrival_test_approvals WHERE session_id=? AND provider_id=? AND used_key IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1').bind(input.sessionId,input.providerId,Date.now()).first<Row>();return a?{eligible:true,approvalId:String(a.id),label:'Sandbox simulation — not a physical visit'}:none;}catch(error){if(error instanceof Response&&error.status===403)return none;throw error;}
}
