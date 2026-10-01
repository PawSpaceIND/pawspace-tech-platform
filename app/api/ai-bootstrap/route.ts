import{authError,database,requirePermission,resolveActor,securityAudit,securityAuditStatement}from"../../../lib/server-auth";
import{seedPawspaceAiAssistant}from"../../../lib/pawspace-ai-seed";
import{seedMayaKnowledge}from"../../../lib/maya-knowledge-base";

import{installGroomingRevisionRuntimeSchema}from"../../../lib/grooming-revision-runtime-schema";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin AI bootstrap blocked",{status:403});}

// Control: seed the starter PawSpace assistant grounding (profile + prompt + knowledge + intents).
// One-time bootstrap of defaults; staff then refine each in the Control AI configuration screen where
// the normal maker/checker review applies. Idempotent-by-versioning (re-running supersedes to v2).
export async function POST(request:Request){
  try{
    sameOrigin(request);
    const db=await database(),actor=await resolveActor(request);requirePermission(actor,"settings.manage");
    const body=await request.json().catch(()=>({})) as {checkerEmail?:string;pack?:string;operation?:string};
    if(body.operation==="install_grooming_revision_schema"){
      if(Object.keys(body).some(key=>key!=="operation"))throw new Response("Schema installation accepts no client approval or seed fields",{status:400});
      if(actor.developmentPreview)throw new Response("Schema installation requires provisioned staff identity",{status:403});
      const data=await installGroomingRevisionRuntimeSchema(db,actor.email,detail=>securityAuditStatement(db,actor,"ai.bootstrap.grooming_schema_install","grooming_revision_schema",null,"completed",detail));
      return json({data},data.status==="intact"?200:201);
    }
    if(body.operation&&body.operation!=="seed")throw new Response("Unsupported AI bootstrap operation",{status:400});
    const checker=String(body.checkerEmail||"").trim()||actor.email;
    // {"pack":"maya"} publishes only the service knowledge entries that changed, leaving the rest as is.
    const data=body.pack==="maya"?{serviceKnowledge:await seedMayaKnowledge(db,{maker:actor.email,checker})}:await seedPawspaceAiAssistant(db,{maker:actor.email,checker});
    await securityAudit(db,actor,"ai.bootstrap.seed","ai_configuration",null,"completed",data as Record<string,unknown>);
    return json({data},201);
  }catch(error){return authError(error,"Unable to seed AI assistant grounding");}
}
