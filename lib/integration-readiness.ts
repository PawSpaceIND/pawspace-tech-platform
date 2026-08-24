import { VOICE_TELEPHONY_SECRET_NAMES } from "./voice-call-gate";
export type IntegrationReadinessState=
  |"not_started"|"code_ready"|"sandbox_setup_required"|"sandbox_ready_for_test"|"sandbox_verified"
  |"production_setup_required"|"production_ready_for_controlled_test"|"controlled_live_verified"|"blocked"|"not_applicable";
export type IntegrationEnvironment="none"|"mock"|"sandbox"|"production";
export type CredentialStatus="unknown"|"missing"|"configured"|"not_required";
export type EvidenceStatus="not_tested"|"not_required"|"documented"|"verified"|"blocked";
export type CodeBoundaryStatus="not_started"|"partial"|"code_ready";

type Row=Record<string,unknown>;
type Db=D1Database;

type Seed={
  code:string;capability:string;provider:string;category:string;owner:string;backupOwner:string;priority:"P0"|"P1"|"P2";required:boolean;
  environment:IntegrationEnvironment;codeBoundaryStatus:CodeBoundaryStatus;readinessState:IntegrationReadinessState;credentialDetector?:string;
  dataClassification:string;launchGateCode?:string;notes:string;
};

export const integrationReadinessStates:IntegrationReadinessState[]=[
  "not_started","code_ready","sandbox_setup_required","sandbox_ready_for_test","sandbox_verified","production_setup_required",
  "production_ready_for_controlled_test","controlled_live_verified","blocked","not_applicable",
];
export const integrationEvidenceStates:EvidenceStatus[]=["not_tested","not_required","documented","verified","blocked"];
export const integrationEnvironments:IntegrationEnvironment[]=["none","mock","sandbox","production"];
export const integrationCredentialStates:CredentialStatus[]=["unknown","missing","configured","not_required"];
export const integrationCodeBoundaryStates:CodeBoundaryStatus[]=["not_started","partial","code_ready"];

