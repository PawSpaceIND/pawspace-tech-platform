import{authorize,database,securityAudit,authError}from"../../../../lib/server-auth";
import{runDpdpRetentionSweep}from"../../../../lib/dpdp-retention";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin retention sweep blocked",{status:403});}

export async function POST(request:Request){try{sameOrigin(request);const actor=await authorize(request,"data.delete"),db=await database(),data=await runDpdpRetentionSweep(db,{requestedBy:actor.email});await securityAudit(db,actor,"privacy.dpdp.retention_sweep","privacy_retention",String(data.cutoff),data.failed?"blocked":"completed",{processed:data.processed,erased:data.erased,failed:data.failed,remaining:data.remaining,ledgerPreserved:data.ledgerPreserved});return json({data},data.failed?207:200);}catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,"Unable to run DPDP retention sweep");}}
