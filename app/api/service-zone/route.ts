import {resolveZoneByPincode,listServiceZones} from"../../../lib/service-zones";

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

    // GET is READ-ONLY. Seeding default zones is a DB write and must never be reachable through this
    // public, unauthenticated endpoint (/api/service-zone is in the gateway public null-list). The
    // former GET ?action=seed path let anyone INSERT the full zone table via a plain URL — it is
    // removed. Seeding is an operator task run through staff tooling/migrations, not a public GET.
    if(action==="seed")return new Response(JSON.stringify({error:"Seeding is not available on this public endpoint. Run zone seeding through staff tooling."}),{status:405,headers:{"content-type":"application/json","allow":"GET"}});

    return new Response(JSON.stringify({error:"Unknown action"}),{status:400,headers:{"content-type":"application/json"}});
  }catch(e){
    if(e instanceof Response)return e;
    console.error("[api] unhandled error:",e);
    return new Response(JSON.stringify({error:"Unable to resolve the service zone"}),{status:500,headers:{"content-type":"application/json"}});
  }
}
