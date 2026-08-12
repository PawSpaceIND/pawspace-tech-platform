import {resolveZoneByPincode,listServiceZones,seedDefaultZones} from"../../../lib/service-zones";

type Db=D1Database;

async function ensureDb():Promise<Db>{
  const{env}=await import("cloudflare:workers");
  return(env as{DB:Db}).DB;
}

export async function GET(request:Request):Promise<Response>{
  const url=new URL(request.url);
  const pincode=url.searchParams.get("pincode");
  const action=url.searchParams.get("action")||"resolve";

  try{
    const db=await ensureDb();

    if(action==="resolve"){
      if(!pincode)return new Response(JSON.stringify({error:"Pincode required"}),{status:400,headers:{"content-type":"application/json"}});

      const result=await resolveZoneByPincode(db,pincode);
      if(!result)return new Response(JSON.stringify({error:"Zone not found for this pincode"}),{status:404,headers:{"content-type":"application/json"}});

      return new Response(JSON.stringify({data:result,productionReady:false}),{status:200,headers:{"content-type":"application/json"}});
    }

    if(action==="list"){
      const zones=await listServiceZones(db);
      return new Response(JSON.stringify({data:zones,productionReady:false}),{status:200,headers:{"content-type":"application/json"}});
    }

    if(action==="seed"){
      await seedDefaultZones(db);
      return new Response(JSON.stringify({message:"Default zones seeded",productionReady:false}),{status:200,headers:{"content-type":"application/json"}});
    }

    return new Response(JSON.stringify({error:"Unknown action"}),{status:400,headers:{"content-type":"application/json"}});
  }catch(e){
    const message=e instanceof Error?e.message:String(e);
    return new Response(JSON.stringify({error:message}),{status:500,headers:{"content-type":"application/json"}});
  }
}
