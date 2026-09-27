/**
 * First routing of a new lead, and the UAT default routing / SLA policies it relies on.
 *
 * A public enquiry (the /contact form, and the signed-out web chat, which files through the same intake)
 * is routed exactly the way "Rotate day" and the lead-assignment API route a lead: canonical assignment
 * under the active lead-assignment policy (lowest-workload eligible rep, or the policy's fallback queue
 * when nobody on the roster covers the service/city), then a first-response clock under the active lead
 * SLA policy. Before this, public leads were owned by "AI Orchestrator" and the SLA clock could never
 * start ("Lead requires a current canonical assignment before SLA can start") although the /contact form
 * promises "Our team will reach out within a couple of hours".
 *
 * DEFAULTS, NOT A NEW POLICY SYSTEM. When nothing has ever been configured - no lead-assignment policy at
 * all, or no SLA policy for the sales team - a UAT default is saved and activated through the existing
 * governed policy functions (versioned, with an approval reference that marks it as a UAT default), the
 * same approach lib/case-sla-defaults.ts takes for case SLAs. A policy the ops owner configured, in any
 * status, is never overwritten, and a retired default is never resurrected: seeding only happens while
 * the relevant table is empty for that team.
 *
 * The numbers are the platform's existing operating targets, not invented ones: a 10-minute first
 * response and a manager alert at 30 minutes are what every CRM lead is already given
 * (first_action_due_at / manager_alert_at), counted only inside the 09:00-21:00 IST calling window the
 * power dialler enforces; reassignment at two hours is the "within a couple of hours" the /contact form
 * promises; 4 hours to the next follow-up is what lib/lead-attempt.ts schedules after an attempt; and
 * the terminal outcomes are the two the CRM closes a lead on (Opt-out, Invalid).
 */
import{activateLeadAssignmentPolicy,assignLead,ensureLeadAssignmentTables,saveLeadAssignmentPolicy}from"./lead-assignment-governance";
import{activateLeadSlaPolicy,ensureLeadSlaTables,saveLeadSlaPolicy,startLeadSlaClock,type LeadBusinessHours}from"./lead-sla-governance";
import{normalizeLeadServiceCode}from"./lead-lifecycle-governance";
import{ensureD1OnceApplied}from"./d1-ensure-once.js";

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();

export const DEFAULT_LEAD_TEAM="sales";
export const DEFAULT_LEAD_FALLBACK_QUEUE="sales-enquiries";
export const DEFAULT_ASSIGNMENT_POLICY_ID="LAP-UAT-DEFAULT-SALES";
export const DEFAULT_SLA_POLICY_ID="SLAP-UAT-DEFAULT-SALES";
/** Every service a public enquiry can name: the /contact form's options and the web chat's flows. */
const PUBLIC_ENQUIRY_SERVICE_LABELS=["General enquiry","Grooming","Dog Training","Boarding","Pet Sitting","Dog Walking","Pet Taxi","Fresh Food","Relocation","Pet Relocation","Doorstep Vet","Pet Farewell Support","Talk to our team","Web chat enquiry"];
export const DEFAULT_ROUTED_SERVICES=[...new Set(PUBLIC_ENQUIRY_SERVICE_LABELS.map(normalizeLeadServiceCode))];
/** The cities the public intake can file a lead under (app/api/public-contact cityForArea). */
export const DEFAULT_ROUTED_CITIES=["blr","hyd","mum","pnq","maa"];
/** Effective since before the platform took its first lead, so a default applies to any lead's clock. */
const DEFAULT_EFFECTIVE_FROM=Date.UTC(2020,0,1);
const CALLING_WINDOW:LeadBusinessHours={mode:"windowed",weekdays:Object.fromEntries(["0","1","2","3","4","5","6"].map(day=>[day,{startMinute:9*60,endMinute:21*60}]))};

/**
 * Seeds the UAT default lead-assignment and lead-SLA policies when none has ever been configured.
 * Checked once per isolate after it has succeeded; a failure is retried by the next caller and never
 * blocks routing (routing then reports why it could not run).
 */
