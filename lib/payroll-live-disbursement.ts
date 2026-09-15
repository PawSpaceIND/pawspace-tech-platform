/**
 * Live payroll disbursement authorization: what it IS, and what it is not. [R3E-LIVE-DISBURSEMENT]
 *
 * Two things were wrong with this module, and only one of them was a bug in the ordinary sense.
 *
 * 1. Every refusal threw a bare `new Response(...)`. lib/server-auth.ts authError() trusts a Response
 *    only when the governed-http-error factory marked it, so it kept the status and REPLACED the body:
 *    the maker who tried to authorize their own approved run got 409 "Payroll update failed" instead
 *    of "Payroll maker/reviewer cannot authorize live disbursement", and a missing MFA session read as
 *    401 "Payroll update failed". Four separable refusals - wrong role, no staff identity, no fresh
 *    MFA, wrong run state, maker/reviewer - arrived indistinguishable from a broken server. Each one
 *    now travels through governedJsonError(), the same mechanism lib/server-auth.ts uses for its own.
 *
 * 2. The control reported success and then did nothing anyone could observe:
 *    assertLivePayrollDisbursementAuthorized() has NO CALLER anywhere in the product, because there is
 *    no transmission path to gate - nothing in the payroll libraries calls fetch(), and
 *    payroll_payment_batches.external_transmission is hard-wired to 0 by prepareSandboxPaymentBatch.
 *    That property is deliberate and must not regress, so this module does not invent a payment rail
 *    to make its own control meaningful. It becomes HONEST instead: the result says in so many words
 *    that nothing is transmitted, and livePayrollDisbursementAuthorizations() makes the recorded
 *    approval READABLE by payrollDirectory() and the payroll screen, so an authorization that used to
 *    disappear into a table nothing queried is now visible to the person who gave it.
 *
 * assertLivePayrollDisbursementAuthorized() is kept, unchanged in behaviour, as the gate a real
 * disbursement path would have to pass. It is deliberately still uncalled: wiring it to something
 * would mean building the transmission it guards, which is an owner decision, not a fixer's.
 */
import{validPrivilegedSessionProof}from"./admin-mfa";
import{governedJsonError}from"./governed-http-error";
import type{AuthenticatedActor}from"./server-auth";
type Db=D1Database;type Row=Record<string,unknown>;const text=(v:unknown)=>String(v??"").trim();
/** A caller-safe refusal: authError() keeps both the status AND the reason for a governed response. */
function refuse(message:string,status:number):never{throw governedJsonError({error:message},status);}
export async function ensurePayrollLiveApprovalTables(db:Db){await db.prepare("CREATE TABLE IF NOT EXISTS payroll_live_disbursement_approvals (run_id TEXT PRIMARY KEY,actor_user_id TEXT NOT NULL,actor_email TEXT NOT NULL,actor_role TEXT NOT NULL,mfa_session_id TEXT NOT NULL,mfa_verified_at INTEGER NOT NULL,approved_at INTEGER NOT NULL)").run();}
export async function authorizeLivePayrollDisbursement(db:Db,request:Request,actor:AuthenticatedActor,input:{runId:string}){await ensurePayrollLiveApprovalTables(db);if(!["admin","finance"].includes(text(actor.roleCode).toLowerCase()))refuse("Live payroll approval requires Admin or Finance role",403);if(!actor.userId)refuse("Live payroll approval requires a provisioned staff identity",403);const session=await validPrivilegedSessionProof(db,request,actor.userId);if(!session)refuse("Fresh MFA-backed privileged session is required for live payroll approval",401);const run=await db.prepare("SELECT id,status,created_by,reviewed_by,approved_by FROM payroll_runs WHERE id=?").bind(input.runId).first<Row>();if(!run||text(run.status)!=="approved")refuse("Approved payroll run is required",409);const email=text(actor.email).toLowerCase();if([run.created_by,run.reviewed_by].some(value=>text(value).toLowerCase()===email))refuse("Payroll maker/reviewer cannot authorize live disbursement",409);const now=Date.now();await db.prepare("INSERT INTO payroll_live_disbursement_approvals (run_id,actor_user_id,actor_email,actor_role,mfa_session_id,mfa_verified_at,approved_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET actor_user_id=excluded.actor_user_id,actor_email=excluded.actor_email,actor_role=excluded.actor_role,mfa_session_id=excluded.mfa_session_id,mfa_verified_at=excluded.mfa_verified_at,approved_at=excluded.approved_at").bind(input.runId,actor.userId,actor.email,actor.roleCode,text(session.id),Number(session.mfa_verified_at),now).run();
 /* Says what it did, and - just as important - what it did not do. Nothing in this platform transmits
  * a payment instruction; this records an MFA-backed approval and nothing else. The screen prints
  * `effect` verbatim so the control cannot read as "the money has been released". */
 return{runId:input.runId,approved:true,actor:actor.email,role:actor.roleCode,mfaSessionId:text(session.id),mfaVerifiedAt:Number(session.mfa_verified_at),approvedAt:now,transmitsPayment:false,effect:"authorization_record_only: an MFA-backed Admin/Finance approval is recorded against this run. No payment instruction is transmitted by this platform; payroll payment batches stay sandbox-only with external_transmission 0."};}
/** The recorded authorizations, so the control's own record is READ instead of written and forgotten. */
export async function livePayrollDisbursementAuthorizations(db:Db,limit=24){await ensurePayrollLiveApprovalTables(db);const rows=await db.prepare("SELECT run_id,actor_email,actor_role,mfa_session_id,mfa_verified_at,approved_at FROM payroll_live_disbursement_approvals ORDER BY approved_at DESC LIMIT ?").bind(limit).all<Row>();return rows.results;}
export async function assertLivePayrollDisbursementAuthorized(db:Db,input:{runId:string}){await ensurePayrollLiveApprovalTables(db);const proof=await db.prepare("SELECT * FROM payroll_live_disbursement_approvals WHERE run_id=?").bind(input.runId).first<Row>();if(!proof)throw new Error("Live payroll disbursement is blocked until an MFA-backed Admin/Finance approval is recorded");const run=await db.prepare("SELECT status FROM payroll_runs WHERE id=?").bind(input.runId).first<Row>();if(!run||text(run.status)!=="approved")throw new Error("Payroll run is no longer approved for live disbursement");return proof;}
