/**
 * Cancellation and refund policy. [PTJA-W1-F24]
 *
 * WHAT WAS MEASURED. A customer could self-cancel a booking that was already `in_service` and receive
 * 100% back. There was no ladder, no provider-status dimension, no distinction between the customer
 * walking away and PawSpace closing the job, and no approval gate on an exception.
 *
 * WHAT THIS IS. The approved PawSpace policy, expressed as configuration rather than as code, because
 * the business owns it and it differs by service type and will differ by city. The values below are the
 * PLATFORM DEFAULT seeded at (refund_policy, *, *); Boarding, Pet Sitting, food subscriptions and
 * relocation are advance-commitment services that the approved policy says MAY carry their own stricter
 * terms, and they carry them by an operator writing a (refund_policy, <service>, <city>) row in Control
 * Center - not by an engineer editing this file. Nothing stricter is seeded for them here, because "how
 * much stricter" was not decided and inventing a number would be worse than inheriting the default.
 *
 * THE APPROVED LADDER, by time to scheduled start:
 *   more than 24h before   -> customer 100%, provider no payout
 *   6h to 24h before       -> customer  50%, provider cancellation compensation may apply
 *   less than 6h before    -> customer   0%, provider cancellation compensation applies
 *
 * OVERRIDDEN BY PROVIDER STATUS, because once someone is moving there is a real cost:
 *   en_route               -> customer 0%, provider travel/cancellation compensation
 *   arrived / in_service / completed -> customer 0%, provider normal eligible payout
 *
 * AND BY WHO CANCELLED:
 *   PawSpace or the provider cancels -> customer 100%, and the customer is not penalised. This wins over
 *   everything above, including en_route: a job the platform pulls is not the customer's fault.
 *
 * FOUR CONTROLS THE POLICY STATES IN AS MANY WORDS, each enforced here and locked by a regression:
 *   1. Once the status is EN_ROUTE, ARRIVED, IN_SERVICE or COMPLETED the customer must not receive an
 *      AUTOMATIC refund. `automatic` goes false; the amount is not quietly paid out.
 *   2. The customer may still raise a dispute. `disputeAllowed` is true in every branch, including the
 *      0% ones - a refusal to auto-refund is not a refusal to be heard.
 *   3. Only an authorised role may approve an exception, with a reason and audit history. The evaluation
 *      names the permission rather than assuming the caller checked.
 *   4. Refund only the amount actually PAID, never coupon value; and record gateway deductions
 *      separately, never silently reducing the approved customer refund. The evaluation returns the
 *      customer's amount and the gateway deduction as two different numbers on purpose.
 */
import{registerServicePolicyDomain,resolveServicePolicy}from"./service-policy-governance";

type Db=D1Database;

export const REFUND_POLICY_DOMAIN="refund_policy";

/** How the provider is treated for a cancellation in this band. Payout maths lives in the payout engine. */
export type ProviderCompensation="none"|"cancellation_may_apply"|"cancellation_applies"|"travel_cancellation"|"normal_payout";
const COMPENSATIONS:ProviderCompensation[]=["none","cancellation_may_apply","cancellation_applies","travel_cancellation","normal_payout"];

export type RefundTier={minHoursBeforeStart:number;customerRefundPercent:number;providerCompensation:ProviderCompensation;label:string};
export type StatusOutcome={customerRefundPercent:number;providerCompensation:ProviderCompensation};

export type RefundPolicyConfig={
  tiers:RefundTier[];
  /** Booking statuses at which an automatic customer refund is never issued. */
  automaticRefundBlockedStatuses:string[];
  statusOutcomes:Record<string,StatusOutcome>;
  platformCancelRefundPercent:number;
  providerCancelRefundPercent:number;
  /** A verified service failure is a manual decision, not an automatic one. */
  serviceFailureRequiresApproval:boolean;
  /** Who may approve an exception or a manual service-failure refund. */
  exceptionApprovalPermissions:string[];
  /** Refund is computed on money actually received. Coupon value is never refunded as cash. */
  refundBasis:"amount_paid";
  /** Gateway deductions are recorded beside the refund, never subtracted from what was approved. */
  gatewayDeductionHandling:"record_separately";
  disputeAlwaysAllowed:boolean;
};

/**
 * Every default is the STRICT answer, which is what makes it safe for a stored row missing a key to
 * adopt it - see lib/service-policy-governance.ts. The one exception is deliberate: the approved policy
 * makes a >24h cancellation a full refund, and that IS the decided rule rather than a permissive
 * fallback.
 */