export async function ensureDefaultLeadRoutingPolicies(db:Db,input:{actorId:string}){
 await ensureD1OnceApplied(db,"lead_routing_default_policies",async()=>{
  try{
   await Promise.all([ensureLeadAssignmentTables(db),ensureLeadSlaTables(db)]);
   const counts=await db.prepare("SELECT (SELECT COUNT(*) FROM lead_assignment_policies) assignment_policies,(SELECT COUNT(*) FROM lead_sla_policies WHERE team_code=?) sla_policies").bind(DEFAULT_LEAD_TEAM).first<Row>();
   const reason="UAT default applied because no policy has been configured";
   if(Number(counts?.assignment_policies||0)===0){
    // A concurrent request may seed it first: the deterministic id makes the loser's save or activation
    // refuse, which is exactly the outcome wanted.
    try{const draft=await saveLeadAssignmentPolicy(db,{id:DEFAULT_ASSIGNMENT_POLICY_ID,name:"UAT default · sales lead routing",teamCode:DEFAULT_LEAD_TEAM,serviceCodes:DEFAULT_ROUTED_SERVICES,cityIds:DEFAULT_ROUTED_CITIES,languageCodes:[],maxActiveWorkload:100,continuityEnabled:true,requireShift:false,fallbackQueue:DEFAULT_LEAD_FALLBACK_QUEUE,effectiveFrom:DEFAULT_EFFECTIVE_FROM,reason,actorId:input.actorId});
     await activateLeadAssignmentPolicy(db,{policyId:draft.id,approvalReference:"UAT-DEFAULT-LEAD-ROUTING",reason,actorId:input.actorId});}catch{/* seeded concurrently */}
   }
   if(Number(counts?.sla_policies||0)===0){
    try{const draft=await saveLeadSlaPolicy(db,{id:DEFAULT_SLA_POLICY_ID,name:"UAT default · sales lead first response",teamCode:DEFAULT_LEAD_TEAM,serviceCodes:DEFAULT_ROUTED_SERVICES,cityIds:DEFAULT_ROUTED_CITIES,timezone:"Asia/Kolkata",businessHours:CALLING_WINDOW,firstResponseMinutes:10,followUpMinutes:240,quoteFollowUpMinutes:24*60,highIntentMinutes:5,managerEscalationAfterMinutes:20,reassignmentAfterMinutes:90,requireNextAction:false,terminalOutcomes:["Opt-out","Invalid"],effectiveFrom:DEFAULT_EFFECTIVE_FROM,reason,actorId:input.actorId});
     await activateLeadSlaPolicy(db,{policyId:draft.id,approvalReference:"UAT-DEFAULT-LEAD-SLA",reason,actorId:input.actorId});}catch{/* seeded concurrently */}
   }
   return true;
  }catch{return false;}
 });
}

export type RoutedLead={owner:string;assignment:"canonical"|"fallback_queue";queue:string|null;assignmentId:string;sla:"canonical"|"policy_unavailable";reason?:string};

/**
 * Assigns a new lead and starts its first-response clock. Idempotent per key prefix: a retry returns the
 * same assignment and clock. Throws the governed refusal when no active assignment policy covers the
 * lead's service/city, so the caller decides what an unroutable lead gets.
 */
export async function routeNewLead(db:Db,input:{leadId:string;actorId:string;asOf:number;keyPrefix:string}):Promise<RoutedLead>{
 await ensureDefaultLeadRoutingPolicies(db,{actorId:input.actorId});
 const outcome=await assignLead(db,{leadId:input.leadId,idempotencyKey:`${input.keyPrefix}:assign:${input.leadId}`,reason:"new_lead",actorId:input.actorId,asOf:input.asOf});
 const assignment=(outcome.assignment||{}) as Row,person=text(assignment.employee_email),queue=person?null:text(assignment.fallback_queue)||DEFAULT_LEAD_FALLBACK_QUEUE;
 const routed:RoutedLead={owner:person||"Unassigned",assignment:person?"canonical":"fallback_queue",queue,assignmentId:text(assignment.id),sla:"canonical"};
 try{await startLeadSlaClock(db,{leadId:input.leadId,clockType:"first_response",idempotencyKey:`${input.keyPrefix}:first-response:${input.leadId}`,actorId:input.actorId,asOf:input.asOf});}
 catch(error){routed.sla="policy_unavailable";routed.reason=error instanceof Error?error.message:String(error);}
 return routed;
}
