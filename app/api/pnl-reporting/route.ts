import{generatePnlReport}from"../../../lib/pnl-reporting";
import{authError,authorize}from"../../../lib/server-auth";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
async function database(){const{env}=await import("cloudflare:workers");return env.DB;}

function defaultMonths(){
  const now=new Date(),toMonth=`${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,"0")}`;
  const from=new Date(now);from.setUTCMonth(from.getUTCMonth()-11);
  const fromMonth=`${from.getUTCFullYear()}-${String(from.getUTCMonth()+1).padStart(2,"0")}`;
  return{fromMonth,toMonth};
}

export async function GET(request:Request){
  try{
    await authorize(request,"finance.view");
    const url=new URL(request.url);
    const defaults=defaultMonths();
    const fromMonth=url.searchParams.get("fromMonth")||defaults.fromMonth;
    const toMonth=url.searchParams.get("toMonth")||defaults.toMonth;
    if(!/^\d{4}-\d{2}$/.test(fromMonth)||!/^\d{4}-\d{2}$/.test(toMonth))return json({error:"fromMonth and toMonth must be YYYY-MM"},400);
    if(fromMonth>toMonth)return json({error:"fromMonth must not be after toMonth"},400);
    const db=await database();
    const report=await generatePnlReport(db,{fromMonth,toMonth});
    return json({data:report});
  }catch(error){return authError(error,"Unable to generate P&L report");}
}
