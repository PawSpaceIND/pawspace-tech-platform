import {ensureTrainingHomeworkReceipts,trainingHomeworkRevision,type TrainingHomework} from "./training-homework-receipt";
type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"");
/** Bounded list-only readback. No dispatch, acknowledgement, expiry sweep or ownership mutation. */
export async function trainingListReadback(db:D1Database,sessions:readonly Row[],providerId:string,{homework=false}:{homework?:boolean}={}){
 if(sessions.length>200)throw new Error("Training list readback exceeds its route limit");
 const assignments=new Map<string,Record<string,unknown>|null>(),homeworkReceipts=new Map<string,TrainingHomework>();
 if(!sessions.length)return{assignments,homeworkReceipts};
 const inputs=await Promise.all(sessions.map(async session=>({id:text(session.id),bookingId:text(session.booking_id),customerId:text(session.customer_id),...homework?await trainingHomeworkRevision(session.homework_json):{text:"",revision:null}})));
 const schema=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('canonical_bookings','provider_assignment_offers','training_assignment_chains','training_assignment_attempts','training_broadcast_offers','training_session_recovery_cases','training_sessions','training_homework_receipts')").all<Row>();
 const tables=new Set(schema.results.map(r=>text(r.name))),legacy=tables.has('canonical_bookings')&&tables.has('provider_assignment_offers');
 if(homework&&!tables.has('training_homework_receipts'))await ensureTrainingHomeworkReceipts(db);
 const replacement=tables.has('training_session_recovery_cases')&&tables.has('training_sessions');
 const chains=tables.has('training_assignment_chains'),broadcasts=tables.has('training_broadcast_offers');
 if(broadcasts&&!chains)throw new Error('Training broadcast assignment schema is incomplete');
 // Optional-table fragments come only from the fixed schema inventory, never request SQL.
 const rows=(await db.prepare(`WITH input AS (SELECT json_extract(value,'$.id') id,json_extract(value,'$.bookingId') booking_id,json_extract(value,'$.customerId') customer_id,json_extract(value,'$.revision') revision FROM json_each(?))
 SELECT i.id,${replacement?"EXISTS(SELECT 1 FROM training_session_recovery_cases r JOIN training_sessions s ON s.id=r.session_id WHERE r.session_id=i.id AND r.booking_id=i.booking_id AND r.recovery_type='replacement' AND r.status='resolved' AND r.replacement_provider_id=? AND s.booking_id=r.booking_id AND s.provider_id=r.replacement_provider_id)":"0"} replaced,
 ${chains?"c.state chain_state,c.ops_due_at":"NULL chain_state,NULL ops_due_at"},
 ${broadcasts?"bo.booking_id broadcast_booking,bo.status broadcast_status,bo.session_id broadcast_session,bo.expires_at broadcast_expiry":"NULL broadcast_booking,NULL broadcast_status,NULL broadcast_session,NULL broadcast_expiry"},
 ${legacy?"b.id canonical_booking,b.provider_id canonical_provider,o.group_id offer_group,o.provider_id offer_provider,o.status offer_status,o.attempt_no,o.expires_at,o.response_reason":"NULL canonical_booking,NULL canonical_provider,NULL offer_group,NULL offer_provider,NULL offer_status,NULL attempt_no,NULL expires_at,NULL response_reason"},
 ${legacy&&tables.has('training_assignment_attempts')?"EXISTS(SELECT 1 FROM training_assignment_attempts a WHERE a.booking_id=i.booking_id AND a.provider_id=?)":"0"} prior_attempt,
 ${homework?"h.acknowledged_at":"NULL acknowledged_at"}
 FROM input i
 ${chains?"LEFT JOIN training_assignment_chains c ON c.booking_id=i.booking_id":""}
 ${broadcasts?"LEFT JOIN training_broadcast_offers bo ON bo.booking_id=i.booking_id AND bo.provider_id=?":""}
 ${legacy?"LEFT JOIN canonical_bookings b ON b.id=i.booking_id AND b.service_code='dog_training' LEFT JOIN provider_assignment_offers o ON o.group_id=b.schedule_group_id":""}
 ${homework?"LEFT JOIN training_homework_receipts h ON h.session_id=i.id AND h.customer_id=i.customer_id AND h.revision=i.revision":""}
 `).bind(JSON.stringify(inputs),...replacement?[providerId]:[],...legacy&&tables.has('training_assignment_attempts')?[providerId]:[],...broadcasts?[providerId]:[]).all<Row>()).results;
 const bySession=new Map(rows.map(row=>[text(row.id),row])),now=Date.now();
 for(const session of sessions){
  const id=text(session.id),row=bySession.get(id)!;
  if(Number(row.replaced)){assignments.set(id,null);continue;}
  if(broadcasts&&['broadcast_pending','broadcast_accepted','needs_operations'].includes(text(row.chain_state))){
   if(!row.broadcast_booking)throw new Response('Training broadcast recipient access denied',{status:403});
   assignments.set(id,{state:row.broadcast_status==='pending'?(Number(row.broadcast_expiry)<=now?'expired':'open'):row.broadcast_status,providerId,sessionId:text(row.broadcast_session),expiresAt:Number(row.broadcast_expiry),canDecline:row.broadcast_status==='pending'&&Number(row.broadcast_expiry)>now,broadcast:true,externalDelivery:false});continue;
  }
  if(!row.canonical_booking||!row.offer_group){assignments.set(id,null);continue;}
  if(text(row.canonical_provider)!==providerId&&!Number(row.prior_attempt))throw new Response('Training assignment ownership denied',{status:403});
  const state=text(row.offer_provider)!==providerId?'withdrawn':row.chain_state==='needs_operations'?'needs_operations':row.offer_status==='pending'?(Number(row.expires_at)<=now||row.chain_state!==null&&Number(row.ops_due_at)<=now?'expired':'open'):row.offer_status==='accepted'?'accepted':'withdrawn';
  assignments.set(id,{state,providerId,attemptNo:Number(row.attempt_no),expiresAt:Number(row.expires_at),opsDueAt:row.chain_state!==null?Number(row.ops_due_at):null,reason:text(row.response_reason)||null,notificationStatus:'not_dispatched',externalDelivery:false,canDecline:state==='open'&&Number(row.attempt_no)>0});
 }
 if(homework)for(const input of inputs){const row=bySession.get(input.id)!,acknowledged=row.acknowledged_at!==null;homeworkReceipts.set(input.id,{text:input.text,revision:input.revision,status:!input.revision?'unavailable':acknowledged?'acknowledged':'available',acknowledgedAt:acknowledged?Number(row.acknowledged_at):null});}
 return{assignments,homeworkReceipts};
}
