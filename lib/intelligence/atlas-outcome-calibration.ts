type Db=D1Database;type Row=Record<string,unknown>;
const num=(v:unknown)=>{const n=Number(v);return Number.isFinite(n)?n:0};
const text=(v:unknown)=>String(v??"").trim();
export const ATLAS_CALIBRATION_MIN_MEASURED=5;
export type AtlasOutcomeCalibration={proposalType:string;measured:number;positive:number;flat:number;negative:number;averageObservedNetDelta:number;usableForReview:boolean;confidenceMutationAllowed:false;causalAttribution:false;note:string};
export async function buildAtlasOutcomeCalibration(db:Db):Promise<AtlasOutcomeCalibration[]>{
 try{await db.prepare("SELECT 1 FROM atlas_proposal_outcomes LIMIT 1").first();}catch{return[]}
 const rows=(await db.prepare("SELECT proposal_type,COUNT(*) measured,SUM(CASE WHEN observed_net_delta>0 THEN 1 ELSE 0 END) positive,SUM(CASE WHEN observed_net_delta=0 THEN 1 ELSE 0 END) flat,SUM(CASE WHEN observed_net_delta<0 THEN 1 ELSE 0 END) negative,AVG(observed_net_delta) average_delta FROM atlas_proposal_outcomes WHERE status='measured' GROUP BY proposal_type ORDER BY measured DESC,proposal_type").all<Row>()).results;
 return rows.map(row=>{const measured=num(row.measured);return{proposalType:text(row.proposal_type),measured,positive:num(row.positive),flat:num(row.flat),negative:num(row.negative),averageObservedNetDelta:num(row.average_delta),usableForReview:measured>=ATLAS_CALIBRATION_MIN_MEASURED,confidenceMutationAllowed:false as const,causalAttribution:false as const,note:measured>=ATLAS_CALIBRATION_MIN_MEASURED?"Observed outcome history is available for human calibration review only; it does not prove causation and does not change Atlas confidence automatically.":`Need at least ${ATLAS_CALIBRATION_MIN_MEASURED} measured outcomes before calibration review; no confidence or policy change is allowed.`};});
}
