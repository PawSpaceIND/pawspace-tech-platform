import{database,resolvePrimaryActor,securityAudit}from"../../../../../../lib/server-auth";
import{adminMfaCookie,issuePrivilegedSession,privilegedRole,verifyTotp}from"../../../../../../lib/admin-mfa";

export async function POST(request:Request){
 try{
  const actor=await resolvePrimaryActor(request);
  if(!privilegedRole(actor.roleCode))return Response.json({error:"MFA is only required for privileged staff"},{status:403});
  const db=await database(),body=await request.json().catch(()=>({})) as Record<string,unknown>;
  const user=actor.userId?await db.prepare("SELECT id,mfa_enabled,mfa_secret FROM app_users WHERE id=?").bind(actor.userId).first<Record<string,unknown>>():null;
  if(!user||Number(user.mfa_enabled)!==1||!String(user.mfa_secret||"").trim())return Response.json({error:"MFA enrollment required"},{status:403});
  if(!await verifyTotp(String(user.mfa_secret),String(body.code||"")))return Response.json({error:"Invalid MFA code"},{status:401});
  const session=await issuePrivilegedSession(db,String(user.id));
  await securityAudit(db,{...actor,userId:String(user.id)},"auth.mfa.verify","active_session",session.id,"completed");
  return Response.json({ok:true},{headers:{"cache-control":"no-store","set-cookie":adminMfaCookie(session.token,session.ttlSeconds)}});
 }catch(error){return Response.json({error:error instanceof Error?error.message:"MFA verification failed"},{status:401});}
}
