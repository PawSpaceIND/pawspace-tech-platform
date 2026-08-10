import{listServiceControls}from"../../../lib/service-control";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

export async function GET(){
  try{
    const{env}=await import("cloudflare:workers");
    const services=await listServiceControls(env.DB);
    // Customer-safe subset only: no internal disable reason, no audit metadata.
    const data=services.map(service=>({code:service.code,name:service.name,group:service.group,enabled:service.enabled}));
    return json({data});
  }catch(error){return json({error:error instanceof Error?error.message:"Unable to load service availability"},500);}
}
