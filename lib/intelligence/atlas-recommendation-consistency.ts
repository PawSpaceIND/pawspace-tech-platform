type Db=D1Database;type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const parsed=(v:unknown)=>{try{return JSON.parse(text(v)||"null")}catch{return null}};
const stable=(value:unknown):unknown=>Array.isArray(value)?value.map(stable):value&&typeof value==="object"?Object.fromEntries(Object.keys(value as Record<string,unknown>).sort().map(k=>[k,stable((value as Record<string,unknown>)[k])])):value;
const stableJson=(v:unknown)=>JSON.stringify(stable(parsed(v)));
export type AtlasConsistencyGroup={snapshotHash:string;proposalType:string;proposalCount:number;distinctActions:number;distinctStatuses:number;consistent:boolean;basisIds:string[];proposalIds:string[];actions:unknown[];statuses:string[];requiresFounderReview:boolean;advisoryOnly:true;authorityMutationAllowed:false;note:string};
export async function buildAtlasRecommendationConsistency(db:Db,limit=20):Promise<AtlasConsistencyGroup[]>{
 try{await db.prepare("SELECT 1 FROM atlas_proposals LIMIT 1").first()}catch{return[]}
 const cap=Math.max(1,Math.min(100,Math.floor(limit))),rows=(await db.prepare(`SELECT id,proposal_type,snapshot_hash,basis_id,status,action_json,created_at FROM atlas_proposals ORDER BY created_at DESC LIMIT ${Math.max(cap*5,50)}`).all<Row>()).results,groups=new Map<string,Row[]>();
 for(const row of rows){const key=`${text(row.snapshot_hash)}::${text(row.proposal_type)}`;const list=groups.get(key)??[];list.push(row);groups.set(key,list)}
 const result:AtlasConsistencyGroup[]=[];
 for(const list of groups.values()){
  if(list.length<2)continue;
  const actions=[...new Set(list.map(r=>stableJson(r.action_json)))],statuses=[...new Set(list.map(r=>text(r.status)))],basisIds=[...new Set(list.map(r=>text(r.basis_id)))],consistent=actions.length===1;
  result.push({snapshotHash:text(list[0].snapshot_hash),proposalType:text(list[0].proposal_type),proposalCount:list.length,distinctActions:actions.length,distinctStatuses:statuses.length,consistent,basisIds,proposalIds:list.map(r=>text(r.id)),actions:actions.map(a=>JSON.parse(a)),statuses,requiresFounderReview:!consistent,advisoryOnly:true as const,authorityMutationAllowed:false as const,note:consistent?"Equivalent recorded evidence produced the same action payload.":"Equivalent recorded evidence produced different action payloads. Founder review is required before treating either recommendation as a reusable precedent."});
 }
 return result.sort((a,b)=>Number(b.requiresFounderReview)-Number(a.requiresFounderReview)||b.proposalCount-a.proposalCount).slice(0,cap);
}
