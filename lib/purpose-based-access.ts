/**
 * Purpose-based access to customer personal data. [PTJA-W2-B2-R01 / C01 / C07]
 *
 * WHAT THIS AUDIT MEASURED. Phone and name were masked from lower-privileged staff; email, home address
 * and staff internal notes were not, because the platform defined only maskPhone and maskName. Six
 * cross-tenant reads were found returning bereavement pickup addresses, relocation travel dates and
 * competitors' complaint notes - each on a branch written for "staff" but gated on a permission that
 * `service_provider` also holds. The question left open at the time was who should see what, because an
 * associate arranging a home visit genuinely needs the address and a blanket mask would have broken the
 * work.
 *
 * THE APPROVED ANSWER is purpose-based access, not one global masked/unmasked switch. Three things decide
 * what a person sees: WHO they are, WHY they are looking, and WHETHER this record is assigned to them
 * right now. A sales rep sees a masked number until the lead is theirs; an operations associate sees the
 * doorstep only for a confirmed booking that is about to happen; a provider never sees the raw number at
 * all and their window shuts after the job plus a dispute period.
 *
 * FOUR RULES THAT BITE HARDEST, each locked by a regression:
 *   - the full address opens only AFTER assignment or confirmation and shortly before service
 *   - provider access expires at completion plus a limited dispute window
 *   - every reveal is logged with the user, the reason, the record and the time
 *   - complaint, safety, medical, financial and HR notes are separate categories with separate
 *     permissions, and no internal note reaches a customer or a provider unless explicitly marked
 *     shareable
 *
 * WHY REVEALS ARE MASKED RATHER THAN OMITTED. A record with the contact field simply missing is a record
 * staff cannot recognise, and the workaround for that is a spreadsheet. Masked values keep the work
 * possible while keeping the data closed.
 */
import{maskPhone}from"./platform-security";
import{registerServicePolicyDomain,resolveServicePolicy}from"./service-policy-governance";

type Db=D1Database;
const text=(value:unknown)=>String(value??"").trim();

export const DATA_ACCESS_DOMAIN="data_access_policy";

export type AddressPrecision="none"|"billing"|"area"|"full";
export type NoteCategory="sales"|"operational"|"complaint"|"safety"|"medical"|"financial"|"hr";

export type DataAccessPolicyConfig={
  /** How close to the service the full address opens, in hours. */
  fullAddressWindowHours:number;
  /** Booking statuses that count as assigned or confirmed for the address rule. */
  addressEligibleStatuses:string[];
  /** How long after completion a provider keeps access, in hours. */
  providerDisputeWindowHours:number;
  /** Note categories each purpose may read without a further grant. */
  notesByPurpose:Record<string,string[]>;
  /** Categories that always need their own permission, whatever the role. */
  restrictedNoteCategories:string[];
  /** permission required per restricted category. */
  restrictedNotePermissions:Record<string,string>;
  /** Purposes that may never see an internal note at all. */
  purposesDeniedInternalNotes:string[];
  requireReasonForReveal:boolean;
  /** How long a reveal stays valid before the screen must remask, in seconds. */
  revealTtlSeconds:number;
};

export const APPROVED_DATA_ACCESS:DataAccessPolicyConfig={
  fullAddressWindowHours:24,
  addressEligibleStatuses:["confirmed","assigned","on_the_way","en_route","arrived","in_service","completed"],
  providerDisputeWindowHours:72,
  notesByPurpose:{
    sales:["sales"],
    operations:["operational"],
    service_delivery:[],           // a provider sees only what is explicitly marked shareable
    finance:["financial"],
    compliance:["sales","operational","complaint","safety","medical","financial","hr"],
    self_service:[],
  },
  restrictedNoteCategories:["complaint","safety","medical","financial","hr"],
  restrictedNotePermissions:{
    complaint:"notes.complaint.view",safety:"notes.safety.view",medical:"notes.medical.view",
    financial:"notes.financial.view",hr:"notes.hr.view",
  },
  // A customer never sees an internal note, including one marked shareable with a provider.
  purposesDeniedInternalNotes:["self_service"],
  requireReasonForReveal:true,
  revealTtlSeconds:600,
};

