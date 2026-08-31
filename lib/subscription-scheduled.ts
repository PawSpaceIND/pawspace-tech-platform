import{runSubscriptionBillingSweep}from"./subscription-billing";
import{enqueueSubscriptionDunningNotifications}from"./subscription-dunning-notifications";
import{reconcilePendingSubscriptionPlanChanges}from"./subscription-plan-reconciliation";
type Env=Record<string,unknown>;
export async function runSubscriptionScheduledMaintenance(db:D1Database,env:Env,input:{asOf:number}){const planChanges=await reconcilePendingSubscriptionPlanChanges(db,env),billing=await runSubscriptionBillingSweep(db,{asOf:input.asOf}),dunning=await enqueueSubscriptionDunningNotifications(db,{asOf:input.asOf});return{planChanges,billing,dunning,errors:Number(planChanges.errors||0)+Number(billing.accountingExceptions||0)+Number(dunning.errors||0)};}