const seeds:Seed[]=[
 {code:"INT-PAY-01",capability:"Customer payment gateway",provider:"Razorpay",category:"payments",owner:"Finance + Engineering",backupOwner:"Operations",priority:"P0",required:true,environment:"sandbox",codeBoundaryStatus:"code_ready",readinessState:"code_ready",credentialDetector:"razorpay_sandbox",dataClassification:"financial + customer identifiers",launchGateCode:"PAY-01",notes:"Signed sandbox webhook and payment/refund reconciliation boundary exist; live mode remains disabled."},
 {code:"INT-PAY-02",capability:"Provider/customer payout rails",provider:"Provider not selected",category:"payments",owner:"Finance",backupOwner:"Engineering",priority:"P1",required:true,environment:"none",codeBoundaryStatus:"partial",readinessState:"production_setup_required",dataClassification:"financial + beneficiary data",launchGateCode:"FIN-01",notes:"Canonical settlement/refund readiness exists; live payout rail is not connected."},
 {code:"INT-COMMS-01",capability:"WhatsApp messaging",provider:"LimeChat / Meta WhatsApp",category:"communications",owner:"CRM/CX + Engineering",backupOwner:"Operations",priority:"P0",required:true,environment:"sandbox",codeBoundaryStatus:"code_ready",readinessState:"sandbox_setup_required",credentialDetector:"wati",dataClassification:"customer contact + transactional content",launchGateCode:"COMMS-01",notes:"Canonical outbox, delivery events, retry/dead-letter and adapter readiness exist."},
 {code:"INT-COMMS-02",capability:"SMS messaging",provider:"Exotel SMS / configured SMS provider",category:"communications",owner:"CRM/CX + Engineering",backupOwner:"Operations",priority:"P1",required:true,environment:"sandbox",codeBoundaryStatus:"code_ready",readinessState:"sandbox_setup_required",credentialDetector:"sms",dataClassification:"customer contact + transactional content",launchGateCode:"COMMS-01",notes:"Canonical communications adapter boundary exists."},
 {code:"INT-COMMS-03",capability:"Email delivery",provider:"Provider not selected",category:"communications",owner:"CRM/CX",backupOwner:"Finance",priority:"P1",required:true,environment:"none",codeBoundaryStatus:"code_ready",readinessState:"not_started",dataClassification:"customer contact + documents",launchGateCode:"COMMS-01",notes:"Canonical email channel exists; external provider execution is not connected."},
 {code:"INT-COMMS-04",capability:"Push notifications",provider:"Provider not selected",category:"communications",owner:"Product + Engineering",backupOwner:"Operations",priority:"P1",required:true,environment:"none",codeBoundaryStatus:"code_ready",readinessState:"not_started",dataClassification:"device token + transactional metadata",launchGateCode:"COMMS-01",notes:"Canonical push channel exists; external push provider is not connected."},
 {code:"INT-VOICE-01",capability:"Telephony / call tracking",provider:"Exotel",category:"communications",owner:"Sales/CX + Engineering",backupOwner:"Operations",priority:"P1",required:true,environment:"sandbox",codeBoundaryStatus:"code_ready",readinessState:"sandbox_setup_required",credentialDetector:"exotel",dataClassification:"customer contact + call metadata",notes:"Provider contract, call state machine, pre-dial policy gate, signed callback receiver and audit exist (lib/voice-outbound-governance.ts). No credentials in any environment, so no call has ever been placed: credential presence is not proof of call/webhook/recording compliance. Setup steps in docs/VOICE_UAT_CHECKLIST.md."},
 {code:"INT-MAPS-01",capability:"Maps / geocoding / routing",provider:"Google Routes",category:"location",owner:"Operations + Engineering",backupOwner:"Product",priority:"P1",required:true,environment:"sandbox",codeBoundaryStatus:"code_ready",readinessState:"production_setup_required",credentialDetector:"maps_uat",dataClassification:"service address + route data",notes:"Routes adapter is sandbox-locked and stores route snapshots."},

 // Physical-device certification is its own dependency, not a corollary of the location integration.
 // INT-GPS-01 covers whether a location EVENT can be trusted once it arrives; these two cover whether
 // the journey that produces it has ever been executed on real hardware. Permission grant/denial,
 // foreground/background transition and retry-without-duplicate-state are operating-system behaviours
 // that no server-side suite can observe - PR #305 proved the server halves and said so explicitly.
 // readinessState is not_started because no device journey has been run, on any handset, ever.
 {code:"INT-DEVICE-01",capability:"Android physical-device journey certification",provider:"Allow-listed Android handsets",category:"device",owner:"Engineering + Operations",backupOwner:"Product",priority:"P1",required:true,environment:"none",codeBoundaryStatus:"partial",readinessState:"not_started",dataClassification:"precise location + provider identity + device permissions",notes:"Server-side halves are executable and proven (PR #305). Permission granted/denied, foreground/background transition, stale and low-accuracy capture, and retry without duplicate durable state have never been executed on a physical Android device. No device lab and no allow-listed handsets exist."},
 {code:"INT-DEVICE-02",capability:"iOS physical-device journey certification",provider:"Allow-listed iOS handsets",category:"device",owner:"Engineering + Operations",backupOwner:"Product",priority:"P1",required:true,environment:"none",codeBoundaryStatus:"partial",readinessState:"not_started",dataClassification:"precise location + provider identity + device permissions",notes:"Server-side halves are executable and proven (PR #305). Permission granted/denied, foreground/background transition, stale and low-accuracy capture, and retry without duplicate durable state have never been executed on a physical iOS device. No device lab and no allow-listed handsets exist."},
 {code:"INT-GPS-01",capability:"Provider GPS/location evidence",provider:"Device location + route provider",category:"location",owner:"Operations + Safety + Engineering",backupOwner:"Security",priority:"P1",required:true,environment:"sandbox",codeBoundaryStatus:"code_ready",readinessState:"production_setup_required",dataClassification:"precise location + booking/provider identity",notes:"Canonical provider location events exist; production device trust and retention policy remain unverified."},
 {code:"INT-KYC-01",capability:"Provider KYC / identity verification",provider:"IDfy",category:"provider_compliance",owner:"Operations + Compliance",backupOwner:"Engineering + Security",priority:"P0",required:true,environment:"none",codeBoundaryStatus:"code_ready",readinessState:"production_setup_required",credentialDetector:"idfy",dataClassification:"provider identity + private documents",notes:"IDfy request and signed callback boundaries now exist with correlation, replay handling and terminal-state protection. No live IDfy account or callback traffic has been verified; credential presence alone must never approve a provider or establish readiness."},
 {code:"INT-MEDIA-01",capability:"Private object storage",provider:"Provider not selected",category:"media",owner:"Engineering + Security",backupOwner:"Operations",priority:"P1",required:true,environment:"none",codeBoundaryStatus:"code_ready",readinessState:"production_setup_required",dataClassification:"service evidence + private documents",notes:"Media lifecycle is canonical but storage backend reports not_connected."},
 {code:"INT-MEDIA-02",capability:"Malware/content scanning",provider:"Provider not selected",category:"media",owner:"Security + Engineering",backupOwner:"Operations",priority:"P1",required:true,environment:"none",codeBoundaryStatus:"partial",readinessState:"production_setup_required",dataClassification:"uploaded private media/documents",notes:"Application scan state exists; independent scanner integration is not proven."},
 {code:"INT-BANK-01",capability:"Bank feed / reconciliation",provider:"Bank/feed provider not selected",category:"finance",owner:"Finance",backupOwner:"Engineering",priority:"P1",required:true,environment:"none",codeBoundaryStatus:"partial",readinessState:"production_setup_required",dataClassification:"bank transaction data",launchGateCode:"FIN-01",notes:"Finance bank transaction import/reconciliation model exists; live feed is unverified."},
 {code:"INT-ACCT-01",capability:"Accounting platform export",provider:"Tally / Zoho Books / selected target",category:"finance",owner:"Finance + CA/Accounting",backupOwner:"Engineering",priority:"P1",required:true,environment:"none",codeBoundaryStatus:"partial",readinessState:"production_setup_required",dataClassification:"accounting + tax data",launchGateCode:"FIN-01",notes:"Export readiness exists; target acknowledgement and versioned mapping verification remain required."},
 {code:"INT-TAX-01",capability:"GST/statutory filing boundary",provider:"Selected filing interface / manual export",category:"finance",owner:"Finance + CA",backupOwner:"Engineering",priority:"P1",required:true,environment:"none",codeBoundaryStatus:"partial",readinessState:"production_setup_required",dataClassification:"statutory + tax data",launchGateCode:"FIN-01",notes:"No live statutory filing is enabled by this control plane."},
 {code:"INT-MKT-01",capability:"Google Ads",provider:"Google Ads",category:"marketing",owner:"Marketing + Analytics",backupOwner:"Finance",priority:"P2",required:false,environment:"sandbox",codeBoundaryStatus:"partial",readinessState:"production_setup_required",dataClassification:"campaign + attribution data",notes:"Marketing control has sandbox metadata; autonomous spend remains prohibited."},
 {code:"INT-MKT-02",capability:"Meta Ads",provider:"Meta",category:"marketing",owner:"Marketing + Analytics",backupOwner:"Finance",priority:"P2",required:false,environment:"sandbox",codeBoundaryStatus:"partial",readinessState:"production_setup_required",dataClassification:"campaign + attribution data",notes:"Marketing control has sandbox metadata; autonomous spend remains prohibited."},
 {code:"INT-ANALYTICS-01",capability:"GA4 / product analytics",provider:"Google Analytics",category:"analytics",owner:"Product + Marketing + Analytics",backupOwner:"Security",priority:"P2",required:false,environment:"none",codeBoundaryStatus:"partial",readinessState:"production_setup_required",dataClassification:"pseudonymous product/marketing events",notes:"Event/privacy verification and production property evidence are required."},
 {code:"INT-AI-01",capability:"External AI provider",provider:"Provider not approved",category:"ai",owner:"Product + Security + Engineering",backupOwner:"Operations",priority:"P2",required:false,environment:"none",codeBoundaryStatus:"partial",readinessState:"production_setup_required",credentialDetector:"ai_provider",dataClassification:"minimum-necessary governed context",notes:"External provider is not considered connected by default; autonomous governed actions remain prohibited."},
 {code:"INT-AUTH-01",capability:"Production identity / access provisioning",provider:"Identity/session platform",category:"security",owner:"Security + Engineering",backupOwner:"Founder/Admin",priority:"P1",required:true,environment:"none",codeBoundaryStatus:"code_ready",readinessState:"production_setup_required",dataClassification:"identity + role/access data",notes:"Canonical sessions/RBAC exist; production MFA and joiner/mover/leaver evidence remain required."},
 {code:"INT-OBS-01",capability:"Monitoring / alerting / error tracking",provider:"Provider not selected",category:"reliability",owner:"Engineering",backupOwner:"Operations",priority:"P0",required:true,environment:"none",codeBoundaryStatus:"partial",readinessState:"production_setup_required",dataClassification:"operational telemetry",launchGateCode:"REL-01",notes:"Production alerts and external-provider health evidence are not yet proven."},
 {code:"INT-BACKUP-01",capability:"Backup / restore",provider:"Platform backup facilities",category:"reliability",owner:"Engineering + Security",backupOwner:"Founder/Admin",priority:"P0",required:true,environment:"none",codeBoundaryStatus:"not_started",readinessState:"production_setup_required",dataClassification:"database + private object recovery",launchGateCode:"REL-01",notes:"Production readiness requires an actual restore rehearsal."},
 {code:"INT-SCHED-01",capability:"Scheduler / cron execution",provider:"Cloudflare scheduled execution",category:"reliability",owner:"Engineering",backupOwner:"Operations",priority:"P1",required:true,environment:"sandbox",codeBoundaryStatus:"code_ready",readinessState:"sandbox_setup_required",credentialDetector:"scheduler",dataClassification:"operational task metadata",notes:"Scheduler secret presence is tracked without exposing the value; execution/replay evidence is still required."},
];

