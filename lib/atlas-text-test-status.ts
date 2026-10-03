import {APPROVAL,RESERVED_MICROS} from "./atlas-text-test-admission";
import {aiRuntimeQuotaConfiguration} from "./ai-provider-runtime-control";
/** Diagnostics only: never reserves, migrates, seeds, sweeps, fetches or returns binding values. */
export async function atlasTextTestStatus(db:D1Database,env:Record<string,unknown>,asOf=Date.now()){
 const value=(key:string)=>String(env[key]??"").trim();
 const bindings={jobIdPresent:Boolean(value("PAWSPACE_ATLAS_TEXT_TEST_JOB_ID")),jobIdMatchesApproved:value("PAWSPACE_ATLAS_TEXT_TEST_JOB_ID")===APPROVAL.jobId,isolationFlagTrue:value("PAWSPACE_ISOLATED_FINANCE_TEST")==="true",descriptorMatchesApproved:value("PAWSPACE_FINANCE_TEST_DESCRIPTOR")===APPROVAL.fixture,deploymentMatchesStaging:value("PAWSPACE_DEPLOYMENT_ENV")==="staging"};
 let ledger:{status:string;present:boolean|null;requests?:number;retainedMicros?:number;outstandingOrUnknown?:number}={status:"unavailable",present:null};
 try{const table=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='atlas_text_test_requests'").first<{name:string}>();
 if(!table)ledger={status:"missing",present:false};
 else{const row=await db.prepare("SELECT COUNT(*) requests,COALESCE(SUM(reserved_micros),0) retained,COALESCE(SUM(CASE WHEN status IN ('reserved','unknown') THEN 1 ELSE 0 END),0) stopped FROM atlas_text_test_requests WHERE job_id=?").bind(APPROVAL.jobId).first<{requests:number;retained:number;stopped:number}>();if(!row)throw Error("missing aggregate");ledger={status:"read",present:true,requests:Number(row.requests),retainedMicros:Number(row.retained),outstandingOrUnknown:Number(row.stopped)};}
 }catch{ledger={status:"unavailable",present:null};}
 const metadata=env.PAWSPACE_VERSION_METADATA&&typeof env.PAWSPACE_VERSION_METADATA==="object"?env.PAWSPACE_VERSION_METADATA as Record<string,unknown>:{};
 const uuid=String(metadata.id??"");const versionId=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)?uuid:null;
 return{observedAt:new Date(asOf).toISOString(),versionId,bindings,approval:{jobId:APPROVAL.jobId,customerId:APPROVAL.customerId,expiresAt:new Date(APPROVAL.expiresAt).toISOString(),expired:asOf>=APPROVAL.expiresAt,notStarted:asOf<APPROVAL.startsAt,capMicros:APPROVAL.capMicros,maxTurns:APPROVAL.maxTurns,reservationPerRequestMicros:RESERVED_MICROS},ledger,quotaLimits:aiRuntimeQuotaConfiguration(env),diagnosticOnly:true,transportIsolationProven:false};
}
