import{verifyWithIdfy,idfyConfigured}from"./idfy-verification-client";
import{ensureProviderCapacityTables}from"./provider-capacity-governance";

type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const emergencyPatterns=[/seizure/i,/not breathing/i,/cannot breathe/i,/difficulty breathing/i,/bleeding heavily/i,/uncontrolled bleeding/i,/collapsed/i,/unconscious/i,/poison(ed|ing)?/i,/hit by (a )?(car|vehicle)/i,/severe trauma/i];
const urgentPatterns=[/repeated vomiting/i,/bloated abdomen/i,/unable to urinate/i,/high fever/i,/severe pain/i,/eye injury/i];

export const VET_SERVICE_CODE="vet_consult" as const;
export const VET_SAC_CODE="998351" as const;
export const VET_VISIT_FEE_PAISE=59900 as const;
export const VET_TAX_PAISE=0 as const;

export const vetTriageEvaluateToolSchema={
 name:"vet.triage.evaluate",description:"Safety-first veterinary symptom routing. Detects emergency red flags and determines whether doorstep vet booking is allowed; never diagnoses or prescribes.",
 input_schema:{type:"object",additionalProperties:false,required:["customer_id","pet_id","symptoms"],properties:{customer_id:{type:"string",minLength:1},pet_id:{type:"string",minLength:1},symptoms:{type:"string",minLength:2,maxLength:4000},duration:{type:"string",maxLength:300},age_years:{type:"number",minimum:0,maximum:100},species:{type:"string",maxLength:80},known_conditions:{type:"array",items:{type:"string",maxLength:200},maxItems:20}}}
} as const;

export const financeVetPayoutCalculateToolSchema={
 name:"finance.vet_payout.calculate",description:"Computes the governed financial treatment of a completed vet visit. Commission vets use an approved revenue share; full-time vets record a salaried KPI. Veterinary consultation tax is physically fixed at zero.",
 input_schema:{type:"object",additionalProperties:false,required:["appointment_id","provider_id"],properties:{appointment_id:{type:"string",minLength:1},provider_id:{type:"string",minLength:1},actor_id:{type:"string",minLength:1}}}
} as const;

export function evaluateVetTriage(input:{symptoms:string}){
 const symptoms=text(input.symptoms);if(!symptoms)throw new Error("Symptoms are required");
 const emergency=emergencyPatterns.filter(p=>p.test(symptoms)).map(p=>p.source);
 if(emergency.length)return{level:"emergency" as const,bookable:false,requiresHumanEscalation:true,action:"immediate_emergency_handoff",matchedRedFlags:emergency,diagnosis:null,medicationAdvice:null};
 const urgent=urgentPatterns.some(p=>p.test(symptoms));
 return{level:urgent?"urgent" as const:"routine" as const,bookable:true,requiresHumanEscalation:false,action:"doorstep_vet_booking_allowed",feePaise:VET_VISIT_FEE_PAISE,taxPaise:VET_TAX_PAISE,sacCode:VET_SAC_CODE,diagnosis:null,medicationAdvice:null};
}

export async function ensureVetHealthcareTables(db:D1Database){await ensureProviderCapacityTables(db);await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS vet_appointments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT NOT NULL,pet_id TEXT NOT NULL,provider_id TEXT,triage_level TEXT NOT NULL CHECK(triage_level IN ('emergency','urgent','routine')),triage_summary TEXT NOT NULL,symptom_json TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL DEFAULT 'triaged',scheduled_start TEXT,scheduled_end TEXT,consultation_fee_paise INTEGER NOT NULL DEFAULT 59900 CHECK(consultation_fee_paise=59900),service_code TEXT NOT NULL DEFAULT 'vet_consult' CHECK(service_code='vet_consult'),sac_code TEXT NOT NULL DEFAULT '998351' CHECK(sac_code='998351'),tax_paise INTEGER NOT NULL DEFAULT 0 CHECK(tax_paise=0),emergency_handoff_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS vet_prescriptions (id TEXT PRIMARY KEY,appointment_id TEXT NOT NULL,booking_id TEXT,provider_id TEXT NOT NULL,source_type TEXT NOT NULL CHECK(source_type IN ('handwritten_upload','voice_dictation','typed_notes')),source_media_ref TEXT,draft_json TEXT NOT NULL,pdf_file_ref TEXT,status TEXT NOT NULL DEFAULT 'draft_for_vet_review' CHECK(status IN ('draft_for_vet_review','signed','void')),veterinarian_signature_ref TEXT,signed_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS vet_provider_payout_terms (id TEXT PRIMARY KEY,provider_id TEXT,provider_share_bps INTEGER NOT NULL CHECK(provider_share_bps BETWEEN 0 AND 10000),status TEXT NOT NULL DEFAULT 'draft',effective_from TEXT NOT NULL,created_by TEXT NOT NULL,approved_by TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS vet_visit_kpis (id TEXT PRIMARY KEY,appointment_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,contract_type TEXT NOT NULL CHECK(contract_type IN ('full_time','commission')),visit_count INTEGER NOT NULL DEFAULT 1 CHECK(visit_count=1),provider_payout_paise INTEGER NOT NULL DEFAULT 0 CHECK(provider_payout_paise>=0),platform_retained_paise INTEGER NOT NULL DEFAULT 0 CHECK(platform_retained_paise>=0),tax_paise INTEGER NOT NULL DEFAULT 0 CHECK(tax_paise=0),created_at INTEGER NOT NULL)"),
]);}

