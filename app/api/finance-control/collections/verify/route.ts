import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../../../lib/server-auth";
import{verifyManualCollection} from "../../../../../lib/collection-ledger";

const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin write blocked",{status:403});}
function expectedVersion(request:Request){const raw=String(request.headers.get("if-match")||"").replace(/^W\//,"").replaceAll('"',"").trim();const value=Number(raw);if(!raw||!Number.isFinite(value)||value<0)throw new Response("Finance mutations require an If-Match row version",{status:428});return value;}

export async function POST(request:Request){
 try{
  sameOrigin(request);
  const actor=await resolveActor(request);requirePermission(actor,"finance.manage");
  const version=expectedVersion(request);
  const body=await request.json() as {groupKey?:string;reason?:string};
  const groupKey=String(body.groupKey||"").trim(),reason=String(body.reason||"").trim();
  if(!groupKey||reason.length<5)return json({error:"A collection and reason of at least 5 characters are required"},400);
  const db=await database();
  const result=await verifyManualCollection(db,{groupKey,actorId:actor.email,actorPermissions:actor.permissions,reason,expectedVersion:version});
  await securityAudit(db,actor,"finance.collection.verify","collection_posting",groupKey,"completed",{verificationStatus:result.verificationStatus});
  return json({data:result});
 }catch(error){return authError(error,"Cash collection verification failed");}
}
