import { createAutonomousBooking, createExplicitAutonomousException, detectAutonomousHumanException, type AutonomousBookingInput } from "./autonomous-booking-engine";
import { requireCustomerOwnership, type AuthenticatedActor } from "./server-auth";

type Row=Record<string,unknown>;
type Runtime=Record<string,unknown>;

export const AUTONOMOUS_BOOKING_TOOL = {
  code:"booking.create",
  mode:"mutation",
  canonicalService:"autonomous-booking-engine",
  intents:["booking_create"],
  channels:["voice"],
  confirmationRequired:false,
  idempotencyRequired:true,
  description:"Create a server-validated provisional voice booking, send its payment link and wait for signed payment capture. Price, provider and payment state remain server-authoritative.",
} as const;

const text=(value:unknown)=>String(value??"").trim();

function location(value:unknown){
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("service_location must contain address and pincode");
  const row=value as Row;
  const address=text(row.address),pincode=text(row.pincode);
  if(!address||!/^[1-9][0-9]{5}$/.test(pincode))throw new Error("service_location requires a full address and six-digit pincode");
  return{address,pincode,latitude:row.latitude==null?null:Number(row.latitude),longitude:row.longitude==null?null:Number(row.longitude)};
}

export function validateBookingCreateArguments(customerId:string,args:Row,idempotencyKey:string,actorId:string,threadId?:string|null):AutonomousBookingInput{
  const customerPhone=text(args.customer_phone??args.customerPhone);
  const petId=text(args.pet_id??args.petId)||null,breed=text(args.breed)||null;
  const serviceId=text(args.service_id??args.serviceId);
  const dateTimeSlot=text(args.date_time_slot??args.dateTimeSlot);
  if(!customerPhone)throw new Error("booking.create parameter lock: customer_phone is required");
  if(!petId&&!breed)throw new Error("booking.create parameter lock: pet_id or breed is required");
  if(!serviceId)throw new Error("booking.create parameter lock: service_id is required");
  if(!dateTimeSlot)throw new Error("booking.create parameter lock: date_time_slot is required");
  if(!args.service_location&&!args.serviceLocation)throw new Error("booking.create parameter lock: service_location is required");
  return{customerId,customerPhone,petId,breed,serviceId,dateTimeSlot,serviceLocation:location(args.service_location??args.serviceLocation),idempotencyKey,actorId,threadId};
}

export async function executeGovernedBookingCreate(db:D1Database,runtime:Runtime,input:{actor:AuthenticatedActor;customerId:string;threadId?:string|null;channel:string;intent:string;arguments:Row;idempotencyKey:string}){
  if(input.channel!=="voice")throw new Response("booking.create is enabled only for the governed voice runtime",{status:403});
  if(input.intent!=="booking_create")throw new Response("booking.create is allowed only for booking_create intent",{status:403});
  await requireCustomerOwnership(db,input.actor,input.customerId);
  const explicitText=text(input.arguments.transcript??input.arguments.customer_utterance);
  const edge=explicitText?detectAutonomousHumanException(explicitText):null;
  if(edge){
    const exception=await createExplicitAutonomousException(db,{customerId:input.customerId,transcript:explicitText,actorId:input.actor.email});
    return{status:"human_exception",executed:false,tool:"booking.create",autonomousExecution:false,humanApprovalRequired:true,reason:edge.reasonCode,exception};
  }
  const locked=validateBookingCreateArguments(input.customerId,input.arguments,input.idempotencyKey,input.actor.email,input.threadId);
  const result=await createAutonomousBooking(db,runtime,locked);
  return{status:"completed",executed:true,tool:"booking.create",autonomousExecution:true,humanApprovalRequired:false,result};
}

export function autonomousBookingToolSnapshot(){return{...AUTONOMOUS_BOOKING_TOOL,permitted:true,autonomousExecution:true,serverAuthoritative:["price","total_amount","provider_id","payment_status","payout"]};}
