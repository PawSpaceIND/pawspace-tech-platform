type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();

export type AiRuntimeKillSwitchInput={channel:string;intent:string;provider?:string|null;model?:string|null};
export type AiRuntimeKillSwitch={scopeType:"global"|"channel"|"intent"|"provider"|"model";scopeKey:string;reason:string};

/**
 * Resolve only explicit active kill switches.
 *
 * The low-level provider boundary must not interpret an absent assistant profile/prompt version as a
 * kill switch: direct governed helpers (for example onboarding summaries) do not use the full
 * conversational business configuration. Grounded chat/WhatsApp/voice runtimes independently require
 * an active profile/prompt/intent configuration before they call the provider.
 *
 * This function intentionally does not create schema. Production callers treat a failed read as a
 * fail-closed governance error; migration/unit harnesses can distinguish that from an explicit switch.
 */
export async function resolveExplicitAiKillSwitches(db:D1Database,input:AiRuntimeKillSwitchInput):Promise<AiRuntimeKillSwitch[]>{
 const rows=await db.prepare("SELECT scope_type,scope_key,reason FROM ai_kill_switches WHERE disabled=1").all<Row>();
 return rows.results.flatMap(row=>{
  const scopeType=text(row.scope_type) as AiRuntimeKillSwitch["scopeType"],scopeKey=text(row.scope_key);
  const relevant=(scopeType==="global"&&scopeKey==="ai")
   ||(scopeType==="channel"&&scopeKey===input.channel)
   ||(scopeType==="intent"&&scopeKey===input.intent)
   ||(scopeType==="provider"&&Boolean(input.provider)&&scopeKey===input.provider)
   ||(scopeType==="model"&&Boolean(input.model)&&scopeKey===input.model);
  return relevant?[{scopeType,scopeKey,reason:text(row.reason)}]:[];
 });
}
