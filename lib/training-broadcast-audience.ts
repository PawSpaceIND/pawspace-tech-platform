import type {Provider} from '../backend/src/domain.js';
import type {ScheduleDecision} from '../backend/src/scheduling.js';

/** Use the scheduler's actual roster, zone, radius, travel, conflict and leave verdicts. */
export function trainingBroadcastAudience(decision:ScheduleDecision,providers:Provider[]){
 const byId=new Map(providers.map(provider=>[provider.id,provider]));
 const resolved=decision.evaluations.filter(row=>row.eligible).map(row=>({evaluation:row,provider:byId.get(row.providerId)}));
 if(resolved.some(item=>!item.provider||!['full_time','commission'].includes(String(item.provider.model))))return{mode:'needs_operations' as const,providerId:null,contractorIds:[] as string[]};
 const eligible=resolved as Array<{evaluation:typeof decision.evaluations[number];provider:Provider}>;
 const fullTime=eligible.filter(item=>item.provider.model==='full_time').sort((a,b)=>b.evaluation.score-a.evaluation.score||a.evaluation.workload-b.evaluation.workload||a.evaluation.distanceKm-b.evaluation.distanceKm||a.provider.id.localeCompare(b.provider.id));
 if(fullTime.length)return{mode:'full_time' as const,providerId:fullTime[0].provider.id,contractorIds:[] as string[]};
 const contractorIds=eligible.filter(item=>item.provider.model==='commission').map(item=>item.provider.id);
 const distinctContractors=[...new Set(contractorIds)].sort();
 return distinctContractors.length?{mode:'broadcast' as const,providerId:null,contractorIds:distinctContractors}:{mode:'needs_operations' as const,providerId:null,contractorIds:[]};
}
