import{database,resolveActor,securityAudit}from"../../../../../lib/server-auth";
import{clearAdminMfaCookie,revokeAllPrivilegedSessions}from"../../../../../lib/admin-mfa";

export async function POST(request:Request){
 try{
  const actor=await resolveActor(request);
  if(!actor.userId)return Response.json({error:"Privileged identity unavailable"},{status:403});
  const db=await database(),result=await revokeAllPrivilegedSessions(db,actor.userId,"revoke_all_sessions");
  await securityAudit(db,actor,"auth.sessions.revoke_all","app_user",actor.userId,"completed",result);
  return Response.json({ok:true,...result},{headers:{"cache-control":"no-store","set-cookie":clearAdminMfaCookie()}});
 }catch(error){if(error instanceof Response)return error;return Response.json({error:"Unauthorized"},{status:401,headers:{"cache-control":"no-store"}});}
}