registerServicePolicyDomain<DataAccessPolicyConfig&Record<string,unknown>>({
  domain:DATA_ACCESS_DOMAIN,
  label:"Customer data access and masking",
  managePermission:"settings.manage",
  defaults:APPROVED_DATA_ACCESS as DataAccessPolicyConfig&Record<string,unknown>,
  problem(config){
    if(!Number.isFinite(Number(config.fullAddressWindowHours))||Number(config.fullAddressWindowHours)<=0)return "The full-address window must be a positive number of hours";
    if(!Number.isFinite(Number(config.providerDisputeWindowHours))||Number(config.providerDisputeWindowHours)<0)return "The provider dispute window must be zero or more hours";
    if(!Array.isArray(config.addressEligibleStatuses)||!config.addressEligibleStatuses.length)return "At least one booking status must open the address";
    const restricted=config.restrictedNoteCategories;
    if(!Array.isArray(restricted))return "restrictedNoteCategories must be a list";
    // These five are the categories the approved decision names. Removing one would let a complaint or a
    // medical note travel on seniority alone, which is what the finding was about.
    for(const required of["complaint","safety","medical","financial","hr"]){
      if(!restricted.map(String).includes(required))return `restrictedNoteCategories must include ${required}`;
    }
    const permissions=config.restrictedNotePermissions as Record<string,string>|undefined;
    for(const category of restricted.map(String)){
      if(!permissions||!text(permissions[category]))return `restrictedNotePermissions.${category} is required`;
    }
    if(!Array.isArray(config.purposesDeniedInternalNotes)||!config.purposesDeniedInternalNotes.map(String).includes("self_service")){
      return "A customer must never be shown an internal note - self_service cannot be removed from purposesDeniedInternalNotes";
    }
    if(config.requireReasonForReveal===false)return "Every reveal must carry a reason";
    const ttl=Number(config.revealTtlSeconds);
    // A reveal that never expires is not a reveal, it is an unmasking. An unbounded one would also make
    // the audit trail a lie: it would record a moment, while the value stayed on screen all afternoon.
    if(!Number.isFinite(ttl)||ttl<60||ttl>900)return "A reveal must stay valid for between 60 and 900 seconds";
    return null;
  },
});

export async function resolveDataAccessPolicy(db:Db,scope:{serviceCode?:string|null;cityId?:string|null}={},at=new Date()){
  return resolveServicePolicy<DataAccessPolicyConfig&Record<string,unknown>>(db,DATA_ACCESS_DOMAIN,scope,at);
}

const accessReady=new WeakSet<Db>();
export async function ensureDataAccessTables(db:Db){
  if(accessReady.has(db))return;
  await db.prepare("CREATE TABLE IF NOT EXISTS customer_data_reveals (id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,actor_role TEXT NOT NULL,subject_id TEXT NOT NULL,data_class TEXT NOT NULL,purpose TEXT NOT NULL,assignment_type TEXT,assignment_id TEXT,reason TEXT NOT NULL,created_at INTEGER NOT NULL)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_customer_data_reveals_subject ON customer_data_reveals(subject_id,created_at)").run();
  accessReady.add(db);
}

export type AccessActor={email:string;roleCode:string;permissions?:readonly string[]};
export type Assignment={type:"lead"|"booking";id:string;assignedTo?:string|null;status?:string|null;scheduledStart?:number|null;completedAt?:number|null};
export type DataSubject={customerId:string;name:string;phone?:string|null;email?:string|null;address?:{line1?:string|null;area?:string|null;city?:string|null;pincode?:string|null}|null};

const holdsAll=(actor:AccessActor)=>(actor.permissions??[]).includes("*");
const holds=(actor:AccessActor,permission:string)=>holdsAll(actor)||(actor.permissions??[]).includes(permission);
const maskEmail=(value?:string|null)=>{const email=text(value);if(!email)return null;const at=email.indexOf("@");return at<=0?"•••":`•••${email.slice(at)}`;};

/** Is this record assigned to this actor right now? Assignment is what justifies a reveal, not the role. */
const assignedToActor=(actor:AccessActor,assignment?:Assignment|null)=>
  Boolean(assignment&&text(assignment.assignedTo)&&(text(assignment.assignedTo)===text(actor.email)||text(assignment.assignedTo)===text((actor as{providerId?:string}).providerId)));

export type CustomerDataView={
  subjectId:string;purpose:string;revealed:boolean;
  contact:{phone:string|null;email:string|null;channel:"direct"|"relay"|"masked"};
  address:{precision:AddressPrecision;line1:string|null;area:string|null;city:string|null;pincode:string|null};
  /** When a revealed view must be remasked. Null when nothing was revealed. */
  revealExpiresAt?:number|null;
  revealedFields?:RevealField[];
  policyVersion:string;
};

