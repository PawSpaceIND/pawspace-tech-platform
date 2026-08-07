import type { PlatformRepository, Provider } from "./domain.js";

export interface AssignmentInput { cityId:string; zoneId:string; serviceCode:string; preferredProviderId?:string; customerRepeatProviderId?:string; }
export interface AssignmentDecision { provider:Provider|null; mode:"automatic"|"offer"|null; offerExpiresAt?:string; explanation:string[]; alternatives:string[]; }

export async function decideAssignment(repository:PlatformRepository,input:AssignmentInput):Promise<AssignmentDecision>{
  const candidates=await repository.listEligibleProviders(input.cityId,input.zoneId,input.serviceCode);
  if(!candidates.length)return {provider:null,mode:null,explanation:["No live provider matches the city, zone and required skill"],alternatives:[]};
  const scored=candidates.map(provider=>({provider,score:provider.qualityScore+(provider.id===input.preferredProviderId?20:0)+(provider.id===input.customerRepeatProviderId?12:0)+(provider.model==="full_time"?5:0)})).sort((a,b)=>b.score-a.score);
  const selected=scored[0]?.provider??null;
  if(!selected)return {provider:null,mode:null,explanation:["No provider passed assignment scoring"],alternatives:[]};
  const mode=selected.model==="full_time"?"automatic":"offer";
  return {provider:selected,mode,offerExpiresAt:mode==="offer"?new Date(Date.now()+3*60_000).toISOString():undefined,explanation:["Skill and city matched","Zone and live status matched",`Quality score ${selected.qualityScore}`,selected.model==="full_time"?"Full-time provider auto-assigned":"Commission provider receives a 3-minute offer"],alternatives:scored.slice(1,4).map(x=>x.provider.id)};
}
