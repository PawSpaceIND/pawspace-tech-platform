import{authError,database,requirePermission,resolveActor}from"../../../lib/server-auth";
import{buildTeamOverview}from"../../../lib/team-overview";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

// The Team home front door's counters, derived from canonical tables (never static literals).
// Read-only. dashboard.view is the base staff permission the API gateway already applies here.
export async function GET(request:Request){
  try{
    const db=await database(),actor=await resolveActor(request);requirePermission(actor,"dashboard.view");
    return json({data:await buildTeamOverview(db,{actorEmail:actor.email,actorName:actor.name,roleCode:actor.roleCode})});
  }catch(error){return authError(error,"Unable to load the Team overview");}
}
