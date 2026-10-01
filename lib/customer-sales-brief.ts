/** Shared read-only sales preparation. Callers supply already-authorized canonical evidence.
 * No score predicts a purchase; contact eligibility is advisory and must be rechecked at dispatch.
 * This core accepts no demographic, health, income or inferred sensitive-trait fields.
 */
export type SalesReadiness="hot"|"warm"|"cold"|"unknown";
export type SalesEvidence={ref:string;observedAt:number;expiresAt:number;reason:string};
export type SalesIntent=SalesEvidence&{serviceCode:string;kind:"inquiry"|"quote_requested"|"booking_requested"|"not_interested";source:"customer_inquiry"|"customer_message"};
export type SalesOverride=SalesEvidence&{customerId:string;serviceCode:string;dimension:"readiness"|"subscriptionPotential"|"crossSellPotential";value:string;actorId:string;createdAt:number};
export type SalesBriefInput={
 customerId:string;cityId:string;serviceCode:string;asOf:number;
 access:{customerId:string;allowed:boolean;cityId:string|null};
 bookings:Array<{id:string;serviceCode:string;status:string;verifiedPurchase:boolean;observedAt:number}>|null;
 intents:SalesIntent[]|null;
 opportunities:Array<SalesEvidence&{kind:"subscription"|"cross_sell";serviceCode:string;candidate:boolean;eligibility:"eligible"|"ineligible"|"unknown"}>|null;
 contact:{allowed:boolean;reason:string;checkedAt:number;nextEligibleAt:number|null}|null;
 overrides:SalesOverride[];
};
const finite=(value:number)=>Number.isFinite(value)&&value>=0;
const fresh=(e:SalesEvidence,asOf:number)=>Boolean(e.ref.trim()&&e.reason.trim()&&finite(e.observedAt)&&finite(e.expiresAt)&&e.observedAt<=asOf&&e.expiresAt>asOf&&e.expiresAt>e.observedAt);
const readinessValues=new Set(["hot","warm","cold","unknown"]);
export function validateSalesBriefOverride(value:SalesOverride,asOf:number){
 if(!finite(asOf)||!value.customerId.trim()||!value.serviceCode.trim()||!value.actorId.trim()||value.reason.trim().length<8||!value.ref.trim())throw new Error("Override requires customer, service, actor and an explained audit reference");
 if(!finite(value.createdAt)||value.createdAt>asOf||value.observedAt!==value.createdAt||!fresh(value,asOf)||value.expiresAt-value.createdAt>30*86400000)throw new Error("Override requires a current timestamp and expiry within 30 days");
 if(value.dimension==="readiness"?!readinessValues.has(value.value):!["subscriptionPotential","crossSellPotential"].includes(value.dimension)||!["yes","no"].includes(value.value))throw new Error("Unsupported sales override; canonical lifecycle and eligibility cannot be overridden");
 return value;
}
export function buildCustomerSalesBrief(input:SalesBriefInput){
 const {asOf,serviceCode}=input;
 if(!finite(asOf)||!input.customerId||!input.cityId||!serviceCode||!input.access.allowed||input.access.customerId!==input.customerId||(input.access.cityId!==null&&input.access.cityId.toLowerCase()!==input.cityId.toLowerCase()))throw new Error("Customer sales brief is outside authorized scope");
 const contact=input.contact&&finite(input.contact.checkedAt)&&input.contact.checkedAt<=asOf&&asOf-input.contact.checkedAt<=5*60000?input.contact:{allowed:false,reason:"contact_eligibility_unknown_or_stale",checkedAt:asOf,nextEligibleAt:null};
 const purchases=new Map((input.bookings??[]).filter(b=>b.id&&finite(b.observedAt)&&b.observedAt<=asOf&&!["cancelled","draft","refunded"].includes(b.status)&&(b.verifiedPurchase||b.status==="completed")).map(b=>[b.id,b]));
 const lifecycle=input.bookings===null?"unknown":purchases.size>=2?"repeat":purchases.size===1?"existing":"prospect";
 const lifecycleEvidence=[...purchases.values()].map(b=>({ref:b.id,observedAt:b.observedAt,reason:b.status==="completed"?"canonical_fulfillment":"verified_purchase"}));
 const candidates=(input.intents??[]).filter(e=>e.serviceCode===serviceCode&&fresh(e,asOf)&&["customer_inquiry","customer_message"].includes(e.source));
 const latestAt=candidates.length?Math.max(...candidates.map(e=>e.observedAt)):null;
 // A tie prefers the customer's refusal instead of allowing array order to revive selling.
 const latest=latestAt===null?null:candidates.filter(e=>e.observedAt===latestAt).sort((a,b)=>Number(b.kind==="not_interested")-Number(a.kind==="not_interested")||a.ref.localeCompare(b.ref))[0];
 const rawReadiness:SalesReadiness=latest?.kind==="not_interested"?"cold":latest?.kind==="quote_requested"||latest?.kind==="booking_requested"?"hot":latest?"warm":"unknown";
 let readiness={value:rawReadiness,source:"customer_evidence",evidence:latest?[latest]:[] as SalesEvidence[],override:null as SalesOverride|null};
 const activeOverrides=input.overrides.filter(o=>o.customerId===input.customerId&&o.serviceCode===serviceCode).filter(o=>{try{validateSalesBriefOverride(o,asOf);return true;}catch{return false;}}).sort((a,b)=>b.createdAt-a.createdAt||a.ref.localeCompare(b.ref));
 const readinessOverride=activeOverrides.find(o=>o.dimension==="readiness");
 // An observed refusal remains visible and wins until newer customer intent arrives.
 if(readinessOverride&&(!latest||latest.kind!=="not_interested")){
  readiness={value:readinessOverride.value as SalesReadiness,source:"human_override",evidence:latest?[latest]:[],override:readinessOverride};
 }
 const offer=(kind:"subscription"|"cross_sell",dimension:"subscriptionPotential"|"crossSellPotential")=>{
  const evidence=(input.opportunities??[]).filter(o=>o.kind===kind&&o.serviceCode===serviceCode&&fresh(o,asOf)).sort((a,b)=>b.observedAt-a.observedAt||a.ref.localeCompare(b.ref))[0];
  const override=activeOverrides.find(o=>o.dimension===dimension)??null;
  const candidate=override?override.value==="yes":evidence?.candidate??null;
  const eligibility=evidence?.eligibility??"unknown";
  const suppressed=!contact.allowed||latest?.kind==="not_interested";
  return{candidate,eligibility,status:suppressed?"suppressed":candidate===true&&eligibility==="eligible"?"candidate":candidate===false||eligibility==="ineligible"?"not_candidate":"unknown",evidence:evidence?[evidence]:[],override};
 };
 return{customerId:input.customerId,serviceCode,generatedAt:asOf,ruleVersion:"sales_brief_v1",lifecycle:{value:lifecycle,evidence:lifecycleEvidence,basis:"distinct_verified_purchase_or_fulfillment"},readiness,subscriptionPotential:offer("subscription","subscriptionPotential"),crossSellPotential:offer("cross_sell","crossSellPotential"),contact:{...contact,dispatchAuthority:false},context:{bookingRecords:input.bookings?.length??null,inquiryEvidenceAvailable:input.intents!==null,opportunityEvidenceAvailable:input.opportunities!==null},definitions:{readiness:"Current service-specific customer intent or explained human override, not a probability of buying",lifecycle:"Canonical purchase/fulfillment history, separate from lead stage and readiness",offers:"Candidate relevance is separate from governed offer eligibility",contact:"Advisory only; opt-out, frequency, quiet-hours and channel permissions must be rechecked before dispatch"}};
}
