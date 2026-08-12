import{authError,authorize,database,resolveActor,requirePermission,securityAudit}from"../../../lib/server-auth";
import{recordFuneralConvertedOrder,setFuneralManualGstMode,funeralManualOrderDirectory}from"../../../lib/funeral-manual-order";

type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin funeral write blocked",{status:403});}

export async function GET(request:Request){try{await authorize(request,"finance.view");const db=await database();return json({data:await funeralManualOrderDirectory(db),productionReady:false});}catch(error){return authError(error,"Unable to load funeral orders");}}

export async function POST(request:Request){try{sameOrigin(request);const actor=await resolveActor(request);requirePermission(actor,"finance.manage");const db=await database();const body=await request.json() as Row,action=text(body.action);let result:unknown;
 if(action==="record_order")result=await recordFuneralConvertedOrder(db,{customerName:text(body.customerName),phone:text(body.phone),paymentMethod:text(body.paymentMethod),orderValue:Number(body.orderValue),orderDate:text(body.orderDate),note:text(body.note)||undefined,actorId:actor.email});
 else if(action==="set_gst")result=await setFuneralManualGstMode(db,{enabled:Boolean(body.enabled),gstRate:body.gstRate==null?undefined:Number(body.gstRate),actorId:actor.email});
 else return json({error:"Unknown funeral-manual-order action"},400);
 await securityAudit(db,actor,`funeral_manual_order.${action}`,"funeral_manual_order",null,"completed");
 return json({data:result,productionReady:false});}catch(error){return authError(error,"Funeral order update failed");}}
