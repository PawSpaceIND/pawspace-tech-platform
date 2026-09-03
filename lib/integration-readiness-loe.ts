type Db=D1Database;
type Runtime=Record<string,unknown>;
const has=(runtime:Runtime,names:string[])=>names.every(name=>String(runtime[name]??"").trim().length>0);
const now=()=>Date.now();

const rows=[
 {code:"INT-HAPTIK-01",capability:"Haptik voice/chat CRM and outbound campaigns",provider:"Haptik",detector:"haptik",notes:"Haptik inbound CRM actions, governed outbound audience selection, call outcomes and operator readiness surface are code-ready. Controlled-live verification still requires provider credentials and evidence."},
 {code:"INT-INTERAKT-01",capability:"Interakt WhatsApp inbound CRM routing",provider:"Interakt",detector:"interakt",notes:"Interakt signed inbound callback boundary, canonical customer ownership verification, CRM linkage and consent/opt-out guards are code-ready. Controlled-live verification still requires provider credentials and evidence."},
]as const;

export function loeIntegrationCredentialStatus(runtime:Runtime,detector:string){if(detector==="haptik")return has(runtime,["HAPTIK_API_KEY","HAPTIK_OUTBOUND_API_KEY","HAPTIK_OUTBOUND_URL"])?"configured":"missing";if(detector==="interakt")return has(runtime,["INTERAKT_WEBHOOK_SECRET","INTERAKT_API_KEY"])?"configured":"missing";return"unknown";}

export async function ensureLoeIntegrationReadiness(db:Db,runtime?:Runtime){const at=now();for(const row of rows){await db.prepare("INSERT OR IGNORE INTO integration_registry (integration_code,category,capability,provider,owner,backup_owner,priority,required,launch_gate_code,environment,code_boundary_status,credential_status,credential_detector,data_classification,readiness_state,notes,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(row.code,"communications",row.capability,row.provider,"CRM/CX + Engineering","Operations","P0",1,"COMMS-01","sandbox","code_ready",runtime?loeIntegrationCredentialStatus(runtime,row.detector):"unknown",row.detector,"customer contact + governed conversation metadata","sandbox_setup_required",row.notes,"system_seed",at).run();if(runtime){await db.prepare("UPDATE integration_registry SET credential_status=?,secret_reference=CASE WHEN ?='configured' THEN ? ELSE NULL END,updated_by='runtime_presence_check',updated_at=? WHERE integration_code=? AND readiness_state!='controlled_live_verified'").bind(loeIntegrationCredentialStatus(runtime,row.detector),loeIntegrationCredentialStatus(runtime,row.detector),`env:${row.detector}`,at,row.code).run();}}
}

export const LOE_INTEGRATION_CODES=rows.map(row=>row.code);
