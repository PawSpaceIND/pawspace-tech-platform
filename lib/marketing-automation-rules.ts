type Db=D1Database;
type Row=Record<string,unknown>;
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;

/**
 * Real Automation Rule definitions - the marketing-control panel's "Automation Rules" section was
 * honestly labeled "NOT YET BUILT" (toggleRule just notifying "this toggle has no backend" -
 * confirmed directly in the panel's own source). This builds the real definition/CRUD/toggle layer
 * only, deliberately not an autonomous execution engine - matching the panel's own stated guardrails
 * ("No autonomous budget changes above approved limit", "Human approval for new campaign or
 * promotion", "Kill switch for every automation"). A rule here is a real, persisted, auditable
 * configuration a human enables or disables; nothing in this file executes a rule against a live
 * campaign or promotion - that would be a separate, larger, and more carefully-scoped undertaking.
 */
export async function ensureMarketingAutomationRules(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS marketing_automation_rules (id TEXT PRIMARY KEY,name TEXT NOT NULL,trigger_code TEXT NOT NULL,condition_json TEXT NOT NULL DEFAULT '{}',action_json TEXT NOT NULL DEFAULT '{}',approval_mode TEXT NOT NULL DEFAULT 'human_approval',enabled INTEGER NOT NULL DEFAULT 0,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS marketing_automation_rule_events (id TEXT PRIMARY KEY,rule_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_email TEXT NOT NULL,reason TEXT,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
]);}

const validTriggers=["spend_anomaly","conversion_drop","frequency_exceeded","budget_threshold","holdout_variance"] as const;

export async function createAutomationRule(db:Db,input:{name:string;triggerCode:string;condition:Record<string,unknown>;action:Record<string,unknown>;approvalMode?:string;actor:string}){
 await ensureMarketingAutomationRules(db);
 if(!input.name.trim())throw new Error("Rule name is required");
 if(!validTriggers.includes(input.triggerCode as typeof validTriggers[number]))throw new Error(`Unsupported trigger - must be one of: ${validTriggers.join(", ")}`);
 if(!input.condition||!Object.keys(input.condition).length)throw new Error("A real trigger condition is required");
 if(!input.action||!Object.keys(input.action).length)throw new Error("A real action definition is required");
 const approvalMode=input.approvalMode||"human_approval";
 if(!["human_approval","notify_only"].includes(approvalMode))throw new Error("Approval mode must be human_approval or notify_only - autonomous execution is not supported");
 const id=uid("MRULE"),now=Date.now();
 await db.prepare("INSERT INTO marketing_automation_rules (id,name,trigger_code,condition_json,action_json,approval_mode,enabled,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,?,?,?,0,?,?,?,?)")
   .bind(id,input.name.trim(),input.triggerCode,JSON.stringify(input.condition),JSON.stringify(input.action),approvalMode,input.actor,now,input.actor,now).run();
 await logEvent(db,id,"created",input.actor,null,{triggerCode:input.triggerCode,approvalMode});
 return{id,enabled:false,approvalMode};
}

export async function setAutomationRuleEnabled(db:Db,input:{ruleId:string;enabled:boolean;reason:string;actor:string}){
 await ensureMarketingAutomationRules(db);
 if(input.reason.trim().length<8)throw new Error("A clear reason is required to enable or disable an automation rule");
 const row=await db.prepare("SELECT id,enabled FROM marketing_automation_rules WHERE id=?").bind(input.ruleId).first<Row>();
 if(!row)throw new Error("Automation rule not found");
 const now=Date.now();
 await db.prepare("UPDATE marketing_automation_rules SET enabled=?,updated_by=?,updated_at=? WHERE id=?").bind(input.enabled?1:0,input.actor,now,input.ruleId).run();
 await logEvent(db,input.ruleId,input.enabled?"enabled":"disabled",input.actor,input.reason,{});
 return{id:input.ruleId,enabled:input.enabled};
}

async function logEvent(db:Db,ruleId:string,eventType:string,actor:string,reason:string|null,detail:unknown){
 await db.prepare("INSERT INTO marketing_automation_rule_events (id,rule_id,event_type,actor_email,reason,detail_json,created_at) VALUES (?,?,?,?,?,?,?)")
   .bind(uid("MRULEEVT"),ruleId,eventType,actor,reason,JSON.stringify(detail),Date.now()).run();
}

export async function listAutomationRules(db:Db){
 await ensureMarketingAutomationRules(db);
 const rows=await db.prepare("SELECT * FROM marketing_automation_rules ORDER BY updated_at DESC LIMIT 100").all<Row>();
 return{rules:rows.results,autonomousExecution:false,productionReady:false};
}