/**
 * What this actor may see of this customer, for this purpose, right now.
 *
 * A reveal is an event, not a state: asking for one requires a reason and writes an audit row naming the
 * actor, the record and the time. Not asking returns the masked view and writes nothing.
 */
export type CustomerDataDecision=Omit<CustomerDataView,"policyVersion">;

/**
 * The decision itself, over an ALREADY RESOLVED config. Pure: it reads no database and logs nothing, so
 * a list of a hundred rows costs one policy read rather than a hundred.
 *
 * `reveal` is not decided here. A reveal is an event with a reason and an audit row, and an event is not
 * something a pure function may quietly perform - resolveCustomerDataAccess owns that, and the list
 * surfaces that call this directly cannot produce one at all. [PTJA-W2-B2-R01/C01/C07]
 */
export type RevealField="phone"|"email"|"address";
export const REVEAL_FIELDS:RevealField[]=["phone","email","address"];

export function decideCustomerDataAccess(config:DataAccessPolicyConfig,input:{
  actor:AccessActor;subject:DataSubject;purpose:string;assignment?:Assignment|null;revealed?:boolean;
  /** Which fields the caller asked for. Absent means all of them. */
  revealFields?:readonly RevealField[]|null;now?:number;
}):CustomerDataDecision{
  // Asking for the doorstep must not hand over the phone as well. An absent list means the caller asked
  // for everything, which is the historical behaviour and still the common case.
  const asked=(field:RevealField)=>!input.revealFields||input.revealFields.includes(field);
  const now=input.now??Date.now();
  const purpose=text(input.purpose)||"operations";
  const actor=input.actor;
  const subject=input.subject;
  const assignment=input.assignment??null;
  const base={subjectId:subject.customerId,purpose};
  const compliance=holdsAll(actor)||purpose==="compliance"&&holds(actor,"audit.view");

  // ---- the provider window: relay contact, and access that shuts after the dispute period ----
  if(purpose==="service_delivery"){
    const completedAt=Number(assignment?.completedAt??0);
    const windowClosed=completedAt>0&&now>completedAt+config.providerDisputeWindowHours*3_600_000;
    if(windowClosed||!assignment){
      return{...base,revealed:false,contact:{phone:null,email:null,channel:"masked"},
        address:{precision:"none",line1:null,area:null,city:null,pincode:null}};
    }
    return{...base,revealed:false,
      // A provider reaches the customer through the platform, never on their own line.
      contact:{phone:maskPhone(subject.phone),email:null,channel:"relay"},
      address:{precision:"full",line1:subject.address?.line1??null,area:subject.address?.area??null,
        city:subject.address?.city??null,pincode:subject.address?.pincode??null}};
  }

  /*
   * ---- compliance and superuser ----
   *
   * Being entitled to reveal is not the same as being handed everything unasked. This branch used to
   * return the raw phone, email and full address whatever `revealed` said, so a founder or superuser
   * opening the CRM list got a hundred unmasked contacts with no reason recorded - the exact bulk
   * reveal the approved rule exists to stop, wearing a seniority badge. Caught by CO-09 in
   * tests/ptja-w3-lead-owner-identity.test.mjs, which reads the CRM as a founder. [PTJA-W3-CO]
   *
   * What seniority buys is that mayReveal() says yes. Asking is still asking.
   */
  if(compliance){
    const revealed=Boolean(input.revealed);
    return{...base,revealed,
      contact:{
        phone:revealed&&asked("phone")?(subject.phone??null):maskPhone(subject.phone),
        email:revealed&&asked("email")?(subject.email??null):maskEmail(subject.email),
        channel:revealed&&(asked("phone")||asked("email"))?"direct" as const:"masked" as const},
      address:revealed&&asked("address")
        ?{precision:"full" as const,line1:subject.address?.line1??null,area:subject.address?.area??null,city:subject.address?.city??null,pincode:subject.address?.pincode??null}
        :{precision:"area" as const,line1:null,area:subject.address?.area??null,city:subject.address?.city??null,pincode:subject.address?.pincode??null}};
  }

  // ---- finance: a billing contact and a billing address, never a doorstep ----
  if(purpose==="finance"){
    return{...base,revealed:false,contact:{phone:maskPhone(subject.phone),email:subject.email??null,channel:"direct"},
      address:{precision:"billing",line1:null,area:subject.address?.area??null,city:subject.address?.city??null,pincode:subject.address?.pincode??null}};
  }

  // ---- everyone else: assignment decides ----
  const revealed=Boolean(input.revealed);
  const status=text(assignment?.status);
  const eligible=config.addressEligibleStatuses.map(String).includes(status);
  const scheduledStart=Number(assignment?.scheduledStart??0);
  // "Shortly before service" - both halves. A booking three weeks out does not justify holding somebody's
  // doorstep address on a screen today, and neither does an unconfirmed one an hour away.
  const nearExecution=scheduledStart>0&&scheduledStart-now<=config.fullAddressWindowHours*3_600_000;
  const mine=assignedToActor(actor,assignment)||holds(actor,"customers.view_full_phone")&&actor.roleCode==="manager";
  const fullAddress=mine&&eligible&&nearExecution;

  return{...base,revealed,
    contact:{phone:revealed&&asked("phone")?(subject.phone??null):maskPhone(subject.phone),
      email:revealed&&asked("email")?(subject.email??null):maskEmail(subject.email),
      channel:revealed&&(asked("phone")||asked("email"))?"direct":"masked"},
    address:fullAddress&&(!revealed||asked("address"))
      ?{precision:"full",line1:subject.address?.line1??null,area:subject.address?.area??null,city:subject.address?.city??null,pincode:subject.address?.pincode??null}
      :{precision:"area",line1:null,area:subject.address?.area??null,city:subject.address?.city??null,pincode:subject.address?.pincode??null}};
}

