import {createDegradationLog} from './degraded-reads';
import {readSalesBriefCentralConsent} from './customer-sales-brief-central-consent';
import {readCustomerSalesPaymentEvidence} from './customer-sales-payment-evidence';
import {hasPermission} from './platform-security';
import {isManagerScopedActor,requireManagerDomain,CRM_MANAGER_DOMAIN,type OrganizationalScope} from './organizational-scope';
import {authFailure,type AuthenticatedActor} from './server-auth';
import {normalizeLeadServiceCode} from './lead-lifecycle-governance';
import {buildCustomerSalesBrief,type SalesBriefInput,type SalesIntent,type SalesOverride} from './customer-sales-brief';
type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??'').trim();
const deny:()=>never=()=>{throw authFailure('Customer sales brief is outside authorized CRM scope',403);};
/** Reused by reads and audited overrides; actor/scope are resolved on the server. */
export async function authorizeCustomerSalesBriefRecord(db:D1Database,input:{actor:AuthenticatedActor;scope:OrganizationalScope|null;customerId:string}){
 if(!hasPermission(input.actor.permissions,'customers.view'))deny();
 if(isManagerScopedActor(input.actor)&&!input.scope)deny();
 requireManagerDomain(input.scope,CRM_MANAGER_DOMAIN);
 const customer=await db.prepare("SELECT id,city_id FROM canonical_customers WHERE id=? AND merged_into IS NULL").bind(input.customerId).first<Row>();
 if(!customer||!text(customer.city_id)||(input.scope&&text(customer.city_id).toLowerCase()!==input.scope.cityId.toLowerCase()))deny();
 if(!hasPermission(input.actor.permissions,'customers.manage')&&!isManagerScopedActor(input.actor)){
  const assigned=await db.prepare("SELECT a.id FROM lead_assignments a JOIN lead_work_items l ON l.id=a.lead_id WHERE l.customer_id=? AND a.status='current' AND lower(a.employee_email)=? LIMIT 1").bind(input.customerId,input.actor.email.toLowerCase()).first<Row>();if(!assigned)deny();
 }
 return customer;
}
/** Evidence reads only: no ensure/DDL, no dispatch, no new tag store or money claims.
 * scope must come from the established authenticated organizational resolver, not request JSON.
 * contactDecision must be a fresh result of canonical channel/contact governance, never a client flag.
 * Missing decision fails closed; current recorded opt-outs still take precedence over a supplied allow.
 */
