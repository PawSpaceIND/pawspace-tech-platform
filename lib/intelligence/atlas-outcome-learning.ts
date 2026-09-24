import {ATLAS_CALIBRATION_MIN_MEASURED, buildAtlasOutcomeCalibration} from "./atlas-outcome-calibration";

export type AtlasOutcomeLearningSignal={
 proposalType:string;
 measured:number;
 positive:number;
 flat:number;
 negative:number;
 positiveRate:number;
 flatRate:number;
 negativeRate:number;
 averageObservedNetDelta:number;
 sampleReady:true;
 causalAttribution:false;
 confidenceMutationAllowed:false;
 policyMutationAllowed:false;
 authorityMutationAllowed:false;
 actionSuppressionAllowed:false;
 note:string;
};

export type AtlasOutcomeLearningContext={
 signals:AtlasOutcomeLearningSignal[];
 minimumMeasured:number;
 usableSignalCount:number;
 secondaryContextOnly:true;
 causalAttribution:false;
 confidenceMutationAllowed:false;
 policyMutationAllowed:false;
 authorityMutationAllowed:false;
 note:string;
};

const rate=(count:number,total:number)=>total>0?Number((count/total).toFixed(4)):0;

export async function buildAtlasOutcomeLearningContext(db:D1Database,options:{proposalTypes?:string[];limit?:number}={}):Promise<AtlasOutcomeLearningContext>{
 const allowed=options.proposalTypes?.length?new Set(options.proposalTypes.map(v=>String(v).trim()).filter(Boolean)):null;
 const calibration=await buildAtlasOutcomeCalibration(db),signals=calibration.filter(row=>row.usableForReview&&(!allowed||allowed.has(row.proposalType))).slice(0,Math.max(1,Math.min(20,options.limit??10))).map(row=>({
  proposalType:row.proposalType,
  measured:row.measured,
  positive:row.positive,
  flat:row.flat,
  negative:row.negative,
  positiveRate:rate(row.positive,row.measured),
  flatRate:rate(row.flat,row.measured),
  negativeRate:rate(row.negative,row.measured),
  averageObservedNetDelta:row.averageObservedNetDelta,
  sampleReady:true as const,
  causalAttribution:false as const,
  confidenceMutationAllowed:false as const,
  policyMutationAllowed:false as const,
  authorityMutationAllowed:false as const,
  actionSuppressionAllowed:false as const,
  note:"Observed historical outcome context only. It may inform human review and model wording, but it does not prove causation, change confidence, alter policy, suppress an otherwise governed action, or grant authority."
 }));
 return{signals,minimumMeasured:ATLAS_CALIBRATION_MIN_MEASURED,usableSignalCount:signals.length,secondaryContextOnly:true,causalAttribution:false,confidenceMutationAllowed:false,policyMutationAllowed:false,authorityMutationAllowed:false,note:"Atlas may use these sample-gated observed outcomes only as secondary historical context after current canonical evidence. Current business truth, policy, consent and approval gates always take precedence."};
}
