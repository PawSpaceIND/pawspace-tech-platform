type Row=Record<string,unknown>;
type ModuleCode="razorpay"|"sms_otp"|"meta_whatsapp"|"maps_gps"|"ai";
type ModuleDefinition={code:ModuleCode;label:string;integrationCode:string;modeChecks:Array<[string,string]>;secretNames:string[];requiresSmsConfig?:boolean;requiresStaffOnly?:boolean;requiresApprovedAi?:boolean};
type Evidence={readinessState:string;evidenceReference:string|null;evidenceId?:string|null;matched?:boolean};

const text=(value:unknown)=>String(value??"").trim();
const present=(runtime:Record<string,unknown>,name:string)=>text(runtime[name]).length>0;

const MODULES:ModuleDefinition[]=[
 {code:"razorpay",label:"Razorpay test payments",integrationCode:"INT-PAY-01",modeChecks:[["PAWSPACE_PAYMENT_ENV","sandbox"]],secretNames:["RAZORPAY_KEY_ID_SANDBOX","RAZORPAY_KEY_SECRET_SANDBOX","RAZORPAY_WEBHOOK_SECRET_SANDBOX"]},
 {code:"sms_otp",label:"SMS / OTP test channel",integrationCode:"INT-COMMS-02",modeChecks:[["PAWSPACE_COMMUNICATION_ENV","uat"]],secretNames:["PAWSPACE_COMMUNICATION_PROVIDER_URL","PAWSPACE_COMMUNICATION_PROVIDER_TOKEN","PAWSPACE_COMMUNICATION_WEBHOOK_SECRET","PAWSPACE_COMMUNICATION_UAT_ALLOWLIST"],requiresSmsConfig:true},
 {code:"meta_whatsapp",label:"Meta WhatsApp test number",integrationCode:"INT-COMMS-01",modeChecks:[["PAWSPACE_COMMUNICATION_ENV","uat"],["META_WHATSAPP_UAT_DELIVERY_ENABLED","true"]],secretNames:["META_WHATSAPP_UAT_ACCESS_TOKEN","META_WHATSAPP_PHONE_NUMBER_ID","META_WHATSAPP_WABA_ID","META_WHATSAPP_APP_SECRET","META_WHATSAPP_VERIFY_TOKEN","META_WHATSAPP_UAT_ALLOWLIST","META_WHATSAPP_TEMPLATE_ALLOWLIST"]},
 {code:"maps_gps",label:"Maps / GPS test routes",integrationCode:"INT-MAPS-01",modeChecks:[["PAWSPACE_MAPS_ENV","sandbox"]],secretNames:["GOOGLE_MAPS_SERVER_API_KEY_UAT"]},
 {code:"ai",label:"Approved AI test provider",integrationCode:"INT-AI-01",modeChecks:[],secretNames:["PAWSPACE_AI_PROVIDER_API_KEY"],requiresStaffOnly:true,requiresApprovedAi:true},
];

export function evaluateUatSandboxReadiness(runtime:Record<string,unknown>,input:{aiRolloutStage?:string;aiProviderRef?:string;aiModelRef?:string;smsAdapterConfigured?:boolean;evidence?:Record<string,Evidence>}={}){
 const modules=MODULES.map(definition=>{
  const failedModes=definition.modeChecks.filter(([name,wanted])=>text(runtime[name]).toLowerCase()!==wanted).map(([name,wanted])=>`${name} must be ${wanted}`);
  const missingConfiguration=definition.secretNames.filter(name=>!present(runtime,name));
  if(definition.requiresSmsConfig&&!input.smsAdapterConfigured)missingConfiguration.push("D1 sandbox SMS adapter configuration");
  if(definition.requiresStaffOnly&&text(input.aiRolloutStage).toLowerCase()!=="staff_only")failedModes.push("AI rollout must be staff_only");
  if(definition.requiresApprovedAi&&(text(input.aiProviderRef).toLowerCase()!=="anthropic"||!text(input.aiModelRef)))missingConfiguration.push("approved active Anthropic model configuration");
  const configuredForExternalTest=failedModes.length===0&&missingConfiguration.length===0;
  const evidence=input.evidence?.[definition.integrationCode];
  const sandboxEvidenceVerified=Boolean(evidence?.readinessState==="sandbox_verified"&&evidence.matched&&text(evidence.evidenceId)&&text(evidence.evidenceReference)===`live-evidence:${text(evidence.evidenceId)}`);
  return{
   code:definition.code,label:definition.label,integrationCode:definition.integrationCode,
   configurationStatus:configuredForExternalTest?"configured_for_test":"blocked",
   configuredForExternalTest,sandboxEvidenceVerified,
   status:configuredForExternalTest&&sandboxEvidenceVerified?"sandbox_verified":configuredForExternalTest?"external_test_required":"configuration_blocked",
   blockers:[...failedModes,...missingConfiguration.map(name=>`Missing ${name}`)],
  };
 });
 const configuredForExternalTest=modules.every(module=>module.configuredForExternalTest);
 const sandboxEvidenceVerified=modules.every(module=>module.sandboxEvidenceVerified);
 return{
  status:configuredForExternalTest&&sandboxEvidenceVerified?"sandbox_verified":configuredForExternalTest?"external_test_required":"blocked",
  configuredForExternalTest,sandboxEvidenceVerified,
  syntheticLogicReady:true,productionEnabled:false,credentialValuesExposed:false,
  modules,
 };
}

export async function readUatSandboxReadiness(db:D1Database,runtime:Record<string,unknown>){
 const evidence:Record<string,Evidence>={};
 const codes=MODULES.map(module=>`'${module.integrationCode}'`).join(",");
 const rows=await db.prepare(`SELECT g.integration_code,g.readiness_state,g.evidence_reference,e.id evidence_id,e.matched evidence_matched FROM integration_registry g LEFT JOIN integration_live_evidence e ON e.integration_code=g.integration_code AND g.evidence_reference=('live-evidence:'||e.id) AND e.matched=1 WHERE g.integration_code IN (${codes})`).all<Row>().catch(()=>({results:[]}));
 for(const row of rows.results)evidence[text(row.integration_code)]={readinessState:text(row.readiness_state),evidenceReference:text(row.evidence_reference)||null,evidenceId:text(row.evidence_id)||null,matched:Number(row.evidence_matched)===1};
 const rollout=await db.prepare("SELECT stage FROM ai_audience_rollout WHERE id=1").first<Row>().catch(()=>null);
 const ai=await db.prepare("SELECT provider_ref,model_ref FROM ai_assistant_profile_versions WHERE status='active' ORDER BY version DESC LIMIT 1").first<Row>().catch(()=>null);
 const sms=await db.prepare("SELECT status,credentials_status FROM communication_adapter_configs WHERE channel='sms' AND environment='sandbox' ORDER BY updated_at DESC LIMIT 1").first<Row>().catch(()=>null);
 const smsAdapterConfigured=Boolean(sms&&text(sms.status)==="sandbox_ready"&&text(sms.credentials_status)==="configured");
 return evaluateUatSandboxReadiness(runtime,{aiRolloutStage:text(rollout?.stage),aiProviderRef:text(ai?.provider_ref),aiModelRef:text(ai?.model_ref),smsAdapterConfigured,evidence});
}
