export type TestBookingStatus="confirmed"|"awaiting_acceptance"|"assigned"|"on_the_way"|"arrived"|"in_service"|"completed"|"cancelled";
export type TestBookingEvent={at:string;surface:"customer"|"crm"|"admin"|"provider"|"ops"|"accounts"|"system";label:string};
export type TestTransaction={
  id:string;customerId:string;customerName:string;primary:string;secondary:string;pets:string;petCount:number;service:string;packageName:string;
  area:string;slot:string;duration:string;amount:number;payment:string;paymentStatus:"paid"|"due_after_service"|"credit_reserved"|"credit_consumed"|"cancelled";
  provider:string;providerModel:"Full-time"|"Commission";status:TestBookingStatus;subscription:string;creditsBefore:number;creditsAfter:number;
  crmOwner:string;crmNextAction:string;reminder:string;updatedAt:string;events:TestBookingEvent[];
  offerCode?:string;discount?:number;referralStatus?:"pending_completion"|"reward_released"|"reversed";
};
export type TestLedger={version:2;activeId:string|null;transactions:TestTransaction[]};

const ledgerKey="pawspace:synthetic-ledger:v2";const legacyKey="pawspace:synthetic-transaction:v1";const changeEvent="pawspace-test-ledger-change";
const timestamp=()=>new Date().toISOString();const emptyLedger:TestLedger={version:2,activeId:null,transactions:[]};
const allowedStatuses:TestBookingStatus[]=["confirmed","awaiting_acceptance","assigned","on_the_way","arrived","in_service","completed","cancelled"];
let cachedRaw:string|null|undefined;let cachedLedger:TestLedger=emptyLedger;

function validTransaction(value:unknown):value is TestTransaction{return Boolean(value&&typeof value==="object"&&"id" in value&&"status" in value&&typeof value.id==="string"&&allowedStatuses.includes(value.status as TestBookingStatus));}
export function readTestLedger():TestLedger{
  if(typeof window==="undefined")return emptyLedger;
  try{const raw=window.localStorage.getItem(ledgerKey);if(raw===cachedRaw)return cachedLedger;cachedRaw=raw;if(raw){const parsed=JSON.parse(raw) as TestLedger;if(parsed.version===2&&Array.isArray(parsed.transactions)){cachedLedger={version:2,activeId:parsed.activeId,transactions:parsed.transactions.filter(validTransaction)};return cachedLedger}}
    const legacyRaw=window.localStorage.getItem(legacyKey);if(legacyRaw){const legacy=JSON.parse(legacyRaw) as unknown;if(validTransaction(legacy)){cachedLedger={version:2,activeId:legacy.id,transactions:[legacy]};return cachedLedger}}
  }catch{}cachedLedger=emptyLedger;return cachedLedger;
}
export function readTestTransaction():TestTransaction|null{const ledger=readTestLedger();return ledger.transactions.find(item=>item.id===ledger.activeId)??ledger.transactions[0]??null;}
function persistLedger(ledger:TestLedger){const raw=JSON.stringify(ledger);cachedRaw=raw;cachedLedger=ledger;window.localStorage.setItem(ledgerKey,raw);window.dispatchEvent(new CustomEvent(changeEvent,{detail:ledger}));return ledger;}

/**
 * `payment` is the sentence shown to a human ("50% deposit paid in UAT sandbox · ₹4,500 due 24 hours
 * before check-in"). The money state used to be *inferred* from that sentence by matching it against
 * two exact strings, so anything that read naturally fell through to "due_after_service": every
 * Boarding and Sitting stay, every Training programme, and any Grooming booking with a coupon
 * appended. Paid bookings were recorded as unpaid, and every finance screen counted them that way.
 *
 * The caller now states the money state outright. It is required, so a new flow cannot be added
 * without saying whether its money was collected - the compiler asks the question.
 */
export type TestPaymentState=TestTransaction["paymentStatus"];
type NewTestTransaction=Omit<TestTransaction,"id"|"status"|"paymentStatus"|"creditsAfter"|"updatedAt"|"events">&{paymentState:TestPaymentState};

