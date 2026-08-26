import{authError,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{listCityLaunchConfigs,saveCityLaunchConfig,type CityLaunchConfigInput}from"../../../lib/city-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status});
async function database(){const{env}=await import("cloudflare:workers");return env.DB;}
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin write blocked",{status:403});}

export async function GET(request:Request){try{
  const actor=await resolveActor(request);requirePermission(actor,"launch.view");
  const db=await database();
  return json({data:await listCityLaunchConfigs(db),productionReady:false});
}catch(error){return authError(error,"Unable to load city launch governance");}}

export async function POST(request:Request){try{
  sameOrigin(request);
  const actor=await resolveActor(request);requirePermission(actor,"launch.manage");
  const db=await database();
  const body=await request.json() as Record<string,unknown>,action=String(body.action||"");
  if(action==="save_city"){
    const input=body.city as CityLaunchConfigInput;
    let saved;
    try{saved=await saveCityLaunchConfig(db,input,actor.email);}
    catch(error){
      /*
       * A version conflict is the operator's answer, not an internal error. authError below would
       * redact it into "Unable to update city launch governance", which tells somebody who just lost
       * their edit nothing about what happened or what to do. The body names the version they held,
       * the version now stored, and the coverage they need to reload. [PTJA-W3-CC]
       */
      if(error instanceof Response&&error.status>=400&&error.status<500){
        const text=await error.clone().text().catch(()=>"");
        let payload:unknown;try{payload=JSON.parse(text);}catch{payload={error:text||"Save refused"};}
        if(error.status===409)await securityAudit(db,actor,"city_launch.save","city_launch_config",String(input.id??""),"rejected",{reason:"coverage_version_conflict",baseVersion:input.baseVersion??null});
        return json(payload,error.status);
      }
      throw error;
    }
    await securityAudit(db,actor,"city_launch.save","city_launch_config",saved.id,"completed",{city:saved.city,status:saved.status,version:saved.version});
    return json({data:saved,productionReady:false},201);
  }
  return json({error:"Unsupported city launch action"},400);
}catch(error){return authError(error,"Unable to update city launch governance");}}
