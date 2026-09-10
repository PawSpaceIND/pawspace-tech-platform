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
 /*
  * Matching is case- and whitespace-insensitive on BOTH sides, and a global row is global whatever
  * key it carries.
  *
  * This is the control a human reaches for while the assistant is saying something wrong to real
  * customers, so the failure that matters is a switch that is engaged and does nothing. Exact ===
  * gave two of them. An operator stopping WhatsApp types "WhatsApp" - that is how the product
  * spells it in the UI - while the runtime passes "whatsapp": the row was written, the console
  * showed the switch on, the audit log recorded it, and the AI kept talking. And a global kill
  * required scope_key to be exactly "ai", so filing it as "global" or "all" produced a row that
  * matched nothing at all - the worst outcome for the one switch meant to stop every channel.
  *
  * Erring towards stopping is the correct direction for a kill switch: a false stop is an outage
  * an operator asked for, a false continue is one they think they prevented. [D31-W2]
  */
 const norm=(value:unknown)=>String(value??"").trim().toLowerCase();
 const rows=await db.prepare("SELECT scope_type,scope_key,reason FROM ai_kill_switches WHERE disabled=1").all<Row>();
 const channel=norm(input.channel),intent=norm(input.intent),provider=norm(input.provider),model=norm(input.model);
 return rows.results.flatMap(row=>{
  const scopeType=norm(row.scope_type) as AiRuntimeKillSwitch["scopeType"],scopeKey=text(row.scope_key),key=norm(row.scope_key);
  const relevant=(scopeType==="global")
   ||(scopeType==="channel"&&Boolean(channel)&&key===channel)
   ||(scopeType==="intent"&&Boolean(intent)&&key===intent)
   ||(scopeType==="provider"&&Boolean(provider)&&key===provider)
   ||(scopeType==="model"&&Boolean(model)&&key===model);
  return relevant?[{scopeType,scopeKey,reason:text(row.reason)}]:[];
 });
}
