/**
 * GET /api/leaderboard - the live company board, scoped to what the caller is actually entitled to see.
 *
 * This route gated on `self_service.view` ALONE and then handed every caller the whole board. The
 * `service_provider` role holds `self_service.view` (lib/platform-security.ts), so an EXTERNAL
 * commission partner signed in with a partner session was served the entire staff sales leaderboard -
 * every employee's name, work email and net collected revenue - while /api/me told that same identity
 * "No employee record linked yet". The role's own description bounds it to "own earnings/rank
 * self-service WHEN LINKED TO AN EMPLOYEE RECORD": the permission was never peer visibility, and no
 * subject scoping existed here to hold it to that.
 *
 * Two levels, decided from PERMISSIONS rather than role names:
 *   performance.view -> the whole board. It is the catalogue permission that names this exact data
 *                       (employee performance ranking), and the shipped roles grant it to admin,
 *                       manager, associate and auditor - the internal staff who review performance -
 *                       and to neither `customer` nor `service_provider`, the two non-staff session
 *                       roles. `self_service.view` cannot express it: service_provider holds it.
 *   otherwise        -> own row only, with the subject resolved exactly the way the rest of the
 *                       repository resolves a self-scoped subject: the employee record bound to the
 *                       actor (resolveEmployeeForActor, what /api/me uses), and - for a partner
 *                       session, whose actor email is the synthetic `provider:<subjectId>` audit id -
 *                       the provider behind that session (resolveProviderForActor) together with its
 *                       People linkage (peopleLinkForProvider). Rank is computed across the full board
 *                       before the filter, so "my rank" stays the real rank.
 *
 * An actor with no employee link gets an EMPTY board at 200 with scope.linked=false and the reason,
 * not a 403: it holds `self_service.view` legitimately, /leaderboard is its own workspace surface, and
 * /api/provider-workspace already answers this same identity state with {linked:false,reason}. The
 * filter, not the status code, is what withholds the data - both branches build the response from the
 * caller's own subject, so neither can disclose another person's name, work email or revenue.
 */
import{authError,authorize,database,type AuthenticatedActor}from"../../../lib/server-auth";
import{hasPermission}from"../../../lib/platform-security";
import{liveLeaderboard}from"../../../lib/live-leaderboard";
import{resolveEmployeeForActor}from"../../../lib/employee-self-service";
import{resolveProviderForActor}from"../../../lib/provider-workspace";
import{peopleLinkForProvider}from"../../../lib/workforce-person-linkage";

type Db=Awaited<ReturnType<typeof database>>;
type Board=Awaited<ReturnType<typeof liveLeaderboard>>;
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
const text=(v:unknown)=>String(v??"").trim();
const lower=(v:unknown)=>text(v).toLowerCase();
const LINKED_EMPLOYMENT=["active","contract_active"];
export const NOT_LINKED_REASON="No employee record is linked to your identity yet, so there is no own rank to show. Ask Ops to link your record. The company-wide board is visible to performance reviewers only.";

/** The ONLY subject a caller without performance.view may be shown: their own employee record, and their own provider id. Cold-DB safe. */
async function selfSubject(db:Db,actor:AuthenticatedActor){
 const emails=new Set<string>(),providerIds=new Set<string>();
 const employee=await resolveEmployeeForActor(db,actor.email).catch(()=>null);
 if(employee)for(const value of [employee.work_email,employee.user_email])if(lower(value))emails.add(lower(value));
 // A partner session carries no mailbox - its actor email is the synthetic `provider:<subjectId>` audit
 // id - so the employee link for that identity runs through the provider's People linkage instead.
 const providerId=await resolveProviderForActor(db,actor.email).catch(()=>null);
 if(providerId){
  providerIds.add(text(providerId));
  const link=await peopleLinkForProvider(db,providerId).catch(()=>null);
  if(link&&LINKED_EMPLOYMENT.includes(lower(link.employment_status))&&lower(link.work_email))emails.add(lower(link.work_email));
 }
 return{emails,providerIds,linked:emails.size>0};
}

/** Keep only the caller's own rows. Every other employee/groomer/trainer row is dropped before serialization. */
function ownRowsOnly(board:Board,subject:{emails:Set<string>;providerIds:Set<string>}){
 const employees=board.employees.filter(row=>subject.emails.has(lower(row.email)));
 const groomers=board.groomers.filter(row=>subject.providerIds.has(text(row.headGroomerId)));
 const trainers=board.trainers.filter(row=>subject.providerIds.has(text(row.trainerId)));
 return{...board,employees,groomers,trainers,counts:{employees:employees.length,groomers:groomers.length,trainers:trainers.length}};
}

export async function GET(request:Request){try{
 const actor=await authorize(request,"self_service.view");
 const db=await database(),url=new URL(request.url);
 const board=await liveLeaderboard(db,{metric:url.searchParams.get("metric"),monthStart:url.searchParams.get("monthStart")});
 if(hasPermission(actor.permissions,"performance.view"))return json({data:{...board,scope:{level:"full",linked:true}},productionReady:false});
 const subject=await selfSubject(db,actor);
 const scope=subject.linked?{level:"self",linked:true,ofEmployees:board.counts.employees}:{level:"self",linked:false,reason:NOT_LINKED_REASON};
 return json({data:{...ownRowsOnly(board,subject),scope},productionReady:false});
}catch(error){return authError(error,"Unable to load the leaderboard");}}
