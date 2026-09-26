import type{TestPaymentStatus}from"./test-transaction";

/**
 * The synthetic UAT test record a mobile Training booking writes once its payment is verified (the "SYNCED
 * TEST RECORD" card on the Team home, CRM, Admin, Ops and Accounts screens). It used to hard-code a commission
 * trainer and leave the payment state to the pay-after-service fallback, so a fully paid or deposit-paid
 * programme with the full-time Training team read "Awaiting Acceptance" and "Due After Service".
 */
export function trainingTestPayment(mode:"prepaid"|"split"):{payment:string;initialPaymentStatus:TestPaymentStatus}{
 return mode==="prepaid"
  ?{payment:"Verified Razorpay payment · paid in full",initialPaymentStatus:"paid"}
  :{payment:"Verified Razorpay deposit · balance due before the final session",initialPaymentStatus:"deposit_paid"};
}

export function trainingTestProviderModel(model:"full_time"|"commission"):"Full-time"|"Commission"{return model==="full_time"?"Full-time":"Commission";}
