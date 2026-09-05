export type OutboundLane="human"|"ai"|"hold"|"suppressed";
export type OutboundLifecycle="requested_callback"|"payment_recovery"|"subscription_renewal"|"grooming_renewal"|"fresh_lead"|"dormant_lead"|"reactivation"|"cross_sell"|"no_action";
const POLICY="outbound-orchestrator-v1";
const marketing=new Set<OutboundLifecycle>(["grooming_renewal","fresh_lead","dormant_lead","reactivation","cross_sell"]);
const highIntent=new Set<OutboundLifecycle>(["requested_callback","payment_recovery","subscription_renewal","grooming_renewal"]);
const clamp=(n:number)=>Math.max(0,Math.min(100,Math.round(Number.isFinite(n)?n:0)));
export const isMarketingLifecycle=(l:OutboundLifecycle)=>marketing.has(l);
export function decideOutboundRoute(i:{leadScore?:number;customerScore?:number;ltv?:number;lifecycleCode:OutboundLifecycle;highIntent?:boolean;scaleIntent?:boolean;requestedCallback?:boolean;marketingConsent?:boolean;serviceConsent?:boolean;optedOut?:boolean;coolingUntil?:number|null;phoneAvailable?:boolean;nextBestService?:string|null;asOf?:number}){
 const asOf=i.asOf??Date.now(),reasons:string[]=[];let score=clamp(Math.max(i.leadScore||0,i.customerScore||0));const intent=Boolean(i.highIntent||i.requestedCallback||highIntent.has(i.lifecycleCode));
 const floors:Partial<Record<OutboundLifecycle,number>>={requested_callback:100,payment_recovery:94,subscription_renewal:90,grooming_renewal:84,fresh_lead:55,dormant_lead:42,reactivation:42};score=Math.max(score,floors[i.lifecycleCode]||0);
 if((i.ltv||0)>=15000&&i.nextBestService){score=Math.max(score,82);reasons.push("high_ltv_cross_sell")}
 if(!i.phoneAvailable)return{lane:"suppressed" as const,priorityScore:0,highIntent:intent,reasons:["missing_phone"],policyVersion:POLICY};
 if(i.optedOut)return{lane:"suppressed" as const,priorityScore:0,highIntent:intent,reasons:["dnd_or_opt_out"],policyVersion:POLICY};
 if(i.coolingUntil&&i.coolingUntil>asOf)return{lane:"suppressed" as const,priorityScore:0,highIntent:intent,reasons:["cooling_period_active"],policyVersion:POLICY};
 if(marketing.has(i.lifecycleCode)&&!i.marketingConsent)return{lane:"suppressed" as const,priorityScore:0,highIntent:intent,reasons:["marketing_consent_missing"],policyVersion:POLICY};
 if(!marketing.has(i.lifecycleCode)&&i.serviceConsent===false)return{lane:"suppressed" as const,priorityScore:0,highIntent:intent,reasons:["service_contact_disabled"],policyVersion:POLICY};
 if(intent||score>=80){reasons.push(intent?`high_intent_${i.lifecycleCode}`:"score_80_plus");return{lane:"human" as const,priorityScore:score,highIntent:intent,reasons,policyVersion:POLICY}}
 if(score>=30||i.scaleIntent){reasons.push(i.scaleIntent?"scale_intent":"score_30_79");return{lane:"ai" as const,priorityScore:score,highIntent:intent,reasons,policyVersion:POLICY}}
 return{lane:"hold" as const,priorityScore:score,highIntent:intent,reasons:["below_outbound_threshold"],policyVersion:POLICY};
}
export const OUTBOUND_POLICY_VERSION=POLICY;
