import {apiSend} from "./api-fetch";

export type CanonicalLifecycleInput={
  idempotencyKey:string;
  scheduleGroupId:string;
  customer:{id:string;name:string;primaryPhone:string;secondaryPhone?:string;email?:string};
  pets:Array<{sourceId:string;name:string;species?:"dog"|"cat"|"other";breed?:string;vaccinationStatus?:string}>;
  cityId:string;
  zoneId:string;
  serviceCode:"grooming"|"dog_training"|"boarding"|"pet_sitting";
  packageCode:string;
  packageName:string;
  scheduledStart:string;
  scheduledEnd:string;
  provider:{id:string;name:string;model:"full_time"|"commission"};
  totalAmount:number;
  amountDueNow:number;
  payment:{method:"upi"|"card"|"netbanking"|"payment_link"|"cash"|"internal_uat";mode:"prepaid"|"pay_after_service"|"split"|"split_50_50";status:"created"|"authorised"|"captured";detail:string};
  pricing:{discount:number;couponCode?:string;couponQuoteId?:string;addOns?:string[];subscription?:string;requirements?:string[];trainingQuoteId?:string;boardingQuoteId?:string;referralClaimId?:string};
};

export type CanonicalLifecycleResult={bookingId:string;customerId:string;petIds:string[];scheduleGroupId:string;workOrderId:string;paymentId:string;status:string;duplicatePrevented:boolean};
type TrainingSandboxCapture={quoteId:string;status:"captured";amount:number;currency:string;environment:"sandbox";reference:string;duplicatePrevented:boolean;liveMoney:false;synthetic:true};
const trainingCaptureKeys=new Map<string,string>();
function trainingCaptureKey(quoteId:string){const existing=trainingCaptureKeys.get(quoteId);if(existing)return existing;const created=crypto.randomUUID();trainingCaptureKeys.set(quoteId,created);return created;}
async function attestTrainingProgramme(input:CanonicalLifecycleInput){const quoteId=String(input.pricing.trainingQuoteId||"").trim();if(!quoteId)return input;const capture=await apiSend<TrainingSandboxCapture>("/api/training-payment-sandbox",{method:"POST",headers:{"content-type":"application/json","x-payment-capture-key":trainingCaptureKey(quoteId)},body:JSON.stringify({quoteId,amount:input.amountDueNow})},"Training sandbox capture failed");return{...input,payment:{...input.payment,status:"captured" as const,detail:`Server-attested Training UAT sandbox capture · ${capture.reference}`}};}

export async function createCanonicalLifecycle(input:CanonicalLifecycleInput){
  /*
   * The client's own payment label is NOT evidence that a payment happened, so it cannot decide
   * whether the capture that label stands for gets performed. This gate used to include
   * `input.payment.status!=="captured"`, and lib/training-booking-client.ts posts a hardcoded
   * status:"captured" marker - so the customer-facing Training path skipped its own attestation and
   * every non-Meet-&-Greet programme booking was refused by the server that (rightly) checks for a
   * real attestation row. What decides is what the booking IS: a governed Training programme with a
   * server quote to capture against. attestTrainingProgramme is replay-safe - the capture key is
   * memoised per quote, and the server returns the same attestation for a repeat. [PTJA-P1-F32]
   *
   * Meet & Greet stays out: lib/training-commercial-governance.ts refuses to sandbox-capture one at
   * all, and holds it pending a verified payment event. That is the server's rule; this mirrors it by
   * package code, which is the only signal the client holds. Its authority is the package table's
   * meet_and_greet column, so a NEW Meet-&-Greet package code would need this line updated with it.
   */
  const payload=input.serviceCode==="dog_training"&&input.packageCode!=="trainer-meet-greet"?await attestTrainingProgramme(input):input;
  return apiSend<CanonicalLifecycleResult>("/api/canonical-bookings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)},"The shared booking record could not be created");
}
