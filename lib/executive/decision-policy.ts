export type ExecutiveDecisionInput={capacityUtilization:number;pacingLagFraction:number;approvedDiscountBps:number;approvedUpgradeCodes:string[]};
export function decideExecutiveAction(input:ExecutiveDecisionInput){
 if(input.capacityUtilization>=0.90)return{mode:"throttle" as const,pressureMultiplier:0,reason:"capacity_at_or_above_90_percent",discountBps:0,upgradeCodes:[] as string[],marginValidationRequired:true};
 if(input.pacingLagFraction>0.25)return{mode:"boost" as const,pressureMultiplier:1.35,reason:"target_pacing_lag_above_25_percent",discountBps:Math.max(0,input.approvedDiscountBps),upgradeCodes:[...input.approvedUpgradeCodes],marginValidationRequired:true};
 return{mode:"normal" as const,pressureMultiplier:1,reason:"within_corridor",discountBps:0,upgradeCodes:[] as string[],marginValidationRequired:true};
}
