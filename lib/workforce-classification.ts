/**
 * Workforce classification - the single place that decides, for a worker, WHICH surfaces and features
 * they get. Three engagement kinds, matching how PawSpace actually engages people:
 *
 *   - direct     : office / salaried direct employee. Full employee self-service (/me): ranking,
 *                  attendance, leave, payslip, performance, colleague directory, salary advances.
 *   - contract   : groomers, trainers, sitters, hosts, walkers engaged on contract. Get the earning
 *                  side in the PARTNER app - ranking, incentive, attendance, leave, payslip, advance,
 *                  petrol allowance, GPay/cash stats - plus job proof/tracking duties.
 *   - commission : pure commission service providers. NO payslip/leave/advance/attendance. Only their
 *                  own dashboard - bookings, future bookings, payment pending/status, onboarding status,
 *                  live assignments to accept - plus job proof/tracking duties.
 *
 * This is intentionally a thin, well-tested policy layer: the feature flags here are what the /me portal,
 * the partner app and the commission dashboard read to decide what to render. "Add the worker accordingly"
 * = set engagement_type when the employee/provider record is created.
 */
type Db=D1Database;
type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();

export type EngagementKind="direct"|"contract"|"commission";
export type WorkforceFeatures={
 payslip:boolean;leave:boolean;attendance:boolean;advance:boolean;performance:boolean;ranking:boolean;
 colleagueDirectory:boolean;incentive:boolean;petrolAllowance:boolean;cashStats:boolean;
 bookingsDashboard:boolean;liveAssignments:boolean;jobProofAndTracking:boolean;
 surface:"employee_portal"|"partner_app"|"commission_dashboard";
};

const NORMALISE:Record<string,EngagementKind>={
 direct:"direct",direct_employee:"direct",office:"direct",employee:"direct",full_time:"direct",salaried:"direct",
 contract:"contract",contractor:"contract",contract_provider:"contract",
 commission:"commission",commission_provider:"commission",commission_based:"commission",partner:"commission",
};

/** Map a raw engagement/employment_type string to one of the three canonical kinds (default: direct). */
export function normaliseEngagement(raw:unknown):EngagementKind{
 return NORMALISE[text(raw).toLowerCase()]||"direct";
}

/** The feature set a given engagement kind is entitled to. Pure policy - no DB. */
export function featuresFor(kind:EngagementKind):WorkforceFeatures{
 if(kind==="direct")return{payslip:true,leave:true,attendance:true,advance:true,performance:true,ranking:true,colleagueDirectory:true,incentive:true,petrolAllowance:false,cashStats:false,bookingsDashboard:false,liveAssignments:false,jobProofAndTracking:false,surface:"employee_portal"};
 if(kind==="contract")return{payslip:true,leave:true,attendance:true,advance:true,performance:true,ranking:true,colleagueDirectory:false,incentive:true,petrolAllowance:true,cashStats:true,bookingsDashboard:true,liveAssignments:true,jobProofAndTracking:true,surface:"partner_app"};
 return{payslip:false,leave:false,attendance:false,advance:false,performance:false,ranking:false,colleagueDirectory:false,incentive:false,petrolAllowance:false,cashStats:false,bookingsDashboard:true,liveAssignments:true,jobProofAndTracking:true,surface:"commission_dashboard"};
}

/** Resolve a worker's current engagement kind from their latest employment version (employees) or provider record. */
export async function resolveEngagementForWorker(db:Db,input:{employeeId?:string;providerId?:string}):Promise<EngagementKind>{
 if(text(input.employeeId)){
  const v=await db.prepare("SELECT employment_type FROM employee_employment_versions WHERE employee_id=? AND effective_until IS NULL ORDER BY version DESC LIMIT 1").bind(input.employeeId).first<Row>().catch(()=>null);
  if(v)return normaliseEngagement(v.employment_type);
 }
 if(text(input.providerId)){
  const p=await db.prepare("SELECT engagement_type FROM service_providers WHERE id=?").bind(input.providerId).first<Row>().catch(()=>null);
  if(p)return normaliseEngagement(p.engagement_type);
  // service_providers is not populated on this platform - the real provider registries are
  // provider_capacity_profiles (provider_model: full_time | commission) and
  // provider_compensation_profiles (engagement_model: full_time | commission). A provider found
  // there is never an office 'direct' employee: commission stays commission (no payslip/earnings
  // surfaces), anything else is a contract-engaged partner.
  const providerModel=(kind:unknown):EngagementKind=>text(kind).toLowerCase().startsWith("commission")?"commission":"contract";
  const capacity=await db.prepare("SELECT provider_model FROM provider_capacity_profiles WHERE id=?").bind(input.providerId).first<Row>().catch(()=>null);
  if(capacity)return providerModel(capacity.provider_model);
  const compensation=await db.prepare("SELECT engagement_model FROM provider_compensation_profiles WHERE provider_id=?").bind(input.providerId).first<Row>().catch(()=>null);
  if(compensation)return providerModel(compensation.engagement_model);
 }
 return "direct";
}

/** Convenience: the resolved kind + its feature flags for a worker. */
export async function workforceProfile(db:Db,input:{employeeId?:string;providerId?:string}){
 const kind=await resolveEngagementForWorker(db,input);
 return{engagement:kind,features:featuresFor(kind)};
}
