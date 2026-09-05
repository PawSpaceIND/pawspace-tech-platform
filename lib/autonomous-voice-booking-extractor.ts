type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const label=(source:string,key:string)=>{const escaped=key.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");const match=source.match(new RegExp(`${escaped}\\s*[:=]\\s*(.+?)(?=\\s+[a-z_]+\\s*[:=]|$)`,"i"));return match?match[1].trim():"";};

/**
 * Deterministic boundary between STT/LLM understanding and booking.create. Production voice can send
 * the JSON shape directly; the labelled form exists so synthetic transcript UAT can exercise the same
 * extraction/parameter-lock path without giving tests an LLM-shaped mock.
 * Keep this boundary deterministic so CI can certify the autonomous booking path without live-model variance.
 */
export function extractVoiceBookingCreate(transcript:string){
 const source=text(transcript);if(!source)return{intent:"unknown",complete:false,arguments:{},missing:["transcript"]};
 let row:Row={};
 try{const parsed=JSON.parse(source);if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))row=parsed as Row;}catch{}
 const intent=text(row.intent)||(/\bbooking_create\b/i.test(source)?"booking_create":"unknown");
 if(intent!=="booking_create")return{intent,complete:false,arguments:{},missing:[]};
 const serviceLocation=row.service_location&&typeof row.service_location==="object"&&!Array.isArray(row.service_location)?row.service_location as Row:{};
 const customer_phone=text(row.customer_phone)||label(source,"customer_phone");
 const pet_id=text(row.pet_id)||label(source,"pet_id");
 const breed=text(row.breed)||label(source,"breed");
 const service_id=text(row.service_id)||label(source,"service_id");
 const date_time_slot=text(row.date_time_slot)||label(source,"date_time_slot");
 const address=text(serviceLocation.address)||label(source,"service_location")||label(source,"address");
 const pincode=text(serviceLocation.pincode)||label(source,"pincode");
 const args={customer_phone,pet_id:pet_id||undefined,breed:breed||undefined,service_id,date_time_slot,service_location:{address,pincode},transcript:source};
 const missing:string[]=[];
 if(!customer_phone)missing.push("customer_phone");if(!pet_id&&!breed)missing.push("pet_id/breed");if(!service_id)missing.push("service_id");if(!date_time_slot)missing.push("date_time_slot");if(!address||!pincode)missing.push("service_location");
 return{intent:"booking_create",complete:missing.length===0,arguments:args,missing};
}
