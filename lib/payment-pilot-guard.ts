type Env=Record<string,unknown>;

export type PilotGuardResult={ok:true;bookingId:string}|{ok:false;reason:string};

function parsePilotIds(env:Env){
  const raw=String(env?.PAWSPACE_PAYMENT_PILOT_BOOKING_IDS??"").trim();
  if(!raw)return{ok:false as const,reason:"Production payment pilot allowlist is empty (PAWSPACE_PAYMENT_PILOT_BOOKING_IDS)"};
  const ids=raw.split(",").map((value)=>value.trim()).filter(Boolean);
  if(ids.length<5||ids.length>20)return{ok:false as const,reason:"Production payment pilot allowlist must contain between 5 and 20 booking IDs"};
  if(new Set(ids).size!==ids.length)return{ok:false as const,reason:"Production payment pilot allowlist must not contain duplicate booking IDs"};
  if(ids.some((id)=>id.length>128||!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)))return{ok:false as const,reason:"Production payment pilot allowlist contains an invalid booking ID"};
  return{ok:true as const,ids:new Set(ids)};
}

export function enforcePilotBooking(env:Env,environment:"sandbox"|"live",bookingId:unknown):PilotGuardResult{
  const id=String(bookingId??"").trim();
  if(environment!=="live")return{ok:true,bookingId:id};
  if(env?.PAWSPACE_PAYMENT_LIVE_APPROVED!=="true")return{ok:false,reason:"Live payments are not approved"};
  if(!id)return{ok:false,reason:"Live payment traffic requires a canonical booking ID during the controlled pilot"};
  const parsed=parsePilotIds(env);if(!parsed.ok)return parsed;
  if(!parsed.ids.has(id))return{ok:false,reason:`Booking ${id} is outside the controlled production payment pilot`};
  return{ok:true,bookingId:id};
}

export function pilotAllowlistReadiness(env:Env){
  const parsed=parsePilotIds(env);
  return parsed.ok?{configured:true,count:parsed.ids.size}:{configured:false,count:0,reason:parsed.reason};
}
