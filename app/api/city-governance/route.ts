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
    const saved=await saveCityLaunchConfig(db,input,actor.email);
    await securityAudit(db,actor,"city_launch.save","city_launch_config",saved.id,"completed",{city:saved.city,status:saved.status,version:saved.version});
    return json({data:saved,productionReady:false},201);
  }
  return json({error:"Unsupported city launch action"},400);
}catch(error){return authError(error,"Unable to update city launch governance");}}
