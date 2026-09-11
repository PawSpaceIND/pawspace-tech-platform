import type { AtlasAgentCode } from "../../atlas-tool-contract";

export type VerticalAgentCode=Exclude<AtlasAgentCode,"atlas">;
export type VerticalRuntimeMode="disabled"|"recommend"|"approval_required"|"execute_within_envelope";

const switchName:Record<VerticalAgentCode,string>={sales:"AI_SALES_ACTIVE",marketing:"AI_MARKETING_ACTIVE",ops:"AI_OPS_ACTIVE",hr:"AI_HR_ACTIVE",finance:"AI_FINANCE_ACTIVE",healthcare:"AI_HEALTHCARE_ACTIVE"};
const enabled=(value:unknown)=>!["","0","false","off","disabled"].includes(String(value??"").trim().toLowerCase());

export function resolveVerticalRuntime(env:Record<string,unknown>,agent:VerticalAgentCode,requested:Exclude<VerticalRuntimeMode,"disabled">="recommend"){
 if(!enabled(env.PAWSPACE_AI_EXECUTIVE_ACTIVE)||!enabled(env.AI_ATLAS_ACTIVE)||!enabled(env[switchName[agent]]))return{agent,mode:"disabled" as const,humanFallback:true};
 if((agent==="finance"||agent==="healthcare")&&requested==="execute_within_envelope"&&!enabled(env.AI_FINANCIAL_MUTATION_ACTIVE))return{agent,mode:"approval_required" as const,humanFallback:true};
 if((agent==="ops"||agent==="hr")&&requested==="execute_within_envelope"&&!enabled(env.AI_PROVIDER_MUTATION_ACTIVE))return{agent,mode:"approval_required" as const,humanFallback:true};
 if((agent==="sales"||agent==="marketing")&&requested==="execute_within_envelope"&&!enabled(env.AI_EXTERNAL_COMMUNICATION_ACTIVE))return{agent,mode:"approval_required" as const,humanFallback:true};
 return{agent,mode:requested,humanFallback:requested!=="execute_within_envelope"};
}

export const PHASE2_VERTICALS:VerticalAgentCode[]=["sales","marketing","ops","hr","finance","healthcare"];