export function createTestTransaction({paymentState,...input}:NewTestTransaction,canonicalBookingId?:string){
  const ledger=readTestLedger();const at=timestamp();const suffix=input.customerId.replace(/\D/g,"").slice(-3)||String(Date.now()).slice(-3);const sequence=ledger.transactions.filter(item=>item.customerId===input.customerId).length+1;
  const status:TestBookingStatus=input.providerModel==="Commission"?"awaiting_acceptance":"assigned";const paymentStatus=paymentState;
  const transaction:TestTransaction={...input,id:canonicalBookingId??`PS-T${suffix}-${String(sequence).padStart(2,"0")}`,status,paymentStatus,creditsAfter:input.creditsBefore,referralStatus:input.offerCode==="KARTHIK"?"pending_completion":input.referralStatus,updatedAt:at,events:[
    {at,surface:"customer",label:"Booking confirmed instantly"},{at,surface:"crm",label:"Customer timeline and opportunity updated"},{at,surface:"admin",label:status==="awaiting_acceptance"?"Commission-provider offer created":"Full-time provider assigned automatically"},{at,surface:"system",label:"Payment state recorded and reminder queued"},
  ]};persistLedger({version:2,activeId:transaction.id,transactions:[transaction,...ledger.transactions].slice(0,100)});return transaction;
}
export function setActiveTestTransaction(id:string){const ledger=readTestLedger();if(!ledger.transactions.some(item=>item.id===id))return null;persistLedger({...ledger,activeId:id});return readTestTransaction();}
export function clearTestLedger(){persistLedger(emptyLedger);}
export function updateTestTransaction(patch:Partial<TestTransaction>,surface:TestBookingEvent["surface"],label:string){
  const ledger=readTestLedger();const current=readTestTransaction();if(!current)return null;const at=timestamp();const next={...current,...patch,updatedAt:at,events:[{at,surface,label},...current.events].slice(0,30)};persistLedger({...ledger,transactions:ledger.transactions.map(item=>item.id===current.id?next:item)});return next;
}
export function progressTestTransaction(){const current=readTestTransaction();if(!current)return null;const transitions:Partial<Record<TestBookingStatus,TestBookingStatus>>={awaiting_acceptance:"assigned",assigned:"on_the_way",confirmed:"on_the_way",on_the_way:"arrived",arrived:"in_service",in_service:"completed"};const nextStatus=transitions[current.status];if(!nextStatus)return current;const completed=nextStatus==="completed";const credit=completed&&current.paymentStatus==="credit_reserved";const referralReleased=completed&&current.referralStatus==="pending_completion";return updateTestTransaction({status:nextStatus,paymentStatus:credit?"credit_consumed":current.paymentStatus,creditsAfter:credit?Math.max(0,current.creditsBefore-1):current.creditsAfter,referralStatus:referralReleased?"reward_released":current.referralStatus},"provider",referralReleased?"First booking completed; referrer reward released for next booking":completed?"Service completed; evidence, ledger and history closed":nextStatus==="assigned"?"Commission provider accepted the job":`Job status changed to ${nextStatus.replaceAll("_"," ")}`);}
export function injectTestException(code:"wait_15"|"wait_30"|"provider_cancel"|"payment_due"|"commission_decline"){
  const actions={wait_15:{crmNextAction:"Urgent: customer unreachable",reminder:"15-minute waiting reminder queued"},wait_30:{crmNextAction:"Offer customer reschedule calendar",reminder:"30-minute rebooking option unlocked"},provider_cancel:{status:"confirmed" as TestBookingStatus,provider:"Reassignment queue",crmNextAction:"Find replacement provider"},payment_due:{paymentStatus:"due_after_service" as const,crmNextAction:"Payment recovery task"},commission_decline:{status:"confirmed" as TestBookingStatus,provider:"Offer rerouting",crmNextAction:"Commission offer declined; reroute"}};
  const labels={wait_15:"15-minute wait breached; customer reminder and Admin ticket created",wait_30:"30-minute wait breached; customer reschedule calendar unlocked",provider_cancel:"Provider cancelled; capacity reroute and customer protection started",payment_due:"Pay-after-service outstanding; primary-number reminder and accounts task queued",commission_decline:"Commission provider declined; next eligible provider offer created"};
  return updateTestTransaction(actions[code],"system",labels[code]);
}
export function subscribeTestLedger(listener:()=>void){const local=()=>listener();const storage=(event:StorageEvent)=>{if(event.key===ledgerKey||event.key===legacyKey)local()};window.addEventListener(changeEvent,local);window.addEventListener("storage",storage);return()=>{window.removeEventListener(changeEvent,local);window.removeEventListener("storage",storage)};}
export function subscribeTestTransaction(listener:()=>void){return subscribeTestLedger(listener);}
