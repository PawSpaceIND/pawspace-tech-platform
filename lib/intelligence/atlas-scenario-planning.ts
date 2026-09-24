import type {AtlasBusinessSnapshot} from "./atlas-business-snapshot";

export type AtlasFounderScenarioInput={scenarioId:string;label:string;bookedDeltaInr:number;collectedDeltaInr:number;refundedDeltaInr:number};
export type AtlasFounderScenarioResult={scenarioId:string;label:string;assumptions:{bookedDeltaInr:number;collectedDeltaInr:number;refundedDeltaInr:number};projected:{booked:number;collected:number;refunded:number;net:number;achieved:number;percent:number;basis:string};changeFromActual:{booked:number;collected:number;refunded:number;net:number;achieved:number;percentPoints:number};forecastOnly:true;causalAttribution:false;probabilityAssigned:false;requiresFounderJudgment:true;approvalMutationAllowed:false;authorityMutationAllowed:false;executionMutationAllowed:false};
export type AtlasFounderScenarioPlan={status:"ready"|"insufficient_data";actual:{target:number;booked:number;collected:number;refunded:number;net:number;achieved:number;percent:number;basis:string}|null;scenarios:AtlasFounderScenarioResult[];limitations:string[];forecastOnly:true;causalAttribution:false;probabilityAssigned:false;approvalMutationAllowed:false;authorityMutationAllowed:false;executionMutationAllowed:false;note:string};
const clean=(v:unknown)=>String(v??"").trim();
const round=(v:number)=>Math.round(v*100)/100;
const finite=(v:number)=>Number.isFinite(v)&&Math.abs(v)<=100_000_000;

export function buildAtlasFounderScenarioPlan(snapshot:AtlasBusinessSnapshot,inputs:AtlasFounderScenarioInput[]):AtlasFounderScenarioPlan{
 const note="Founder scenarios are arithmetic what-if projections from explicit assumptions against the current canonical mission. They are not actuals, probabilities, causal forecasts, approvals, or execution instructions.";
 if(!snapshot.mission.value)return{status:"insufficient_data",actual:null,scenarios:[],limitations:[snapshot.mission.reason||"current_mission_unavailable",...snapshot.limitations],forecastOnly:true,causalAttribution:false,probabilityAssigned:false,approvalMutationAllowed:false,authorityMutationAllowed:false,executionMutationAllowed:false,note};
 if(!Array.isArray(inputs)||inputs.length<1||inputs.length>5)throw new Error("Atlas Founder scenario planning requires between 1 and 5 explicit scenarios");
 const ids=new Set<string>(),m=snapshot.mission.value;
 const scenarios=inputs.map(input=>{
  const scenarioId=clean(input.scenarioId),label=clean(input.label),deltas=[input.bookedDeltaInr,input.collectedDeltaInr,input.refundedDeltaInr];
  if(!scenarioId||!label)throw new Error("Atlas Founder scenarios require an ID and label");
  if(ids.has(scenarioId))throw new Error("Atlas Founder scenario IDs must be unique");ids.add(scenarioId);
  if(!deltas.every(finite))throw new Error("Atlas Founder scenario deltas must be finite and within INR 100,000,000 in magnitude");
  const booked=round(m.booked+input.bookedDeltaInr),collected=round(m.collected+input.collectedDeltaInr),refunded=round(m.refunded+input.refundedDeltaInr);
  if(booked<0||collected<0||refunded<0)throw new Error("Atlas Founder scenario assumptions cannot project canonical money totals below zero");
  const net=round(collected-refunded),achieved=m.basis==="booked"?booked:m.basis==="collected"?collected:net,percent=m.target>0?round((achieved/m.target)*100):0;
  return{scenarioId,label,assumptions:{bookedDeltaInr:input.bookedDeltaInr,collectedDeltaInr:input.collectedDeltaInr,refundedDeltaInr:input.refundedDeltaInr},projected:{booked,collected,refunded,net,achieved,percent,basis:m.basis},changeFromActual:{booked:round(booked-m.booked),collected:round(collected-m.collected),refunded:round(refunded-m.refunded),net:round(net-m.net),achieved:round(achieved-m.achieved),percentPoints:round(percent-m.percent)},forecastOnly:true as const,causalAttribution:false as const,probabilityAssigned:false as const,requiresFounderJudgment:true as const,approvalMutationAllowed:false as const,authorityMutationAllowed:false as const,executionMutationAllowed:false as const};
 });
 return{status:"ready",actual:{target:m.target,booked:m.booked,collected:m.collected,refunded:m.refunded,net:m.net,achieved:m.achieved,percent:m.percent,basis:m.basis},scenarios,limitations:[...snapshot.limitations],forecastOnly:true,causalAttribution:false,probabilityAssigned:false,approvalMutationAllowed:false,authorityMutationAllowed:false,executionMutationAllowed:false,note};
}
