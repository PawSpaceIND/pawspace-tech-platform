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
  payment:{method:"upi"|"card"|"netbanking"|"payment_link"|"cash";mode:"prepaid"|"pay_after_service"|"split"|"split_50_50";status:"created"|"authorised"|"captured";detail:string};
  pricing:{discount:number;couponCode?:string;couponQuoteId?:string;addOns?:string[];subscription?:string;requirements?:string[];trainingQuoteId?:string;boardingQuoteId?:string;referralClaimId?:string};
};

export type CanonicalLifecycleResult={bookingId:string;customerId:string;petIds:string[];scheduleGroupId:string;workOrderId:string;paymentId:string;status:string;duplicatePrevented:boolean};
type TrainingSandboxCapture={quoteId:string;status:"captured";amount:number;currency:string;environment:"sandbox";reference:string;duplicatePrevented:boolean;liveMoney:false;synthetic:true};
const trainingCaptureKeys=new Map<string,string>();
function trainingCaptureKey(quoteId:string){const existing=trainingCaptureKeys.get(quoteId);if(existing)return existing;const created=crypto.randomUUID();trainingCaptureKeys.set(quoteId,created);return created;}
async function attestTrainingProgramme(input:CanonicalLifecycleInput){const quoteId=String(input.pricing.trainingQuoteId||"").trim();if(!quoteId)return input;const capture=await apiSend<TrainingSandboxCapture>("/api/training-payment-sandbox",{method:"POST",headers:{"content-type":"application/json","x-payment-capture-key":trainingCaptureKey(quoteId)},body:JSON.stringify({quoteId,amount:input.amountDueNow})},"Training sandbox capture failed");return{...input,payment:{...input.payment,status:"captured" as const,detail:`Server-attested Training UAT sandbox capture · ${capture.reference}`}};}

export async function createCanonicalLifecycle(input:CanonicalLifecycleInput){
  const payload=input.serviceCode==="dog_training"&&input.packageCode!=="trainer-meet-greet"&&input.payment.status!=="captured"?await attestTrainingProgramme(input):input;
  return apiSend<CanonicalLifecycleResult>("/api/canonical-bookings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)},"The shared booking record could not be created");
}