export const APPROVED_REFUND_POLICY:RefundPolicyConfig={
  tiers:[
    {minHoursBeforeStart:24,customerRefundPercent:100,providerCompensation:"none",label:"More than 24 hours before start"},
    {minHoursBeforeStart:6,customerRefundPercent:50,providerCompensation:"cancellation_may_apply",label:"6-24 hours before start"},
    {minHoursBeforeStart:0,customerRefundPercent:0,providerCompensation:"cancellation_applies",label:"Less than 6 hours before start"},
  ],
  automaticRefundBlockedStatuses:["en_route","arrived","in_service","completed"],
  statusOutcomes:{
    en_route:{customerRefundPercent:0,providerCompensation:"travel_cancellation"},
    arrived:{customerRefundPercent:0,providerCompensation:"normal_payout"},
    in_service:{customerRefundPercent:0,providerCompensation:"normal_payout"},
    completed:{customerRefundPercent:0,providerCompensation:"normal_payout"},
  },
  platformCancelRefundPercent:100,
  providerCancelRefundPercent:100,
  serviceFailureRequiresApproval:true,
  exceptionApprovalPermissions:["finance.manage","bookings.manage"],
  refundBasis:"amount_paid",
  gatewayDeductionHandling:"record_separately",
  disputeAlwaysAllowed:true,
};

const percentProblem=(label:string,value:unknown)=>{
  const number=Number(value);
  if(!Number.isFinite(number))return `${label} must be a number`;
  if(number<0||number>100)return `${label} must be between 0 and 100`;
  return null;
};

registerServicePolicyDomain<RefundPolicyConfig&Record<string,unknown>>({
  domain:REFUND_POLICY_DOMAIN,
  label:"Cancellation and refund policy",
  managePermission:"settings.manage",
  defaults:APPROVED_REFUND_POLICY as RefundPolicyConfig&Record<string,unknown>,
  problem(config){
    const tiers=config.tiers as RefundTier[]|undefined;
    if(!Array.isArray(tiers)||!tiers.length)return "At least one refund tier is required";
    let previous=Number.POSITIVE_INFINITY;
    for(const tier of tiers){
      if(!Number.isFinite(Number(tier?.minHoursBeforeStart))||Number(tier.minHoursBeforeStart)<0)return "Each tier needs a non-negative minHoursBeforeStart";
      // Descending order is what makes "the first tier whose threshold is met" a total function. An
      // unordered ladder would silently pick whichever row happened to come first.
      if(Number(tier.minHoursBeforeStart)>=previous)return "Refund tiers must be ordered from the longest notice to the shortest";
      previous=Number(tier.minHoursBeforeStart);
      const problem=percentProblem("Tier refund percent",tier.customerRefundPercent);
      if(problem)return problem;
      if(!COMPENSATIONS.includes(tier.providerCompensation))return `Tier provider compensation must be one of ${COMPENSATIONS.join(", ")}`;
    }
    // A ladder that never reaches zero notice cannot answer a cancellation one minute before start.
    if(Number(tiers[tiers.length-1].minHoursBeforeStart)!==0)return "The final refund tier must start at 0 hours so every cancellation is answered";
    for(const key of ["platformCancelRefundPercent","providerCancelRefundPercent"]){
      const problem=percentProblem(key,config[key]);
      if(problem)return problem;
    }
    const outcomes=config.statusOutcomes as Record<string,StatusOutcome>|undefined;
    if(!outcomes||typeof outcomes!=="object")return "statusOutcomes is required";
    for(const [status,outcome] of Object.entries(outcomes)){
      const problem=percentProblem(`statusOutcomes.${status}`,outcome?.customerRefundPercent);
      if(problem)return problem;
      if(!COMPENSATIONS.includes(outcome.providerCompensation))return `statusOutcomes.${status} provider compensation must be one of ${COMPENSATIONS.join(", ")}`;
    }
    const blocked=config.automaticRefundBlockedStatuses;
    if(!Array.isArray(blocked))return "automaticRefundBlockedStatuses must be a list";
    // The approved policy names these four explicitly. Removing one would make an in-progress or
    // completed job auto-refundable again, which is the defect this domain exists to close, so the
    // configuration surface refuses to express it.
    for(const required of ["en_route","arrived","in_service","completed"]){
      if(!blocked.map(String).includes(required))return `automaticRefundBlockedStatuses must include ${required}`;
    }
    const approvers=config.exceptionApprovalPermissions;
    if(!Array.isArray(approvers)||!approvers.length)return "At least one exception approval permission is required";
    if(config.refundBasis!=="amount_paid")return "Refund basis must be amount_paid - coupon value is never refunded as cash";
    if(config.gatewayDeductionHandling!=="record_separately")return "Gateway deductions must be recorded separately, never netted off an approved customer refund";
    if(config.disputeAlwaysAllowed===false)return "A customer must always be able to raise a dispute";
    return null;
  },
});

export type CancelledBy="customer"|"provider"|"platform";

export type RefundEvaluationInput={
  scheduledStart:string;
  bookingStatus:string;
  cancelledBy:CancelledBy;
  /** Money actually received from the customer. Coupon value is NOT part of this. */
  amountPaid:number;
  /** Recorded for the audit trail; never refunded as cash and never added to amountPaid. */
  couponValue?:number;
  /** Recorded beside the refund; never subtracted from the customer's approved amount. */
  gatewayDeduction?:number;
  serviceFailureVerified?:boolean;
  now?:number;
};

