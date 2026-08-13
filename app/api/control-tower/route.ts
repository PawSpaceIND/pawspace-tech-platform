import{authError,authorize,database}from"../../../lib/server-auth";
import{buildControlTower}from"../../../lib/control-tower";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

// Live governance posture for the Control Tower screen (/control). Read-only.
export async function GET(request:Request){
  try{
    // Read-only governance posture across cases, money, filings and the audit trail: "audit.view" is
    // the existing permission for exactly that, held by admin, finance and auditor.
    await authorize(request,"audit.view");
    const url=new URL(request.url),db=await database();
    const asOfParam=url.searchParams.get("asOf"),asOf=asOfParam?Number(asOfParam):undefined;
    const data=await buildControlTower(db,{asOf:Number.isFinite(asOf)?asOf:undefined});
    return json({data});
  }catch(error){return authError(error,"Unable to load the control tower");}
}
