import{authError,authorize,database,requirePermission}from"../../../lib/server-auth";
import{buildAiAnalytics,buildAiBookingOutcomes,unavailableAiBookingOutcomes}from"../../../lib/ai-analytics";
import{resolveManagerOrganizationalScope}from"../../../lib/organizational-scope";
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
export async function GET(request:Request){try{const actor=await authorize(request,"reports.view");const url=new URL(request.url),channel=url.searchParams.get("channel"),from=Number(url.searchParams.get("from")||0)||null,to=Number(url.searchParams.get("to")||0)||null,intent=url.searchParams.get("intent")||null;if(channel&&!(["whatsapp","chat","voice"] as string[]).includes(channel))return json({error:"Unsupported channel filter"},400);const db=await database(),filters={from,to,channel:channel as "whatsapp"|"chat"|"voice"|null,intent};
const data=await buildAiAnalytics(db,filters);
// General operational metrics retain their existing permission boundary. New financial outcomes
// require Finance read permission as well as the same city scope used by company analytics.
let bookingOutcomes:Awaited<ReturnType<typeof buildAiBookingOutcomes>>=unavailableAiBookingOutcomes("permission_or_scope");
try{requirePermission(actor,"finance.view");const scope=await resolveManagerOrganizationalScope(db,actor);
bookingOutcomes=await buildAiBookingOutcomes(db,filters,{allowed:true,cityId:scope?.cityId});
}catch{/* No financial source is queried when permission or organizational provisioning fails. */}
return json({data:{...data,bookingOutcomes}});}catch(error){return authError(error,"Unable to load AI analytics");}}