function sqlBool(value:boolean){return value?1:0;}
function string(value:unknown){return value==null?"":String(value);}
function configured(runtime:Record<string,unknown>,names:string[]){return names.every(name=>string(runtime[name]).trim().length>0);}
function detectedCredentialStatus(runtime:Record<string,unknown>,detector:unknown):CredentialStatus|null{
 switch(String(detector||"")){
  case"razorpay_sandbox":return configured(runtime,["RAZORPAY_KEY_ID_SANDBOX","RAZORPAY_KEY_SECRET_SANDBOX","RAZORPAY_WEBHOOK_SECRET_SANDBOX"])?"configured":"missing";
  case"wati":return configured(runtime,["WATI_API_TOKEN","WATI_TENANT_URL"])?"configured":"missing";
  case"sms":return configured(runtime,["SMS_API_KEY","SMS_SENDER_ID"])?"configured":"missing";
  case"exotel":return configured(runtime,[...VOICE_TELEPHONY_SECRET_NAMES])?"configured":"missing";
  case"maps_uat":return configured(runtime,["GOOGLE_MAPS_SERVER_API_KEY_UAT"])?"configured":"missing";
  // IDFY_WEBHOOK_SECRET belongs here. IDfy verification is ASYNCHRONOUS: the submission credentials
  // enqueue a task, and the outcome arrives on a signed callback. lib/idfy-callback-boundary.ts refuses
  // every callback with 503 when the secret is absent, so submission credentials alone can never settle
  // a check - it can only ever reach `manual_review`. Reporting that state as "configured" told the
  // control plane a channel was connected while the half that carries the answer was switched off.
  case"idfy":return configured(runtime,["IDFY_API_KEY","IDFY_ACCOUNT_ID","IDFY_URL","IDFY_WEBHOOK_SECRET"])?"configured":"missing";
  case"scheduler":return configured(runtime,["AUTOMATION_CRON_SECRET"])?"configured":"missing";
  case"ai_provider":return configured(runtime,["PAWSPACE_AI_PROVIDER_API_KEY"])?"configured":"missing";
  default:return null;
 }
}

/**
 * Seeds are inserted with INSERT OR IGNORE, so correcting a seed value only reaches fresh databases -
 * any environment that already holds INT-VOICE-01 would keep code_boundary_status='partial' and the old
 * notes, and the readiness surface would report stale telephony information exactly where the
 * correction matters.
 *
 * Advanced only when the row has never been touched by a HUMAN: still on the old status, and last
 * written by one of this module's own automated writers. 'runtime_presence_check' has to be in that set -
 * syncIntegrationCredentialPresence stamps it whenever a credential's presence changes, so any database
 * where that has ever run would otherwise fail the predicate and keep the stale status forever, defeating
 * the migration entirely. An operator edit through updateIntegrationReadiness stamps the actor's own id
 * and is left alone.
 *
 * readiness_state is deliberately NOT touched - the provider still has no credentials anywhere, so it
 * stays sandbox_setup_required.
 */
async function advanceVoiceBoundarySeed(db:Db,now:number){
 const seed=seeds.find(item=>item.code==="INT-VOICE-01");
 if(!seed)return;
 await db.prepare("UPDATE integration_registry SET code_boundary_status=?,notes=?,updated_at=? WHERE integration_code='INT-VOICE-01' AND updated_by IN ('system_seed','runtime_presence_check') AND code_boundary_status='partial'")
  .bind(seed.codeBoundaryStatus,seed.notes,now).run();
}

/** Lane 2 added the authenticated IDfy callback after this registry seed shipped. Preserve any
 * operator-owned row, but advance untouched automated rows to the now-real code boundary. */