/**
 * May this actor turn a masked view into a revealed one for this record?
 *
 * Two justifications, and only two: the record is ASSIGNED to them, or they hold the explicit
 * customers.view_full_phone grant. Note what this deliberately does NOT copy from the address rule
 * below: that rule reads the grant only for roleCode "manager", because a full doorstep address on a
 * screen is a different question from a phone number somebody asked for by name and gave a reason for.
 * Tying the reveal to one role code would have left an admin holding the grant less able to do their
 * job than a manager holding the same grant, which is not what the permission means.
 */
export function mayReveal(actor:AccessActor,purpose:string,assignment?:Assignment|null){
  if(holdsAll(actor))return true;
  if(text(purpose)==="compliance"&&holds(actor,"audit.view"))return true;
  if(assignedToActor(actor,assignment??null))return true;
  return holds(actor,"customers.view_full_phone");
}

/**
 * What this actor may see of this customer, for this purpose, right now.
 *
 * A reveal is an event, not a state: asking for one requires a reason and writes an audit row naming the
 * actor, the record and the time. Not asking returns the masked view and writes nothing.
 */
export async function resolveCustomerDataAccess(db:Db,input:{
  actor:AccessActor;subject:DataSubject;purpose:string;assignment?:Assignment|null;
  reveal?:{requested?:boolean;reason?:string;fields?:readonly RevealField[]|null}|null;now?:number;
}):Promise<CustomerDataView>{
  await ensureDataAccessTables(db);
  const policy=await resolveDataAccessPolicy(db,{});
  const config=policy.config;
  const now=input.now??Date.now();
  const purpose=text(input.purpose)||"operations";
  const wantsReveal=Boolean(input.reveal?.requested);
  const reason=text(input.reveal?.reason);
  if(wantsReveal&&config.requireReasonForReveal&&!reason){
    throw Response.json({error:"A reveal needs a reason",code:"reveal_reason_required"},{status:400});
  }
  const revealed=wantsReveal&&mayReveal(input.actor,purpose,input.assignment??null);
  const requested=input.reveal?.fields?.length?input.reveal.fields.filter(field=>REVEAL_FIELDS.includes(field)):REVEAL_FIELDS;
  const decision=decideCustomerDataAccess(config,{...input,revealed,revealFields:requested,now});
  if(decision.revealed){
    const assignment=input.assignment??null;
    /*
     * WHICH FIELDS, not "something was revealed". The audit used to record contact or contact+address,
     * which cannot answer the only question anybody asks it later: what did this person actually see?
     * Derived from the DECISION rather than from the request, so a field that was asked for and refused
     * is not logged as revealed. [PTJA-W3-RU]
     */
    const revealedFields=REVEAL_FIELDS.filter(field=>
      field==="phone"?decision.contact.phone===(input.subject.phone??null)&&Boolean(input.subject.phone):
      field==="email"?decision.contact.email===(input.subject.email??null)&&Boolean(input.subject.email):
      decision.address.precision==="full");
    const dataClass=revealedFields.length?revealedFields.join("+"):"none";
    await db.prepare("INSERT INTO customer_data_reveals (id,actor_id,actor_role,subject_id,data_class,purpose,assignment_type,assignment_id,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(`REV-${crypto.randomUUID().slice(0,10).toUpperCase()}`,input.actor.email,input.actor.roleCode,input.subject.customerId,dataClass,purpose,
        assignment?.type??null,assignment?.id??null,reason,now).run();
  }
  const revealedFields=decision.revealed?REVEAL_FIELDS.filter(field=>
    field==="phone"?decision.contact.phone===(input.subject.phone??null)&&Boolean(input.subject.phone):
    field==="email"?decision.contact.email===(input.subject.email??null)&&Boolean(input.subject.email):
    decision.address.precision==="full"):[];
  return{...decision,revealedFields,
    revealExpiresAt:decision.revealed?now+config.revealTtlSeconds*1000:null,
    policyVersion:policy.policyVersion};
}

