import type {Customer360Record} from"./customer-360";

export type RevenueAction={id:string;customerId:string;opportunityType:string;reason:string;score:number;expectedRevenue:number;expectedMargin:null;confidence:number;owner:string;preferredChannel:"whatsapp"|"sms"|"email"|"call";status:"ready"|"suppressed";suppressionReasons:string[];signals:Record<string,unknown>;scoringMode:"uat_rules_v1";estimateOnly:true;marginStatus:"configuration_required"};

const serviceGaps=(record:Customer360Record)=>{
  const used=new Set(record.bookings.map(item=>item.serviceCode));
  return ["grooming","dog_training","boarding","pet_sitting","dog_walking"].filter(code=>!used.has(code));
};

function preferredChannel(record:Customer360Record):RevenueAction["preferredChannel"]{
  if(record.consent.whatsapp)return"whatsapp";
  if(record.consent.sms)return"sms";
  if(record.consent.email&&record.email)return"email";
  return"call";
}

export function rankRevenueActions(records:Customer360Record[],now=Date.now()):RevenueAction[]{
  const actions:RevenueAction[]=[];
  for(const record of records){
    const lastEnd=record.lastServiceAt?Date.parse(record.lastServiceAt):0;
    const recencyDays=lastEnd?Math.max(0,Math.floor((now-lastEnd)/86_400_000)):999;
    const frequency=record.bookings.filter(item=>!['cancelled','refunded'].includes(item.status)).length;
    const monetary=record.lifetimeValue;
    const gaps=serviceGaps(record);
    const unresolvedRefund=record.tickets.some(item=>item.status!=="resolved"&&/refund|payment/i.test(`${item.category} ${item.subject}`));
    const recentComplaint=record.tickets.some(item=>item.status!=="resolved"&&/quality|complaint|safety|incident/i.test(`${item.category} ${item.subject}`));
    const suppressionReasons:string[]=[];
    if(!record.consent.marketing)suppressionReasons.push("marketing_consent_missing");
    if(unresolvedRefund)suppressionReasons.push("unresolved_refund_or_payment_issue");
    if(recentComplaint)suppressionReasons.push("open_complaint_or_safety_issue");
    if(record.dataQuality.issues.includes("possible_duplicate"))suppressionReasons.push("duplicate_review_required");
    if(record.dataQuality.score<60)suppressionReasons.push("customer_data_quality_low");
    const baseScore=Math.min(99,Math.max(1,Math.round((frequency*10)+(Math.min(monetary,50000)/1000)+(recencyDays>60?18:recencyDays>30?10:3)+(gaps.length*3))));
    const expectedRevenue=Math.max(0,Math.round(Math.min(8000,600+(frequency*220)+(Math.min(monetary,30000)*0.04)+(gaps.length*350))));
    const confidence=Math.max(0.35,Math.min(0.95,(record.dataQuality.score/100)*0.7+Math.min(frequency,5)*0.05));
    const opportunityType=recencyDays>60?"win_back":gaps.length?"cross_sell":"repeat_due";
    const reason=recencyDays>60?`No completed service for ${recencyDays} days`:gaps.length?`Service gap: ${gaps.slice(0,2).join(', ')}`:"Repeat service opportunity from canonical history";
    actions.push({id:`REV-CANON-${record.customerId}`,customerId:record.customerId,opportunityType,reason,score:baseScore,expectedRevenue,expectedMargin:null,confidence:Number(confidence.toFixed(2)),owner:record.owner||"Unassigned",preferredChannel:preferredChannel(record),status:suppressionReasons.length?"suppressed":"ready",suppressionReasons,signals:{recencyDays,frequency,monetaryValue:monetary,serviceGaps:gaps,openTickets:record.openTicketCount,dataQualityScore:record.dataQuality.score},scoringMode:"uat_rules_v1",estimateOnly:true,marginStatus:"configuration_required"});
  }
  return actions.sort((a,b)=>{if(a.status!==b.status)return a.status==="ready"?-1:1;return b.score-a.score||b.expectedRevenue-a.expectedRevenue;});
}