export async function verifyVetVciRegistration(db:D1Database,env:Record<string,unknown>,input:{providerId:string;vciRegistrationNumber:string;actorId:string}){
 await ensureVetHealthcareTables(db);const number=text(input.vciRegistrationNumber);if(!number)throw new Error("VCI registration number is required");
 if(!idfyConfigured(env))throw new Response("IDfy is not configured; Vet dispatch remains blocked",{status:503});
 const result=await verifyWithIdfy(env,{checkType:"vci_registration",referenceId:`${input.providerId}:vci:${number}`,payload:{vci_registration_number:number}});
 if(!result.connected||result.status!=="verified")throw new Response("VCI registration has not been verified by IDfy; Vet dispatch remains blocked",{status:409});
 await db.prepare("UPDATE provider_capacity_profiles SET vci_registration_number=?,vci_verification_status='verified',vci_provider_ref=?,updated_by=?,updated_at=? WHERE id=?").bind(number,result.reference??null,input.actorId,Date.now(),input.providerId).run();
 return{providerId:input.providerId,vciRegistrationNumber:number,status:"verified",providerRef:result.reference??null};
}

export async function calculateVetPayout(db:D1Database,input:{appointmentId:string;providerId:string;actorId:string}){
 await ensureVetHealthcareTables(db);const appointment=await db.prepare("SELECT consultation_fee_paise,tax_paise,status FROM vet_appointments WHERE id=? AND provider_id=?").bind(input.appointmentId,input.providerId).first<Row>();if(!appointment)throw new Error("Vet appointment not found for provider");
 const profile=await db.prepare("SELECT contract_type,provider_model,vci_verification_status FROM provider_capacity_profiles WHERE id=?").bind(input.providerId).first<Row>();if(!profile)throw new Error("Vet provider profile not found");if(text(profile.vci_verification_status)!=="verified")throw new Error("VCI verification is required before Vet financial completion");
 const contractType=(text(profile.contract_type)|| (text(profile.provider_model)==="full_time"?"full_time":"commission")) as "full_time"|"commission";const fee=Number(appointment.consultation_fee_paise||VET_VISIT_FEE_PAISE);if(Number(appointment.tax_paise)!==0)throw new Error("Vet GST invariant violated: tax_paise must be zero");
 let payout=0,retained=fee,shareBps=0;if(contractType==="commission"){
  const today=new Date().toISOString().slice(0,10);const term=await db.prepare("SELECT provider_share_bps FROM vet_provider_payout_terms WHERE status='active' AND effective_from<=? AND (provider_id=? OR provider_id IS NULL) ORDER BY CASE WHEN provider_id=? THEN 0 ELSE 1 END,effective_from DESC LIMIT 1").bind(today,input.providerId,input.providerId).first<Row>();if(!term)throw new Error("No active Vet commission payout term is configured");shareBps=Number(term.provider_share_bps);payout=Math.round(fee*shareBps/10000);retained=fee-payout;
 }
 const id=`VETKPI-${crypto.randomUUID().slice(0,12).toUpperCase()}`;await db.prepare("INSERT INTO vet_visit_kpis (id,appointment_id,provider_id,contract_type,visit_count,provider_payout_paise,platform_retained_paise,tax_paise,created_at) VALUES (?,?,?,?,1,?,?,0,?) ON CONFLICT(appointment_id) DO UPDATE SET provider_id=excluded.provider_id,contract_type=excluded.contract_type,provider_payout_paise=excluded.provider_payout_paise,platform_retained_paise=excluded.platform_retained_paise,tax_paise=0").bind(id,input.appointmentId,input.providerId,contractType,payout,retained,Date.now()).run();
 return{appointmentId:input.appointmentId,providerId:input.providerId,contractType,visitKpi:1,feePaise:fee,providerShareBps:shareBps,providerPayoutPaise:payout,platformRetainedPaise:retained,taxPaise:0,gstRatePercent:0,sacCode:VET_SAC_CODE};
}

export async function digitizeVetPrescriptionDraft(db:D1Database,input:{appointmentId:string;providerId:string;sourceType:"handwritten_upload"|"voice_dictation"|"typed_notes";clinicalNotes:string;sourceMediaRef?:string|null}){
 await ensureVetHealthcareTables(db);const appointment=await db.prepare("SELECT id,booking_id,provider_id FROM vet_appointments WHERE id=?").bind(input.appointmentId).first<Row>();if(!appointment)throw new Error("Vet appointment not found");if(text(appointment.provider_id)!==input.providerId)throw new Error("Only the attending Vet may own this prescription draft");const id=`VETRX-${crypto.randomUUID().slice(0,12).toUpperCase()}`,now=Date.now(),draft={clinicalNotes:text(input.clinicalNotes),officialPrescription:false,requiresVeterinarianReviewAndSignature:true};await db.prepare("INSERT INTO vet_prescriptions (id,appointment_id,booking_id,provider_id,source_type,source_media_ref,draft_json,pdf_file_ref,status,veterinarian_signature_ref,signed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,NULL,'draft_for_vet_review',NULL,NULL,?,?)").bind(id,input.appointmentId,appointment.booking_id??null,input.providerId,input.sourceType,input.sourceMediaRef??null,JSON.stringify(draft),now,now).run();return{id,appointmentId:input.appointmentId,providerId:input.providerId,sourceType:input.sourceType,status:"draft_for_vet_review" as const,draft,pdfEligibleOnlyAfterVetSignature:true};
}
