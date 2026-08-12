import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{recordAppInstall,identifyInstall,acquisitionFunnelReport,inboundSalesFunnel,runAppFunnelSweep}from"../../../lib/app-to-revenue-funnel";
import{paymentRecoveryReport}from"../../../lib/payment-recovery-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin funnel write blocked",{status:403});}

// The four App-to-Revenue management reports + funnel administration (install ingest / identify / refresh).
export async function GET(request:Request){
  try{
    const db=await database(),actor=await resolveActor(request);requirePermission(actor,"marketing.view");
    const [acq,recovery,inbound]=await Promise.all([acquisitionFunnelReport(db),paymentRecoveryReport(db),inboundSalesFunnel(db)]);
    return json({data:{...acq,paymentRecovery:recovery,inboundSalesFunnel:inbound}});
  }catch(error){return authError(error,"Unable to load acquisition funnel");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const db=await database(),actor=await resolveActor(request);requirePermission(actor,"marketing.manage");
    const body=await request.json().catch(()=>({})) as {action?:string;installId?:string;customerId?:string;source?:string;campaign?:string;os?:string;appVersion?:string};
    const action=String(body.action||"").trim();
    if(action==="record_install"){const data=await recordAppInstall(db,{installId:String(body.installId||""),source:body.source,campaign:body.campaign,os:body.os,appVersion:body.appVersion});return json({data},201);}
    if(action==="identify"){const data=await identifyInstall(db,{installId:String(body.installId||""),customerId:String(body.customerId||"")});return json({data},201);}
    if(action==="refresh"){const data=await runAppFunnelSweep(db,{});await securityAudit(db,actor,"acquisition_funnel.refresh","acquisition_funnel",null,"completed",data as Record<string,unknown>);return json({data},201);}
    return json({error:"Unsupported action. Use record_install | identify | refresh"},400);
  }catch(error){return authError(error,"Unable to update acquisition funnel");}
}