export type RefundEvaluation={
  policyVersion:string;
  matchedBy:string;
  tier:string;
  refundPercent:number;
  /** What the customer is owed. Never reduced by gateway deductions or coupon value. */
  customerRefundAmount:number;
  /** True only when the platform may pay without a human. */
  automatic:boolean;
  requiresApproval:boolean;
  approvalPermissions:string[];
  providerCompensation:ProviderCompensation;
  disputeAllowed:boolean;
  basis:{amountPaid:number;couponValueExcluded:number;gatewayDeductionRecordedSeparately:number};
  reasons:string[];
};

const round2=(value:number)=>Math.round(value*100)/100;

export async function resolveRefundPolicy(db:Db,scope:{serviceCode?:string|null;cityId?:string|null}={},at=new Date()){
  return resolveServicePolicy<RefundPolicyConfig&Record<string,unknown>>(db,REFUND_POLICY_DOMAIN,scope,at);
}

/**
 * The refund a cancellation earns, and whether the platform may pay it without a human.
 *
 * Precedence, and the order matters:
 *   1. PawSpace or the provider cancelled -> the customer is made whole and is not penalised. This wins
 *      over the status overrides: a job the platform pulls while the groomer is en route is not the
 *      customer's cancellation.
 *   2. A VERIFIED service failure -> a manual full or partial refund by an authorised approver. Never
 *      automatic, because "verified" is a human judgement and the amount is a human decision.
 *   3. The booking has reached a blocked status -> 0% automatic, provider compensated per the status.
 *   4. Otherwise the time ladder.
 * A dispute stays open in all four.
 */
export function evaluateCancellationRefund(policy:{config:RefundPolicyConfig;policyVersion:string;matchedBy:string},input:RefundEvaluationInput):RefundEvaluation{
  const config=policy.config;
  const now=input.now??Date.now();
  const startMs=new Date(input.scheduledStart).getTime();
  const hoursUntilStart=Number.isFinite(startMs)?(startMs-now)/3_600_000:0;
  const status=String(input.bookingStatus||"").trim().toLowerCase();
  const amountPaid=Math.max(0,Number(input.amountPaid||0));
  const couponValue=Math.max(0,Number(input.couponValue||0));
  const gatewayDeduction=Math.max(0,Number(input.gatewayDeduction||0));
  const reasons:string[]=[];
  const basis={amountPaid,couponValueExcluded:couponValue,gatewayDeductionRecordedSeparately:gatewayDeduction};
  const settle=(refundPercent:number,providerCompensation:ProviderCompensation,automatic:boolean,requiresApproval:boolean):RefundEvaluation=>({
    policyVersion:policy.policyVersion,matchedBy:policy.matchedBy,tier:reasons[0]??"",
    refundPercent,
    // Computed on money actually received. Coupon value is never converted into cash, and the gateway's
    // cut is reported beside this number rather than taken out of it.
    customerRefundAmount:round2(amountPaid*refundPercent/100),
    automatic,requiresApproval,
    approvalPermissions:requiresApproval?[...config.exceptionApprovalPermissions]:[],
    providerCompensation,disputeAllowed:config.disputeAlwaysAllowed!==false,basis,reasons,
  });

  if(input.cancelledBy==="platform"||input.cancelledBy==="provider"){
    reasons.push(input.cancelledBy==="platform"?"Cancelled by PawSpace - the customer is not penalised":"Cancelled by the provider - the customer is not penalised");
    const percent=input.cancelledBy==="platform"?config.platformCancelRefundPercent:config.providerCancelRefundPercent;
    return settle(percent,"none",true,false);
  }

  if(input.serviceFailureVerified){
    reasons.push("Verified service failure - a full or partial refund is decided by an authorised approver");
    return settle(0,"normal_payout",false,true);
  }

  if(config.automaticRefundBlockedStatuses.map(String).includes(status)){
    const outcome=config.statusOutcomes[status]??{customerRefundPercent:0,providerCompensation:"normal_payout" as ProviderCompensation};
    reasons.push(`Booking status ${status} - no automatic customer refund; the customer may still raise a dispute`);
    // requiresApproval, not "refused": the money is not paid out automatically, and a manager or finance
    // approver can still grant an exception with a reason. Silence would be the wrong answer here.
    return settle(outcome.customerRefundPercent,outcome.providerCompensation,false,true);
  }

  const tier=config.tiers.find(entry=>hoursUntilStart>=Number(entry.minHoursBeforeStart))??config.tiers[config.tiers.length-1];
  reasons.push(tier.label||`${tier.minHoursBeforeStart}h notice band`);
  const automatic=Number(tier.customerRefundPercent)>0;
  if(!automatic)reasons.push("No refund is due at this notice; the customer may still raise a dispute");
  return settle(Number(tier.customerRefundPercent),tier.providerCompensation,automatic,!automatic);
}
