import {canonicalCustomerPhone,samePhoneForms,samePhoneSql} from './customer-phone.ts';
import {normalizeLeadServiceCode} from './lead-lifecycle-governance.ts';
const services=new Set(['grooming','training','boarding','pet_sitting','dog_walking','pet_taxi','fresh_food','vet','funeral']);
const clean=(v,max=200)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const sha=async v=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v))),x=>x.toString(16).padStart(2,'0')).join('');
export class BridgeRefusal extends Error{constructor(code,status=409){super(code);this.code=code;this.status=status;}}
export async function normalizeEnvelope(value,{accountId}){
 if(value?.schemaVersion!==1||value.eventType!=='crm.inquiry.captured'||value.source?.provider!=='exotel'||value.source.accountId!==accountId||!['externalInquiryId','externalCustomerId'].every(k=>clean(value[k]))||!['eventId','inquiryId','occurredAt'].every(k=>clean(value.source[k])))throw new BridgeRefusal('invalid_source_contract',400);
 const occurred=Date.parse(value.source.occurredAt);if(!Number.isFinite(occurred))throw new BridgeRefusal('invalid_source_time',400);
 const expectedKey=JSON.stringify([value.source.provider,value.source.accountId,value.source.eventId]);if(value.idempotencyKey!==expectedKey)throw new BridgeRefusal('source_dedup_key_mismatch',400);
 const suppliedPhone=value.customer?.phoneNormalized;if(typeof suppliedPhone!=='string'||suppliedPhone.length>64)throw new BridgeRefusal('invalid_customer_phone_field',400);
 const phone=canonicalCustomerPhone(suppliedPhone);const name=typeof value.customer?.name==='string'?value.customer.name.trim().slice(0,200):'';
 const service=normalizeLeadServiceCode(value.inquiry?.service??'review');
 const envelope={schemaVersion:1,eventType:value.eventType,idempotencyKey:expectedKey,externalInquiryId:value.externalInquiryId,externalCustomerId:value.externalCustomerId,source:{provider:'exotel',accountId,eventId:value.source.eventId,inquiryId:value.source.inquiryId,occurredAt:new Date(occurred).toISOString()},customer:{phoneNormalized:phone,...(!phone?{unresolvedPhone:suppliedPhone}:{}),name},inquiry:{service},canonicalResolutionRequired:true};
 return {envelope,eventKey:await sha(expectedKey),inquiryKey:await sha(JSON.stringify(['exotel',accountId,value.source.inquiryId])),fingerprint:await sha(JSON.stringify(envelope)),phone,service};
}
export async function canonicalMatches(db,phone){
 if(!phone)return [];
 const rows=await db.prepare(`SELECT DISTINCT id FROM canonical_customers WHERE ${samePhoneSql('primary_phone')} OR ${samePhoneSql('secondary_phone')} ORDER BY id LIMIT 3`).bind(...samePhoneForms(phone),...samePhoneForms(phone)).all();return rows.results.map(r=>r.id);
}
const response=row=>({accepted:true,staged:true,externalInquiryId:row.external_inquiry_id,externalCustomerId:row.external_customer_id,canonicalCustomerId:row.canonical_customer_id,canonicalLeadId:row.canonical_lead_id,state:row.state,reviewReason:row.review_reason,bookingHandoffReady:row.state==='linked',externalEffects:false});
export async function stagePlatformIntake({db,payload,context,now=Date.now()}){
 const n=await normalizeEnvelope(payload,context);
 const prior=await db.prepare('SELECT fingerprint FROM crm_intake_bridge_events WHERE event_key=?').bind(n.eventKey).first();if(prior&&prior.fingerprint!==n.fingerprint)throw new BridgeRefusal('source_event_payload_conflict');
 const existingInquiry=await db.prepare('SELECT service_code FROM crm_intake_bridge_inquiries WHERE inquiry_key=?').bind(n.inquiryKey).first();
 const matches=await canonicalMatches(db,n.phone);
 const reason=existingInquiry&&existingInquiry.service_code!==n.service?'source_service_changed':!n.phone?'phone_invalid':matches.length>1?'customer_identity_ambiguous':!services.has(n.service)?'service_unknown':!context.cityId?'city_scope_unverified':matches.length===0?'canonical_customer_creation_required':null;
 const candidate=matches.length===1?matches[0]:null;
 try{
  await db.batch([
   db.prepare(`INSERT INTO crm_intake_bridge_inquiries(inquiry_key,source,account_id,source_inquiry_id,external_inquiry_id,external_customer_id,phone_normalized,service_code,canonical_customer_id,canonical_lead_id,state,review_reason,created_at) VALUES (?,'exotel',?,?,?,?,?,?,?,NULL,?,?,?) ON CONFLICT(inquiry_key) DO UPDATE SET external_inquiry_id=excluded.external_inquiry_id,external_customer_id=excluded.external_customer_id,phone_normalized=excluded.phone_normalized,state=CASE WHEN ?='source_service_changed' THEN 'review' ELSE crm_intake_bridge_inquiries.state END,review_reason=CASE WHEN ?='source_service_changed' THEN 'source_service_changed' ELSE crm_intake_bridge_inquiries.review_reason END`).bind(n.inquiryKey,context.accountId,n.envelope.source.inquiryId,n.envelope.externalInquiryId,n.envelope.externalCustomerId,n.phone,n.service,candidate,reason?'review':'ready_for_review',reason,now,reason,reason),
   db.prepare(`INSERT INTO crm_intake_bridge_events(event_key,source,account_id,source_event_id,inquiry_key,fingerprint,envelope_json,received_at) VALUES (?,'exotel',?,?,?,?,?,?) ON CONFLICT(event_key) DO UPDATE SET fingerprint=excluded.fingerprint`).bind(n.eventKey,context.accountId,n.envelope.source.eventId,n.inquiryKey,n.fingerprint,JSON.stringify(n.envelope),now)
  ]);
 }catch(e){if(/source_event_payload_conflict|source_inquiry_identity_conflict/.test(e.message))throw new BridgeRefusal(e.message.includes('source_event')?'source_event_payload_conflict':'source_inquiry_identity_conflict');throw e;}
 const row=await db.prepare('SELECT * FROM crm_intake_bridge_inquiries WHERE inquiry_key=?').bind(n.inquiryKey).first();return {...response(row),replay:!!prior,receipt:{eventKey:n.eventKey,fingerprint:n.fingerprint,provider:'exotel',accountId:context.accountId,eventId:n.envelope.source.eventId,inquiryId:n.envelope.source.inquiryId}};
}
// A future existing canonical receiver's acknowledgement is checked against REAL core rows.
// This never creates a customer/lead/contact, schedules a service, or starts routing/communications.
export async function recordCanonicalLink({db,inquiryKey,customerId,leadId,reviewed=false,scope,now=Date.now()}){
 if(!reviewed)throw new BridgeRefusal('canonical_link_review_required',403);
 const row=await db.prepare('SELECT * FROM crm_intake_bridge_inquiries WHERE inquiry_key=?').bind(inquiryKey).first();if(!row)throw new BridgeRefusal('unknown_external_inquiry',404);
 if(scope){const customer=await db.prepare('SELECT city_id FROM canonical_customers WHERE id=?').bind(customerId).first();if(row.source!=='exotel'||row.account_id!==scope.accountId||customer?.city_id!==scope.cityId)throw new BridgeRefusal('canonical_link_scope_denied',403);}
 if(row.review_reason==='source_service_changed')throw new BridgeRefusal('source_service_review_required');
 if(row.canonical_lead_id&&(row.canonical_lead_id!==leadId||row.canonical_customer_id!==customerId))throw new BridgeRefusal('canonical_link_conflict');
 const matches=await canonicalMatches(db,row.phone_normalized);if(matches.length!==1||matches[0]!==customerId)throw new BridgeRefusal('customer_identity_review_required');
 const lead=await db.prepare('SELECT customer_id,service,lifecycle_state,initiated_booking_id,converted_booking_id FROM lead_work_items WHERE id=?').bind(leadId).first();
 if(!lead||lead.customer_id!==customerId||!services.has(row.service_code)||normalizeLeadServiceCode(lead.service)!==row.service_code||['dropped','converted'].includes(lead.lifecycle_state)||lead.converted_booking_id||lead.initiated_booking_id)throw new BridgeRefusal('booking_origin_not_verified');
 const prior=await db.prepare('SELECT inquiry_key FROM crm_intake_bridge_inquiries WHERE canonical_lead_id=? AND inquiry_key<>?').bind(leadId,inquiryKey).first();if(prior)throw new BridgeRefusal('canonical_lead_already_bound');
 const forms=samePhoneForms(row.phone_normalized),predicate=`(${samePhoneSql('primary_phone')} OR ${samePhoneSql('secondary_phone')})`;
 try{const applied=await db.prepare(`UPDATE crm_intake_bridge_inquiries SET canonical_customer_id=?,canonical_lead_id=?,state='linked',review_reason=NULL,linked_at=COALESCE(linked_at,?) WHERE inquiry_key=? AND (canonical_lead_id IS NULL OR canonical_lead_id=?) AND service_code=? AND COALESCE(review_reason,'')<>'source_service_changed' AND (SELECT COUNT(*) FROM canonical_customers WHERE ${predicate})=1 AND EXISTS(SELECT 1 FROM canonical_customers WHERE id=? AND ${predicate}) AND EXISTS(SELECT 1 FROM lead_work_items WHERE id=? AND customer_id=? AND service=? AND lifecycle_state NOT IN ('dropped','converted') AND initiated_booking_id IS NULL AND converted_booking_id IS NULL)${scope?" AND source='exotel' AND account_id=? AND EXISTS(SELECT 1 FROM canonical_customers WHERE id=? AND city_id=?) AND EXISTS(SELECT 1 FROM crm_intake_bridge_events WHERE inquiry_key=? AND source='exotel' AND account_id=?)":""}`).bind(customerId,leadId,now,inquiryKey,leadId,row.service_code,...forms,...forms,customerId,...forms,...forms,leadId,customerId,lead.service,...(scope?[scope.accountId,customerId,scope.cityId,inquiryKey,scope.accountId]:[])).run();if(Number(applied.meta?.changes)!==1)throw new BridgeRefusal('canonical_link_conflict');}
 catch(e){if(/UNIQUE constraint/.test(e.message))throw new BridgeRefusal('canonical_lead_already_bound');throw e;}
 const linked=await db.prepare('SELECT * FROM crm_intake_bridge_inquiries WHERE inquiry_key=?').bind(inquiryKey).first();if(linked.canonical_lead_id!==leadId||linked.canonical_customer_id!==customerId)throw new BridgeRefusal('canonical_link_conflict');return response(linked);
}
export async function verifiedBookingHandoff({db,inquiryKey,scope}){
 const row=await db.prepare('SELECT * FROM crm_intake_bridge_inquiries WHERE inquiry_key=?').bind(inquiryKey).first();if(row?.state!=='linked'||!row.canonical_lead_id)throw new BridgeRefusal('canonical_lead_link_required');
 await recordCanonicalLink({db,inquiryKey,customerId:row.canonical_customer_id,leadId:row.canonical_lead_id,reviewed:true,scope,now:row.linked_at});
 return {customerId:row.canonical_customer_id,leadId:row.canonical_lead_id,serviceCode:row.service_code,threadId:null,externalInquiryId:row.external_inquiry_id,bookingCreated:false};
}