async function advanceIdfyBoundarySeed(db:Db,now:number){
 const seed=seeds.find(item=>item.code==="INT-KYC-01");
 if(!seed)return;
 await db.prepare("UPDATE integration_registry SET code_boundary_status=?,notes=?,updated_at=? WHERE integration_code='INT-KYC-01' AND updated_by IN ('system_seed','runtime_presence_check') AND code_boundary_status='partial'")
  .bind(seed.codeBoundaryStatus,seed.notes,now).run();
}

export async function ensureIntegrationReadinessTables(db:Db){
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS integration_registry (integration_code TEXT PRIMARY KEY,category TEXT NOT NULL,capability TEXT NOT NULL,provider TEXT NOT NULL,owner TEXT NOT NULL,backup_owner TEXT NOT NULL,priority TEXT NOT NULL,required INTEGER NOT NULL DEFAULT 1,launch_gate_code TEXT,environment TEXT NOT NULL DEFAULT 'none',code_boundary_status TEXT NOT NULL DEFAULT 'not_started',credential_status TEXT NOT NULL DEFAULT 'unknown',credential_detector TEXT,secret_reference TEXT,webhook_reference TEXT,auth_verification_status TEXT NOT NULL DEFAULT 'not_tested',webhook_verification_status TEXT NOT NULL DEFAULT 'not_tested',idempotency_status TEXT NOT NULL DEFAULT 'not_tested',idempotency_strategy TEXT,replay_status TEXT NOT NULL DEFAULT 'not_tested',replay_strategy TEXT,retry_status TEXT NOT NULL DEFAULT 'not_tested',retry_policy TEXT,dead_letter_status TEXT NOT NULL DEFAULT 'not_tested',dead_letter_reference TEXT,timeout_status TEXT NOT NULL DEFAULT 'not_tested',timeout_policy TEXT,rate_limit_status TEXT NOT NULL DEFAULT 'not_tested',rate_limit_policy TEXT,reconciliation_status TEXT NOT NULL DEFAULT 'not_tested',reconciliation_source TEXT,monitoring_status TEXT NOT NULL DEFAULT 'not_tested',monitoring_reference TEXT,audit_logging_status TEXT NOT NULL DEFAULT 'not_tested',data_classification TEXT NOT NULL,kill_switch_status TEXT NOT NULL DEFAULT 'not_tested',kill_switch_reference TEXT,readiness_state TEXT NOT NULL DEFAULT 'not_started',evidence_reference TEXT,blocker_reason TEXT,approval_reference TEXT,last_verified_at INTEGER,controlled_live_verified_at INTEGER,controlled_live_verified_by TEXT,notes TEXT NOT NULL,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS integration_readiness_events (id TEXT PRIMARY KEY,integration_code TEXT NOT NULL,event_type TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,actor_id TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS integration_readiness_events_code_idx ON integration_readiness_events(integration_code,created_at)"),
  // A durable record of one actual provider round trip. `evidence_reference` on the registry row was a
  // free-text string, so "verified in UAT" or "TODO" satisfied controlled-live verification exactly as
  // well as a provider call SID did. These five columns are the things that make a claim checkable
  // later: WHO on the provider side did something (provider_reference), against WHICH build
  // (commit_sha, an exact 40-hex commit and never a branch name), WHEN (observed_at), what was supposed
  // to happen versus what did (expected_result / actual_result), and WHERE the artefact still lives
  // (durable_reference, a resolvable pointer rather than prose).
  db.prepare("CREATE TABLE IF NOT EXISTS integration_live_evidence (id TEXT PRIMARY KEY,integration_code TEXT NOT NULL,scenario TEXT NOT NULL,provider_reference TEXT NOT NULL,commit_sha TEXT NOT NULL,observed_at INTEGER NOT NULL,expected_result TEXT NOT NULL,actual_result TEXT NOT NULL,matched INTEGER NOT NULL,evidence_kind TEXT NOT NULL,durable_reference TEXT NOT NULL,recorded_by TEXT NOT NULL,recorded_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS integration_live_evidence_code_idx ON integration_live_evidence(integration_code,observed_at)"),
  // What another closure lane needs proven before it can call its own integration closed. A lane can
  // file a request before anyone has credentials; the request stays open until a matching evidence row
  // exists, so the convergence view shows a queue rather than an assumption.
  db.prepare("CREATE TABLE IF NOT EXISTS integration_evidence_requests (id TEXT PRIMARY KEY,integration_code TEXT NOT NULL,lane TEXT NOT NULL,scenario TEXT NOT NULL,requirement TEXT NOT NULL,requested_by TEXT NOT NULL,requested_at INTEGER NOT NULL,satisfied_by TEXT,satisfied_at INTEGER)"),
  db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS integration_evidence_request_idx ON integration_evidence_requests(integration_code,lane,scenario)"),
  db.prepare("CREATE TABLE IF NOT EXISTS security_audit_events (id TEXT PRIMARY KEY, actor_email TEXT NOT NULL, actor_role TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, outcome TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL)"),
 ]);
 const now=Date.now();
 await advanceVoiceBoundarySeed(db,now);
 await advanceIdfyBoundarySeed(db,now);
 for(const item of seeds)await db.prepare("INSERT OR IGNORE INTO integration_registry (integration_code,category,capability,provider,owner,backup_owner,priority,required,launch_gate_code,environment,code_boundary_status,credential_status,credential_detector,data_classification,readiness_state,notes,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .bind(item.code,item.category,item.capability,item.provider,item.owner,item.backupOwner,item.priority,sqlBool(item.required),item.launchGateCode??null,item.environment,item.codeBoundaryStatus,item.credentialDetector?"unknown":"unknown",item.credentialDetector??null,item.dataClassification,item.readinessState,item.notes,"system_seed",now).run();
}

export async function syncIntegrationCredentialPresence(db:Db,runtime:Record<string,unknown>){
 await ensureIntegrationReadinessTables(db);const rows=await db.prepare("SELECT integration_code,credential_detector,credential_status FROM integration_registry WHERE credential_detector IS NOT NULL").all<Row>(),now=Date.now();
 for(const row of rows.results){const next=detectedCredentialStatus(runtime,row.credential_detector);if(!next||next===String(row.credential_status))continue;await db.prepare("UPDATE integration_registry SET credential_status=?,secret_reference=COALESCE(secret_reference,?),updated_by='runtime_presence_check',updated_at=? WHERE integration_code=?").bind(next,`env:${String(row.credential_detector)}`,now,row.integration_code).run();}
}

function publicRow(row:Row){return{
 integrationCode:string(row.integration_code),category:string(row.category),capability:string(row.capability),provider:string(row.provider),owner:string(row.owner),backupOwner:string(row.backup_owner),priority:string(row.priority),required:Number(row.required)===1,launchGateCode:row.launch_gate_code?string(row.launch_gate_code):null,
 environment:string(row.environment),codeBoundaryStatus:string(row.code_boundary_status),credentialStatus:string(row.credential_status),secretReference:row.secret_reference?string(row.secret_reference):null,webhookReference:row.webhook_reference?string(row.webhook_reference):null,
 authVerificationStatus:string(row.auth_verification_status),webhookVerificationStatus:string(row.webhook_verification_status),idempotencyStatus:string(row.idempotency_status),idempotencyStrategy:row.idempotency_strategy?string(row.idempotency_strategy):null,replayStatus:string(row.replay_status),replayStrategy:row.replay_strategy?string(row.replay_strategy):null,
 retryStatus:string(row.retry_status),retryPolicy:row.retry_policy?string(row.retry_policy):null,deadLetterStatus:string(row.dead_letter_status),deadLetterReference:row.dead_letter_reference?string(row.dead_letter_reference):null,timeoutStatus:string(row.timeout_status),timeoutPolicy:row.timeout_policy?string(row.timeout_policy):null,rateLimitStatus:string(row.rate_limit_status),rateLimitPolicy:row.rate_limit_policy?string(row.rate_limit_policy):null,
 reconciliationStatus:string(row.reconciliation_status),reconciliationSource:row.reconciliation_source?string(row.reconciliation_source):null,monitoringStatus:string(row.monitoring_status),monitoringReference:row.monitoring_reference?string(row.monitoring_reference):null,auditLoggingStatus:string(row.audit_logging_status),dataClassification:string(row.data_classification),killSwitchStatus:string(row.kill_switch_status),killSwitchReference:row.kill_switch_reference?string(row.kill_switch_reference):null,
 readinessState:string(row.readiness_state),evidenceReference:row.evidence_reference?string(row.evidence_reference):null,blockerReason:row.blocker_reason?string(row.blocker_reason):null,approvalReference:row.approval_reference?string(row.approval_reference):null,lastVerifiedAt:row.last_verified_at==null?null:Number(row.last_verified_at),controlledLiveVerifiedAt:row.controlled_live_verified_at==null?null:Number(row.controlled_live_verified_at),controlledLiveVerifiedBy:row.controlled_live_verified_by?string(row.controlled_live_verified_by):null,notes:string(row.notes),updatedBy:string(row.updated_by),updatedAt:Number(row.updated_at||0),
};}

export async function listIntegrationReadiness(db:Db,runtime?:Record<string,unknown>){
 await ensureIntegrationReadinessTables(db);if(runtime)await syncIntegrationCredentialPresence(db,runtime);const rows=await db.prepare("SELECT * FROM integration_registry ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END,category,integration_code").all<Row>();const items=rows.results.map(publicRow),p0=items.filter(item=>item.priority==="P0"&&item.required),controlled=items.filter(item=>item.readinessState==="controlled_live_verified");return{items,summary:{total:items.length,required:items.filter(item=>item.required).length,p0Required:p0.length,p0ControlledLive:p0.filter(item=>item.readinessState==="controlled_live_verified").length,controlledLiveVerified:controlled.length,productionReady:p0.length>0&&p0.every(item=>item.readinessState==="controlled_live_verified")},productionReady:false as const};
}

const evidenceColumns=new Set(["auth_verification_status","webhook_verification_status","idempotency_status","replay_status","retry_status","dead_letter_status","timeout_status","rate_limit_status","reconciliation_status","monitoring_status","audit_logging_status","kill_switch_status"]);
const editableColumns=new Map<string,string>([
 ["provider","provider"],["owner","owner"],["backupOwner","backup_owner"],["environment","environment"],["codeBoundaryStatus","code_boundary_status"],["credentialStatus","credential_status"],["secretReference","secret_reference"],["webhookReference","webhook_reference"],
 ["authVerificationStatus","auth_verification_status"],["webhookVerificationStatus","webhook_verification_status"],["idempotencyStatus","idempotency_status"],["idempotencyStrategy","idempotency_strategy"],["replayStatus","replay_status"],["replayStrategy","replay_strategy"],["retryStatus","retry_status"],["retryPolicy","retry_policy"],["deadLetterStatus","dead_letter_status"],["deadLetterReference","dead_letter_reference"],["timeoutStatus","timeout_status"],["timeoutPolicy","timeout_policy"],["rateLimitStatus","rate_limit_status"],["rateLimitPolicy","rate_limit_policy"],
 ["reconciliationStatus","reconciliation_status"],["reconciliationSource","reconciliation_source"],["monitoringStatus","monitoring_status"],["monitoringReference","monitoring_reference"],["auditLoggingStatus","audit_logging_status"],["dataClassification","data_classification"],["killSwitchStatus","kill_switch_status"],["killSwitchReference","kill_switch_reference"],["readinessState","readiness_state"],["evidenceReference","evidence_reference"],["blockerReason","blocker_reason"],["approvalReference","approval_reference"],["notes","notes"],
]);
function allowedEvidence(value:unknown){return integrationEvidenceStates.includes(String(value) as EvidenceStatus);}
function completeForControlledLive(row:Row){const missing:string[]=[];if(String(row.environment)!=="production")missing.push("production environment");if(String(row.code_boundary_status)!=="code_ready")missing.push("code boundary");if(!["configured","not_required"].includes(String(row.credential_status)))missing.push("credentials");for(const column of evidenceColumns)if(!["verified","not_required"].includes(String(row[column])))missing.push(column.replaceAll("_"," "));if(!string(row.evidence_reference).trim())missing.push("evidence reference");if(!string(row.approval_reference).trim())missing.push("approval reference");return missing;}

/**
 * The evidence_reference column is free text, so before this every one of the twelve status columns
 * could read "verified" and the reference could read "verified in UAT" - and the registry would report
 * an integration as controlled-live verified with nothing anywhere that anyone could check. Controlled
 * live now additionally requires a stored evidence row that MATCHED, and requires evidence_reference to
 * name it, so the claim and the artefact cannot drift apart.
 *
 * Credential presence deliberately does not appear here beyond the existing configured/not_required
 * check: a key on disk is configuration, and syncIntegrationCredentialPresence never touches
 * readiness_state (proved in tests/integration-readiness-live-evidence.test.mjs).
 */
async function liveEvidenceGap(db:Db,row:Row){
 const reference=string(row.evidence_reference).trim();
 const evidence=await db.prepare("SELECT id,matched,commit_sha,observed_at FROM integration_live_evidence WHERE integration_code=? AND matched=1 ORDER BY observed_at DESC LIMIT 1").bind(string(row.integration_code)).first<Row>();
 if(!evidence)return"a recorded live-evidence observation whose expected and actual result matched";
 const expectedReference=`live-evidence:${string(evidence.id)}`;
 if(reference!==expectedReference)return`evidence reference pointing at the recorded observation (expected ${expectedReference})`;
 return null;
}

export type IntegrationEvidenceKind="provider_api_response"|"provider_webhook_receipt"|"provider_dashboard_record"|"platform_audit_row"|"platform_ledger_row";
export const integrationEvidenceKinds:IntegrationEvidenceKind[]=["provider_api_response","provider_webhook_receipt","provider_dashboard_record","platform_audit_row","platform_ledger_row"];

/** Values that look like evidence and are not. A reference has to identify something. */
const PLACEHOLDER=/^(todo|tbd|t\.b\.d\.?|n\/?a|none|null|nil|pending|unknown|xxx+|test|placeholder|-+|\?+)$/i;
/** Locally resolvable pointer forms. External evidence must first be mirrored into a durable row. */
const DURABLE_REFERENCE=/^(?:audit:[A-Za-z0-9_./#-]{3,}|(?:d1|ledger):[A-Za-z_][A-Za-z0-9_]*:[A-Za-z0-9_./:#-]{3,})$/;

/**
 * Which pointer schemes each evidence kind may use.
 *
 * The shape check alone let any kind carry any scheme, so a `provider_dashboard_record` could point at
 * `ledger:something` and a `platform_audit_row` at `provider:whatever`. Provider-side artefacts must
 * be mirrored into D1 before they can support readiness, because this database boundary cannot prove an
 * R2 key or dashboard URL exists. The referenced local row is dereferenced before evidence is stored.
 */
const REFERENCE_SCHEMES_FOR_KIND:Record<string,string[]>={
 provider_api_response:["ledger","d1","audit"],
 provider_webhook_receipt:["ledger","d1","audit"],
 provider_dashboard_record:["ledger","d1","audit"],
 platform_audit_row:["audit","d1"],
 platform_ledger_row:["ledger","d1"],
};
async function requireDurableTarget(db:Db,reference:string){
 const [scheme,first,...rest]=reference.split(":");
 const table=scheme==="audit"?"security_audit_events":first;
 const id=scheme==="audit"?first:rest.join(":");
 if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)||!id)throw new Error("Evidence durable reference must identify a local table and row");
 const exists=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(table).first<Row>();
 if(!exists)throw new Error(`Evidence durable reference could not be resolved: table ${table} does not exist`);
 const target=await db.prepare(`SELECT id FROM "${table}" WHERE id=? LIMIT 1`).bind(id).first<Row>();
 if(!target)throw new Error(`Evidence durable reference could not be resolved: ${reference}`);
}
const EXACT_SHA=/^[0-9a-f]{40}$/;
const EARLIEST_PLAUSIBLE_OBSERVATION=Date.UTC(2025,0,1);

export type IntegrationLiveEvidenceInput={
 integrationCode:string;scenario:string;providerReference:string;commitSha:string;observedAt:number;
 expectedResult:string;actualResult:string;evidenceKind:IntegrationEvidenceKind;durableReference:string;recordedBy:string;
};

/**
 * Records one actual provider round trip.
 *
 * Every rejection here is a way a registry row could otherwise claim controlled-live verification
 * without anything having happened: a branch name where an exact commit belongs, a provider reference
 * of "TODO", an observation timestamp in the future, an artefact described in prose that nobody can
 * fetch, or an expected result that did not match the actual one. A mismatch is still RECORDED - it is
 * a real observation and the audit trail should keep it - but `matched` is false and a row with
 * matched=0 can never support verification.
 */
export async function recordIntegrationLiveEvidence(db:Db,input:IntegrationLiveEvidenceInput,now=Date.now()){
 await ensureIntegrationReadinessTables(db);
 const exists=await db.prepare("SELECT integration_code FROM integration_registry WHERE integration_code=?").bind(input.integrationCode).first<Row>();
 if(!exists)throw new Error("Integration not found");
 const scenario=string(input.scenario).trim();
 const providerReference=string(input.providerReference).trim();
 const commitSha=string(input.commitSha).trim().toLowerCase();
 const expected=string(input.expectedResult).trim();
 const actual=string(input.actualResult).trim();
 const durableReference=string(input.durableReference).trim();
 const recordedBy=string(input.recordedBy).trim();

 if(scenario.length<4)throw new Error("Evidence requires the scenario it proves");
 if(providerReference.length<6||PLACEHOLDER.test(providerReference))throw new Error("Evidence requires a real provider-side reference, not a placeholder");
 if(!EXACT_SHA.test(commitSha))throw new Error("Evidence requires the exact 40-character commit SHA it was observed against");
 if(/^0{40}$/.test(commitSha))throw new Error("Evidence requires a real commit SHA");
 if(!Number.isInteger(input.observedAt)||input.observedAt<EARLIEST_PLAUSIBLE_OBSERVATION)throw new Error("Evidence requires the timestamp it was observed at");
 if(input.observedAt>now+60_000)throw new Error("Evidence cannot be observed in the future");
 if(expected.length<4||PLACEHOLDER.test(expected))throw new Error("Evidence requires the expected result");
 if(actual.length<4||PLACEHOLDER.test(actual))throw new Error("Evidence requires the actual result");
 if(!integrationEvidenceKinds.includes(input.evidenceKind))throw new Error("Invalid evidence kind");
 if(!DURABLE_REFERENCE.test(durableReference))throw new Error("Evidence requires a locally resolvable durable reference (audit:<id> or d1/ledger:<table>:<id>), never prose");
 const scheme=durableReference.split(":")[0];
 const allowedSchemes=REFERENCE_SCHEMES_FOR_KIND[input.evidenceKind]??[];
 if(!allowedSchemes.includes(scheme))throw new Error(`A ${input.evidenceKind} cannot be evidenced by a ${scheme}: reference (expected ${allowedSchemes.join(":/ ")}:)`);
 if(!recordedBy)throw new Error("Evidence requires the person who recorded it");
 await requireDurableTarget(db,durableReference);

 const matched=expected.toLowerCase()===actual.toLowerCase();
 const id=`INTEV-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
 await db.prepare("INSERT INTO integration_live_evidence (id,integration_code,scenario,provider_reference,commit_sha,observed_at,expected_result,actual_result,matched,evidence_kind,durable_reference,recorded_by,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .bind(id,input.integrationCode,scenario,providerReference,commitSha,input.observedAt,expected,actual,sqlBool(matched),input.evidenceKind,durableReference,recordedBy,now).run();
 await db.prepare("UPDATE integration_evidence_requests SET satisfied_by=?,satisfied_at=? WHERE integration_code=? AND scenario=? AND satisfied_by IS NULL AND ?=1")
  .bind(id,now,input.integrationCode,scenario,sqlBool(matched)).run();
 await db.prepare("INSERT INTO integration_readiness_events (id,integration_code,event_type,before_json,after_json,actor_id,reason,created_at) VALUES (?,?,?,?,?,?,?,?)")
  .bind(crypto.randomUUID(),input.integrationCode,"live_evidence_recorded",null,JSON.stringify({id,scenario,commitSha,observedAt:input.observedAt,matched,evidenceKind:input.evidenceKind,durableReference}),recordedBy,`Live evidence for ${scenario}`,now).run();
 return{id,integrationCode:input.integrationCode,scenario,matched,commitSha,observedAt:input.observedAt,evidenceKind:input.evidenceKind,durableReference};
}

export async function integrationLiveEvidence(db:Db,integrationCode:string){
 await ensureIntegrationReadinessTables(db);
 const rows=await db.prepare("SELECT id,scenario,provider_reference,commit_sha,observed_at,expected_result,actual_result,matched,evidence_kind,durable_reference,recorded_by,recorded_at FROM integration_live_evidence WHERE integration_code=? ORDER BY observed_at DESC").bind(integrationCode).all<Row>();
 return rows.results.map(row=>({id:string(row.id),scenario:string(row.scenario),providerReference:string(row.provider_reference),commitSha:string(row.commit_sha),observedAt:Number(row.observed_at),expectedResult:string(row.expected_result),actualResult:string(row.actual_result),matched:Number(row.matched)===1,evidenceKind:string(row.evidence_kind),durableReference:string(row.durable_reference),recordedBy:string(row.recorded_by),recordedAt:Number(row.recorded_at)}));
}

/** A closure lane's request for proof it cannot produce itself. Idempotent per code+lane+scenario. */
export async function requestIntegrationEvidence(db:Db,input:{integrationCode:string;lane:string;scenario:string;requirement:string;requestedBy:string},now=Date.now()){
 await ensureIntegrationReadinessTables(db);
 const exists=await db.prepare("SELECT integration_code FROM integration_registry WHERE integration_code=?").bind(input.integrationCode).first<Row>();
 if(!exists)throw new Error("Integration not found");
 const lane=string(input.lane).trim(),scenario=string(input.scenario).trim(),requirement=string(input.requirement).trim(),requestedBy=string(input.requestedBy).trim();
 if(!lane||scenario.length<4||requirement.length<8||!requestedBy)throw new Error("An evidence request needs a lane, a scenario, what it requires and a requester");
 const id=`INTREQ-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
 await db.prepare("INSERT OR IGNORE INTO integration_evidence_requests (id,integration_code,lane,scenario,requirement,requested_by,requested_at) VALUES (?,?,?,?,?,?,?)")
  .bind(id,input.integrationCode,lane,scenario,requirement,requestedBy,now).run();
 // An identical request filed twice returns the FIRST one, so a lane re-running its closure script
 // never resets the queue or double-counts a blocker.
 const row=await db.prepare("SELECT id,satisfied_by FROM integration_evidence_requests WHERE integration_code=? AND lane=? AND scenario=?").bind(input.integrationCode,lane,scenario).first<Row>();
 return{id:string(row?.id||id),integrationCode:input.integrationCode,lane,scenario,satisfied:Boolean(row?.satisfied_by)};
}

export async function openIntegrationEvidenceRequests(db:Db){
 await ensureIntegrationReadinessTables(db);
 const rows=await db.prepare("SELECT r.id,r.integration_code,r.lane,r.scenario,r.requirement,r.requested_by,r.requested_at,g.readiness_state FROM integration_evidence_requests r JOIN integration_registry g ON g.integration_code=r.integration_code WHERE r.satisfied_by IS NULL ORDER BY r.integration_code,r.lane,r.scenario").all<Row>();
 return rows.results.map(row=>({id:string(row.id),integrationCode:string(row.integration_code),lane:string(row.lane),scenario:string(row.scenario),requirement:string(row.requirement),requestedBy:string(row.requested_by),requestedAt:Number(row.requested_at),readinessState:string(row.readiness_state)}));
}

export async function updateIntegrationReadiness(db:Db,input:{integrationCode:string;changes:Record<string,unknown>;reason:string;actorId:string;actorRole?:string}){
 await ensureIntegrationReadinessTables(db);if(!input.integrationCode||input.reason.trim().length<8)throw new Error("Integration code and a clear change reason are required");const before=await db.prepare("SELECT * FROM integration_registry WHERE integration_code=?").bind(input.integrationCode).first<Row>();if(!before)throw new Error("Integration not found");const entries=Object.entries(input.changes).filter(([key])=>editableColumns.has(key));if(!entries.length)throw new Error("No supported integration readiness changes supplied");
 for(const[key,value]of entries){const column=editableColumns.get(key)!;if(column==="environment"&&!integrationEnvironments.includes(String(value) as IntegrationEnvironment))throw new Error("Invalid integration environment");if(column==="code_boundary_status"&&!integrationCodeBoundaryStates.includes(String(value) as CodeBoundaryStatus))throw new Error("Invalid code boundary status");if(column==="credential_status"&&!integrationCredentialStates.includes(String(value) as CredentialStatus))throw new Error("Invalid credential status");if(column==="readiness_state"&&!integrationReadinessStates.includes(String(value) as IntegrationReadinessState))throw new Error("Invalid readiness state");if(evidenceColumns.has(column)&&!allowedEvidence(value))throw new Error(`Invalid ${key}`);if(column==="secret_reference"&&value!=null&&!/^(env|vault|secret-manager|platform):[A-Za-z0-9_./:+-]+$/.test(String(value)))throw new Error("Secret reference must be a reference only (env:/vault:/secret-manager:/platform:), never a secret value");}
 const nextState=entries.find(([key])=>key==="readinessState")?.[1];if(nextState==="blocked"&&!string(input.changes.blockerReason).trim())throw new Error("Blocked readiness requires a blocker reason");
 const now=Date.now();
 // The controlled-live gate is evaluated on the PROSPECTIVE row - `before` with this call's changes
 // applied in memory - and refuses BEFORE anything is written.
 //
 // It used to write first and then roll back only readiness_state and the two verification timestamps.
 // A rejected attempt that also set environment='production' and a dozen evidence columns left every
 // one of those persisted, with no readiness_updated event describing them, because the throw happened
 // before the audit insert. An operator then saw a row that had silently moved most of the way to
 // "live" as the result of a call that reported failure. Nothing is written unless the whole change is
 // going to be accepted.
 const prospective:Row={...before};
 for(const[key,value]of entries)prospective[editableColumns.get(key)!]=value===""?null:value;
 if(String(prospective.readiness_state)==="controlled_live_verified"){
  const missing=completeForControlledLive(prospective);const gap=await liveEvidenceGap(db,prospective);if(gap)missing.push(gap);
  if(missing.length)throw new Error(`Controlled-live verification is blocked until: ${missing.join(", ")}`);
 }else if(String(prospective.readiness_state)==="sandbox_verified"&&!string(prospective.evidence_reference).trim()){
  throw new Error("Sandbox verification requires an evidence reference");
 }
 prospective.updated_by=input.actorId;prospective.updated_at=now;
 if(String(prospective.readiness_state)==="controlled_live_verified"){
  prospective.controlled_live_verified_at=now;prospective.controlled_live_verified_by=input.actorId;prospective.last_verified_at=now;
 }else if(String(prospective.readiness_state)==="sandbox_verified")prospective.last_verified_at=now;
 const set=[...entries.map(([key])=>`${editableColumns.get(key)}=?`),"updated_by=?","updated_at=?","controlled_live_verified_at=?","controlled_live_verified_by=?","last_verified_at=?"].join(",");
 const after=publicRow(prospective),reason=input.reason.trim(),changedFields=entries.map(([key])=>key);
 await db.batch([
  db.prepare(`UPDATE integration_registry SET ${set} WHERE integration_code=?`).bind(...entries.map(([,value])=>value===""?null:value),input.actorId,now,prospective.controlled_live_verified_at??null,prospective.controlled_live_verified_by??null,prospective.last_verified_at??null,input.integrationCode),
  db.prepare("INSERT INTO integration_readiness_events (id,integration_code,event_type,before_json,after_json,actor_id,reason,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),input.integrationCode,"readiness_updated",JSON.stringify(publicRow(before)),JSON.stringify(after),input.actorId,reason,now),
  db.prepare("INSERT INTO security_audit_events (id,actor_email,actor_role,action,resource_type,resource_id,outcome,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),input.actorId,input.actorRole||"unknown","integration.readiness.update","integration",input.integrationCode,"completed",JSON.stringify({reason,changedFields,readinessState:after.readinessState,productionReady:false}),now),
 ]);
 return after;
}

export async function integrationLaunchBlockers(db:Db){
 await ensureIntegrationReadinessTables(db);const rows=await db.prepare("SELECT integration_code,capability,owner,launch_gate_code,readiness_state,blocker_reason FROM integration_registry WHERE required=1 AND priority='P0' AND readiness_state!='controlled_live_verified' ORDER BY integration_code").all<Row>();return rows.results.map(row=>({integrationCode:string(row.integration_code),capability:string(row.capability),owner:string(row.owner),launchGateCode:row.launch_gate_code?string(row.launch_gate_code):null,readinessState:string(row.readiness_state),blockerReason:row.blocker_reason?string(row.blocker_reason):"Controlled-live verification is required"}));
}

export async function integrationReadinessAudit(db:Db,integrationCode?:string){await ensureIntegrationReadinessTables(db);const query=integrationCode?db.prepare("SELECT * FROM integration_readiness_events WHERE integration_code=? ORDER BY created_at DESC LIMIT 100").bind(integrationCode):db.prepare("SELECT * FROM integration_readiness_events ORDER BY created_at DESC LIMIT 100");const rows=await query.all<Row>();return rows.results;}
