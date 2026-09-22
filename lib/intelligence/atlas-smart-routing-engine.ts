import {ATLAS_PROVIDER_VERTICALS} from "./atlas-business-capabilities";

export type AtlasProviderVertical=typeof ATLAS_PROVIDER_VERTICALS[number];
export type AtlasProviderCandidate={
 providerId:string;
 verticals:readonly AtlasProviderVertical[];
 serviceZones:readonly string[];
 active:boolean;
 compliant:boolean;
 available:boolean;
 currentLoad:number;
 maxLoad:number;
 distanceKm:number;
 skillScore:number;
 qualityScore:number;
 acceptanceRate:number;
 recentCancellationRate:number;
};
export type AtlasProviderRank={providerId:string;score:number;reasons:string[]};
export type AtlasProviderAssignmentResult={ranked:AtlasProviderRank[];rejected:Array<{providerId:string;reasons:string[]}>;recommendedProviderId:string|null;explainable:true};

export type AtlasLead={leadId:string;serviceVertical:AtlasProviderVertical;zone:string;intentScore:number;urgencyScore:number;contactabilityScore:number;ageMinutes:number};
export type AtlasLeadOwner={ownerId:string;active:boolean;serviceVerticals:readonly AtlasProviderVertical[];zones:readonly string[];currentOpenLeads:number;maxOpenLeads:number;conversionRate:number;responseSlaRate:number};
export type AtlasLeadRouteResult={leadPriority:number;rankedOwners:Array<{ownerId:string;score:number;reasons:string[]}>;recommendedOwnerId:string|null;explainable:true};

const clamp01=(value:number)=>Math.max(0,Math.min(1,Number.isFinite(value)?value:0));
const boundedDistanceScore=(distanceKm:number)=>1-Math.min(Math.max(distanceKm,0),25)/25;
const normalizedLoad=(current:number,max:number)=>max>0?clamp01(current/max):1;
const round=(value:number)=>Math.round(value*100)/100;
const text=(value:unknown)=>String(value??"").trim();

export function rankAtlasProviders(input:{vertical:AtlasProviderVertical;zone:string;candidates:readonly AtlasProviderCandidate[]}):AtlasProviderAssignmentResult{
 if(!ATLAS_PROVIDER_VERTICALS.includes(input.vertical))throw new Error("Unsupported provider vertical");
 if(!text(input.zone))throw new Error("Provider assignment zone is required");
 const ranked:AtlasProviderRank[]=[],rejected:Array<{providerId:string;reasons:string[]}>=[];
 for(const candidate of input.candidates){
  const hard:string[]=[];
  if(!text(candidate.providerId))hard.push("missing_provider_id");
  if(!candidate.active)hard.push("inactive");
  if(!candidate.compliant)hard.push("non_compliant");
  if(!candidate.available)hard.push("unavailable");
  if(!candidate.verticals.includes(input.vertical))hard.push("vertical_mismatch");
  if(!candidate.serviceZones.includes(input.zone))hard.push("zone_mismatch");
  if(candidate.maxLoad<=0||candidate.currentLoad>=candidate.maxLoad)hard.push("capacity_exhausted");
  if(hard.length){rejected.push({providerId:candidate.providerId,reasons:hard});continue;}
  const capacity=1-normalizedLoad(candidate.currentLoad,candidate.maxLoad);
  const reliability=1-clamp01(candidate.recentCancellationRate);
  const skill=clamp01(candidate.skillScore),quality=clamp01(candidate.qualityScore),acceptance=clamp01(candidate.acceptanceRate),distance=boundedDistanceScore(candidate.distanceKm);
  const score=round(100*(skill*.25+quality*.25+acceptance*.15+capacity*.15+distance*.1+reliability*.1));
  ranked.push({providerId:candidate.providerId,score,reasons:[`skill:${round(skill*100)}`,`quality:${round(quality*100)}`,`acceptance:${round(acceptance*100)}`,`capacity:${round(capacity*100)}`,`proximity:${round(distance*100)}`,`reliability:${round(reliability*100)}`]});
 }
 ranked.sort((a,b)=>b.score-a.score||a.providerId.localeCompare(b.providerId));
 return{ranked,rejected,recommendedProviderId:ranked[0]?.providerId??null,explainable:true};
}

export function routeAtlasLead(input:{lead:AtlasLead;owners:readonly AtlasLeadOwner[]}):AtlasLeadRouteResult{
 const {lead}=input;
 if(!text(lead.leadId)||!text(lead.zone))throw new Error("Lead identity and zone are required");
 const freshness=1-Math.min(Math.max(lead.ageMinutes,0),1440)/1440;
 const leadPriority=round(100*(clamp01(lead.intentScore)*.4+clamp01(lead.urgencyScore)*.3+clamp01(lead.contactabilityScore)*.2+freshness*.1));
 const rankedOwners=input.owners.flatMap(owner=>{
  if(!owner.active||!owner.serviceVerticals.includes(lead.serviceVertical)||!owner.zones.includes(lead.zone)||owner.maxOpenLeads<=0||owner.currentOpenLeads>=owner.maxOpenLeads)return[];
  const capacity=1-normalizedLoad(owner.currentOpenLeads,owner.maxOpenLeads);
  const conversion=clamp01(owner.conversionRate),sla=clamp01(owner.responseSlaRate);
  const score=round(100*(capacity*.4+sla*.35+conversion*.25));
  return[{ownerId:owner.ownerId,score,reasons:[`capacity:${round(capacity*100)}`,`response_sla:${round(sla*100)}`,`conversion:${round(conversion*100)}`]}];
 }).sort((a,b)=>b.score-a.score||a.ownerId.localeCompare(b.ownerId));
 return{leadPriority,rankedOwners,recommendedOwnerId:rankedOwners[0]?.ownerId??null,explainable:true};
}
