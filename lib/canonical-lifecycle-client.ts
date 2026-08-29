import {apiSend} from "./api-fetch";
import {openRazorpayCheckout} from "./razorpay-checkout-client";

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

export type CanonicalLifecycleResult={bookingId:string;customerId:string;petIds:string[];scheduleGroupId:string;workOrderId:string;paymentId:string;status:string;duplicatePrevented:boolean;paymentStatus?:string;paymentEnvironment?:string};
type TrainingSandboxCapture={quoteId:string;status:"captured";amount:number;currency:string;environment:"sandbox";reference:string;duplicatePrevented:boolean;liveMoney:false;synthetic:true};
type PaymentOrder={connected:boolean;paymentRequired?:boolean;environment:"sandbox"|"live";reason?:string;orderId?:string;amount?:number;currency?:string;keyId?:string};
type PaymentCompletion={bookingId:string;bookingStatus:string;paymentStatus:string;environment:"sandbox"|"live";gateway:string;razorpayPaymentId:string};
const trainingCaptureKeys=new Map<string,string>();
function trainingCaptureKey(quoteId:string){const existing=trainingCaptureKeys.get(quoteId);if(existing)return existing;const created=crypto.randomUUID();trainingCaptureKeys.set(quoteId,created);return created;}
async function attestTrainingProgramme(input:CanonicalLifecycleInput){const quoteId=String(input.pricing.trainingQuoteId||"").trim();if(!quoteId)return input;const capture=await apiSend<TrainingSandboxCapture>("/api/training-payment-sandbox",{method:"POST",headers:{"content-type":"application/json","x-payment-capture-key":trainingCaptureKey(quoteId)},body:JSON.stringify({quoteId,amount:input.amountDueNow})},"Training sandbox capture failed");return{...input,payment:{...input.payment,status:"captured" as const,detail:`Server-attested Training UAT sandbox capture · ${capture.reference}`}};}

async function completeGroomingSandboxPayment(input:CanonicalLifecycleInput,canonical:CanonicalLifecycleResult){
  const order=await apiSend<PaymentOrder>("/api/payment-order",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"create",bookingId:canonical.bookingId})},"Razorpay order could not be created");
  if(order.paymentRequired===false)return canonical;
  if(!order.connected||!order.orderId||!order.keyId||!order.amount||!order.currency)throw new Error(order.reason||"Razorpay sandbox is not connected");
  if(order.environment!=="sandbox"||!order.keyId.startsWith("rzp_test_"))throw new Error("Grooming checkout is locked to Razorpay Test Mode");
  const proof=await openRazorpayCheckout({keyId:order.keyId,orderId:order.orderId,amount:order.amount,currency:order.currency,customerName:input.customer.name,phone:input.customer.primaryPhone,description:`${input.packageName} · ${input.pets.length} pet${input.pets.length===1?"":"s"}`});
  const completed=await apiSend<PaymentCompletion>("/api/payment-order",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"complete",bookingId:canonical.bookingId,razorpayOrderId:proof.razorpay_order_id,razorpayPaymentId:proof.razorpay_payment_id,razorpaySignature:proof.razorpay_signature})},"Razorpay payment could not be verified");
  if(completed.bookingId!==canonical.bookingId||completed.bookingStatus!=="confirmed"||completed.paymentStatus!=="captured"||completed.environment!=="sandbox")throw new Error("Canonical booking did not reach a verified captured payment state");
  return{...canonical,paymentStatus:completed.paymentStatus,paymentEnvironment:completed.environment};
}

export async function createCanonicalLifecycle(input:CanonicalLifecycleInput){
  const payload=input.serviceCode==="dog_training"&&input.packageCode!=="trainer-meet-greet"?await attestTrainingProgramme(input):input;
  const canonical=await apiSend<CanonicalLifecycleResult>("/api/canonical-bookings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)},"The shared booking record could not be created");
  if(input.serviceCode!=="grooming"||input.payment.mode!=="prepaid"||input.amountDueNow<=0)return canonical;
  try{return await completeGroomingSandboxPayment(input,canonical);}catch(error){const reason=error instanceof Error?error.message:"Payment failed";throw new Error(`Booking ${canonical.bookingId} is confirmed and reserved, but payment is not captured (${reason}). Do not rebook; retry payment for this booking.`);}
}
