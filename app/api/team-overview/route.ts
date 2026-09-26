import{authError,database,requirePermission,resolveActor}from"../../../lib/server-auth";
import{hasPermission}from"../../../lib/platform-security";
import{uatLoginEnabled}from"../../../lib/uat-staging-auth";
import{buildTeamOverview}from"../../../lib/team-overview";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

/**
 * A customer or partner who opens a Team page in the same browser has no staff sign-in: the staff
 * sign-in outranks their session, so their session is all there is. Say that, and where staff sign in,
 * instead of a bare "Permission denied". Still a 403, and nothing else about the refusal changes.
 */
async function staffSignInRequired(roleCode:string){
  const{env}=await import("cloudflare:workers");
  const signInUrl=uatLoginEnabled(env as Record<string,unknown>)?"/staging-login":"";
  const who=roleCode==="customer"?"a customer":"a PawSpace partner";
  return json({error:`You are signed in as ${who} in this browser, not as PawSpace staff. Sign in with a staff account to use the Team workspace.`,code:"staff_sign_in_required",...(signInUrl?{signInUrl}:{})},403);
}

// The Team home front door's counters, derived from canonical tables (never static literals).
// Read-only. dashboard.view is the base staff permission the API gateway already applies here.
export async function GET(request:Request){
  try{
    const db=await database(),actor=await resolveActor(request);
    if(!hasPermission(actor.permissions,"dashboard.view")&&(actor.roleCode==="customer"||actor.roleCode==="service_provider"))return staffSignInRequired(actor.roleCode);
    requirePermission(actor,"dashboard.view");
    return json({data:await buildTeamOverview(db,{actorEmail:actor.email,actorName:actor.name,roleCode:actor.roleCode,permissions:actor.permissions})});
  }catch(error){return authError(error,"Unable to load the Team overview");}
}
