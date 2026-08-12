import{authError,authorize,database}from"../../../lib/server-auth";
import{liveLeaderboard}from"../../../lib/live-leaderboard";
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
export async function GET(request:Request){try{await authorize(request,"self_service.view");const db=await database(),url=new URL(request.url);return json({data:await liveLeaderboard(db,{metric:url.searchParams.get("metric"),monthStart:url.searchParams.get("monthStart")}),productionReady:false});}catch(error){return authError(error,"Unable to load the leaderboard");}}
