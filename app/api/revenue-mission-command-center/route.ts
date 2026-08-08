import{authError,authorize,database}from"../../../lib/server-auth";
import{buildRevenueMissionCommandCenter}from"../../../lib/revenue-mission-command-center";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

export async function GET(request:Request){try{await authorize(request,"reports.view");const db=await database(),url=new URL(request.url),missionId=String(url.searchParams.get("missionId")||"").trim()||undefined,asOf=url.searchParams.get("asOf")?Number(url.searchParams.get("asOf")):undefined;return json(await buildRevenueMissionCommandCenter(db,{missionId,asOf}));}catch(error){return authError(error,"Unable to load Revenue Mission Command Center");}}