export async function collectCustomerSalesBrief(db:D1Database,input:{actor:AuthenticatedActor;scope:OrganizationalScope|null;customerId:string;serviceCode:string;asOf:number;contactChannel?:string;contactDecision?:SalesBriefInput['contact']}){
 if(!Number.isFinite(input.asOf)||input.asOf<0)deny();
 const customer=await authorizeCustomerSalesBriefRecord(db,input);
 const serviceCode=normalizeLeadServiceCode(input.serviceCode);if(!serviceCode)throw new Error('Service required');
 const degradation=createDegradationLog();
 const list=(v:unknown):string[]=>{try{const r=JSON.parse(text(v)||'[]');return Array.isArray(r)?r.filter(x=>typeof x==='string'):[];}catch{return degradation.note('sales_brief_list',new Error('Malformed stored list'),[]);}};
 const parse=(v:unknown):Row=>{try{const r=JSON.parse(text(v)||'{}');return r&&typeof r==='object'&&!Array.isArray(r)?r:{};}catch{return degradation.note('sales_brief_detail',new Error('Malformed stored detail'),{});}};
 const sourceStatus:Record<string,string>={};
 const read=async(name:string,sql:string,values:unknown[]=[])=>{try{const r=await db.prepare(sql).bind(...values).all<Row>();sourceStatus[name]='available';return r.results;}catch{sourceStatus[name]='unavailable';return degradation.note(name,new Error('Source read unavailable'),null);}};
 const [recent,fulfilled,dispositions,opportunities,audit,prefs,enginePrefs,leads,subscriptions,centralConsent]=await Promise.all([
  read('recentBookings','SELECT id,service_code,status,scheduled_start,updated_at FROM canonical_bookings WHERE customer_id=? AND (? IS NULL OR lower(city_id)=lower(?)) ORDER BY updated_at DESC,id DESC LIMIT 20',[input.customerId,input.scope?.cityId??null,input.scope?.cityId??null]),
  read('fulfilledHistory',"SELECT id,service_code,status,scheduled_start,updated_at FROM canonical_bookings WHERE customer_id=? AND (? IS NULL OR lower(city_id)=lower(?)) AND status='completed' ORDER BY updated_at DESC,id DESC LIMIT 2",[input.customerId,input.scope?.cityId??null,input.scope?.cityId??null]),
  read('callTags','SELECT d.id,d.primary_tag,d.tags_json,d.contacted,d.opted_out,d.created_at,d.cross_sell_services_json,d.claim_tags_json,d.reconciliation_status,l.service FROM bot_call_dispositions d JOIN lead_work_items l ON l.id=d.lead_id AND l.customer_id=d.contact_id WHERE d.contact_id=? ORDER BY d.created_at DESC,d.id DESC LIMIT 100',[input.customerId]),
  read('opportunities','SELECT id,opportunity_type,service_code,reason,status,updated_at FROM canonical_revenue_opportunities WHERE customer_id=? ORDER BY updated_at DESC,id DESC LIMIT 100',[input.customerId]),
  read('overrides',`SELECT id,action,actor_email,detail_json,created_at FROM (
   SELECT id,action,actor_email,detail_json,created_at,ROW_NUMBER() OVER (
    PARTITION BY json_extract(CASE WHEN json_valid(detail_json) THEN detail_json ELSE '{}' END,'$.dimension')
    ORDER BY created_at DESC,rowid DESC) latest
   FROM crm_engine_audit_events WHERE entity_type='customer' AND entity_id=?
    AND action IN ('sales_brief_override','sales_brief_override_clear')
    AND lower(trim(json_extract(CASE WHEN json_valid(detail_json) THEN detail_json ELSE '{}' END,'$.serviceCode')))=?
    AND json_extract(CASE WHEN json_valid(detail_json) THEN detail_json ELSE '{}' END,'$.dimension') IN ('readiness','subscriptionPotential','crossSellPotential')
  ) WHERE latest=1`,[input.customerId,serviceCode]),
  read('contactPreferences','SELECT opt_out,marketing_consent FROM customer_contact_preferences WHERE customer_id=?',[input.customerId]),
  read('communicationPreferences','SELECT marketing FROM communication_preferences WHERE customer_id=?',[input.customerId]),
  read('leadOptOut','SELECT opt_out FROM lead_work_items WHERE customer_id=?',[input.customerId]),
  read('subscriptions','SELECT id,plan_code,status,started_at,expires_at,sessions_reserved,sessions_consumed,total_sessions FROM customer_grooming_subscriptions WHERE customer_id=? ORDER BY started_at DESC,id DESC LIMIT 20',[input.customerId]),
  readSalesBriefCentralConsent(db,{customerId:input.customerId,channel:input.contactChannel??'voice'}),
 ]);
 const evidence=(ref:string,at:unknown,reason:string)=>({ref,observedAt:Number(at),expiresAt:Number(at)+7*86400000,reason});
 const intents:SalesIntent[]=[];const taggedOpportunities:NonNullable<SalesBriefInput['opportunities']>=[];
 for(const d of dispositions??[]){if(Number(d.contacted)!==1)continue;const tags=new Set([text(d.primary_tag),...list(d.tags_json)]),service=normalizeLeadServiceCode(d.service);
  if(tags.has('not_interested')||tags.has('do_not_call'))intents.push({...evidence(text(d.id),d.created_at,'Recorded customer refusal; not an inferred low score'),serviceCode:service,kind:'not_interested',source:'customer_message'});
  else if(tags.has('interested')||tags.has('callback_requested'))intents.push({...evidence(text(d.id),d.created_at,'Recorded customer interest/callback; no quote, booking or payment verification implied'),serviceCode:service,kind:'inquiry',source:'customer_message'});
  if(tags.has('cross_sell_potential'))for(const target of list(d.cross_sell_services_json))taggedOpportunities.push({...evidence(text(d.id),d.created_at,'Existing service-specific call tag identifies possible relevance; offer eligibility requires governed review'),serviceCode:normalizeLeadServiceCode(target),kind:'cross_sell',candidate:true,eligibility:'unknown'});
 }
 for(const o of opportunities??[]){const kind=text(o.opportunity_type);if(!['subscription','subscription_renewal','cross_sell'].includes(kind))continue;taggedOpportunities.push({...evidence(text(o.id),o.updated_at,text(o.reason)||'Existing governed opportunity'),serviceCode:normalizeLeadServiceCode(o.service_code),kind:kind==='cross_sell'?'cross_sell':'subscription',candidate:['ready','suppressed','review_required'].includes(text(o.status)),eligibility:'unknown'});}
 const overrides:SalesOverride[]=[];const seen=new Set<string>();
 for(const event of audit??[]){const detail=parse(event.detail_json),service=normalizeLeadServiceCode(detail.serviceCode),dimension=text(detail.dimension),key=service+':'+dimension;
  if(service!==serviceCode||seen.has(key)||!['readiness','subscriptionPotential','crossSellPotential'].includes(dimension))continue;seen.add(key);
  if(event.action==='sales_brief_override_clear')continue;
  overrides.push({ref:text(event.id),customerId:input.customerId,serviceCode:service,dimension:dimension as SalesOverride['dimension'],value:text(detail.value),actorId:text(event.actor_email),createdAt:Number(event.created_at),observedAt:Number(event.created_at),expiresAt:Number(detail.expiresAt),reason:text(detail.reason)});
 }
 sourceStatus.centralConsent=centralConsent.status;
 let contact=input.contactDecision??null;
 if(centralConsent.allowed!==true)contact={allowed:false,reason:centralConsent.reason,checkedAt:input.asOf,nextEligibleAt:null};
 const optOut=(prefs??[]).some(p=>Number(p.opt_out)===1)||(enginePrefs??[]).some(p=>Number(p.marketing)===0)||(leads??[]).some(p=>Number(p.opt_out)===1)||(dispositions??[]).some(d=>Number(d.opted_out)===1);
 const consentMissing=!prefs?.length||Number(prefs[0]?.marketing_consent)!==1;
 if(optOut||consentMissing||prefs===null||enginePrefs===null||leads===null||dispositions===null)contact={allowed:false,reason:optOut?'marketing_opt_out':prefs===null||enginePrefs===null||leads===null||dispositions===null?'contact_source_unavailable':'marketing_consent_missing',checkedAt:input.asOf,nextEligibleAt:null};
 const paymentEvidence=await readCustomerSalesPaymentEvidence(db,{permissions:input.actor.permissions,customerId:input.customerId,cityId:text(customer.city_id),scopeCityId:input.scope?.cityId??null,asOf:input.asOf});
 const history=fulfilled===null||recent===null?null:[...new Map([...recent,...fulfilled].map(b=>[text(b.id),{id:text(b.id),serviceCode:normalizeLeadServiceCode(b.service_code),status:text(b.status),verifiedPurchase:false,observedAt:Number(b.updated_at)}])).values()];
 const brief=buildCustomerSalesBrief({customerId:input.customerId,cityId:text(customer.city_id),serviceCode,asOf:input.asOf,access:{allowed:true,customerId:input.customerId,cityId:input.scope?.cityId??null},bookings:history===null?null:[...history,...(paymentEvidence.purchases??[])],intents:dispositions===null?null:intents,opportunities:opportunities===null&&dispositions===null?null:taggedOpportunities,contact,overrides});
 // An unverified/unpaid booking alone cannot establish a purchase or a definitive prospect lifecycle.
 if(brief.lifecycle.value==='prospect'&&recent?.length)brief.lifecycle.value='unknown';
 sourceStatus.paymentHistory=paymentEvidence.status;
 // Existing reconciliations are operational attestations, not structured ledger bindings.
 // Preserve their status for follow-up without promoting a call claim into purchase evidence.
 const claimContext=dispositions?.flatMap(d=>{
  const claims=list(d.claim_tags_json).filter(tag=>tag==='paid'||tag==='converted');
  if(!claims.length)return[];
  const recorded=text(d.reconciliation_status);
  const reconciliationStatus=['pending_reconciliation','reconciled_confirmed','reconciled_not_found'].includes(recorded)?recorded:'unknown';
  return[{ref:text(d.id),serviceCode:normalizeLeadServiceCode(d.service),observedAt:Number(d.created_at),claims,reconciliationStatus,moneyVerified:false,bookingVerified:false,canonicalRecordLink:null}];
 })??null;
 return{...brief,sourceStatus,degradedReads:degradation.entries(),paymentContext:paymentEvidence.records,claimContext,bookingContext:recent?.map(b=>({id:text(b.id),serviceCode:normalizeLeadServiceCode(b.service_code),status:text(b.status),scheduledStart:text(b.scheduled_start)}))??null,subscriptionContext:subscriptions?.map(s=>({id:text(s.id),planCode:text(s.plan_code),status:text(s.status),expiresAt:Number(s.expires_at),active:text(s.status)==='active'&&Number(s.started_at)<=input.asOf&&Number(s.expires_at)>input.asOf}))??null,lifecycleBasis:paymentEvidence.status==='available'?'canonical_fulfillment_or_reconciled_retained_purchase':'canonical_fulfillment_only_payment_unknown'};
}