export type InternalNote={id:string;category:string;body:string;shareableWithProvider?:boolean};

/**
 * The notes this actor may read, for this purpose.
 *
 * Categories are not a hierarchy. A manager does not inherit medical notes by being senior; they need
 * the medical grant. That is the whole point of separating the categories - the finding was complaint
 * notes travelling on a permission that meant something else entirely.
 */
export function filterVisibleNotes(config:DataAccessPolicyConfig,input:{actor:AccessActor;purpose:string;notes:InternalNote[];assignment?:Assignment|null}){
  const purpose=text(input.purpose)||"operations";
  const actor=input.actor;

  // A customer is never shown an internal note, including one marked shareable with a provider.
  if(config.purposesDeniedInternalNotes.map(String).includes(purpose)||actor.roleCode==="customer")return [];

  if(purpose==="service_delivery"){
    // A provider is identified by their provider id, not their login. An actor with neither is not the
    // assignee, and a job assigned to somebody else is not theirs to read.
    if(!assignedToActor(actor,input.assignment??null))return [];
    // Service instructions only, and only what somebody deliberately marked shareable.
    return input.notes.filter(note=>note.shareableWithProvider===true);
  }

  const allowedByPurpose=new Set((config.notesByPurpose[purpose]??[]).map(String));
  const restricted=new Set(config.restrictedNoteCategories.map(String));
  return input.notes.filter(note=>{
    const category=text(note.category);
    if(restricted.has(category)){
      // A restricted category needs its OWN grant, full stop. Seniority does not carry it and neither
      // does the purpose - that is the entire point of separating these categories.
      const permission=config.restrictedNotePermissions[category];
      return Boolean(permission&&holds(actor,permission));
    }
    return allowedByPurpose.has(category);
  });
}

export async function visibleNotes(db:Db,input:{actor:AccessActor;purpose:string;notes:InternalNote[];assignment?:Assignment|null;now?:number}){
  await ensureDataAccessTables(db);
  const policy=await resolveDataAccessPolicy(db,{});
  return filterVisibleNotes(policy.config,input);
}

/**
 * One policy read for a whole page.
 *
 * Every staff list surface shows many customers, and resolveCustomerDataAccess resolves the policy from
 * the database on each call. Migrating a hundred-row list onto it one row at a time would have traded an
 * exposure for a hundred queries, so the surfaces take a resolver instead: the policy is read once, and
 * `view` and `notes` are then pure. Neither can produce a reveal - a list has no reason and names no
 * record, so it is not a reveal. That is app/api/customer-data-reveal. [PTJA-W2-B2-R01/C01/C07]
 */
export async function customerDataAccessResolver(db:Db,scope:{serviceCode?:string|null;cityId?:string|null}={}){
  await ensureDataAccessTables(db);
  const policy=await resolveDataAccessPolicy(db,scope);
  return{
    policyVersion:policy.policyVersion,
    config:policy.config,
    view:(input:{actor:AccessActor;subject:DataSubject;purpose:string;assignment?:Assignment|null;now?:number}):CustomerDataView=>
      ({...decideCustomerDataAccess(policy.config,input),policyVersion:policy.policyVersion}),
    notes:(input:{actor:AccessActor;purpose:string;notes:InternalNote[];assignment?:Assignment|null})=>
      filterVisibleNotes(policy.config,input),
  };
}
