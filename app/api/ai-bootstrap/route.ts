import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{seedPawspaceAiAssistant}from"../../../lib/pawspace-ai-seed";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin AI bootstrap blocked",{status:403});}

// Control: seed the starter PawSpace assistant grounding (profile + prompt + knowledge + intents).
// One-time bootstrap of defaults; staff then refine each in the Control AI configuration screen where
// the normal maker/checker review applies. Idempotent-by-versioning (re-running supersedes to v2).
export async function POST(request:Request){
  try{
    sameOrigin(request);
    const db=await database(),actor=await resolveActor(request);requirePermission(actor,"settings.manage");
    const body=await request.json().catch(()=>({})) as {checkerEmail?:string};
    const checker=String(body.checkerEmail||"").trim()||actor.email;
    const data=await seedPawspaceAiAssistant(db,{maker:actor.email,checker});
    await securityAudit(db,actor,"ai.bootstrap.seed","ai_configuration",null,"completed",data as Record<string,unknown>);
    return json({data},201);
  }catch(error){return authError(error,"Unable to seed AI assistant grounding");}
}
