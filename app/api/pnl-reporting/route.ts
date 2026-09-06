import{authError,database,requirePermission,resolveActor}from"../../../lib/server-auth";
import{generatePnlReport}from"../../../lib/pnl-reporting";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

function defaultMonths(){
  const now=new Date(),toMonth=`${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,"0")}`;
  const from=new Date(now);from.setUTCMonth(from.getUTCMonth()-11);
  const fromMonth=`${from.getUTCFullYear()}-${String(from.getUTCMonth()+1).padStart(2,"0")}`;
  return{fromMonth,toMonth};
}

export async function GET(request:Request){
  try{
    // A full profit-and-loss statement is finance-restricted data. This route previously read it
    // through a local database() helper with no actor resolution at all, so it answered anyone;
    // every sibling finance surface (gst-accounting, people-finance, partner-finance) authorizes
    // on finance.view, and so does this one now.
    const actor=await resolveActor(request);
    requirePermission(actor,"finance.view");
    const url=new URL(request.url);
    const defaults=defaultMonths();
    const fromMonth=url.searchParams.get("fromMonth")||defaults.fromMonth;
    const toMonth=url.searchParams.get("toMonth")||defaults.toMonth;
    if(!/^\d{4}-\d{2}$/.test(fromMonth)||!/^\d{4}-\d{2}$/.test(toMonth))return json({error:"fromMonth and toMonth must be YYYY-MM"},400);
    if(fromMonth>toMonth)return json({error:"fromMonth must not be after toMonth"},400);
    const db=await database();
    const report=await generatePnlReport(db,{fromMonth,toMonth});
    return json({data:report});
  // authError keeps governed responses intact and redacts everything else, so an unexpected
  // failure can no longer return a raw internal message to an unauthenticated caller.
  }catch(error){return authError(error,"Unable to generate P&L report");}
}
