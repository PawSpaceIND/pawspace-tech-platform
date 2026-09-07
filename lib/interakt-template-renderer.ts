type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
const parse=<T>(value:unknown,fallback:T):T=>{try{return JSON.parse(String(value??"")) as T}catch{return fallback}};

function readPath(payload:Row,path:string){
 const parts=path.split(".").map(part=>part.trim()).filter(Boolean);
 let current:unknown=payload;
 for(const part of parts){
  if(!current||typeof current!=="object"||Array.isArray(current))return undefined;
  current=(current as Row)[part];
 }
 return current;
}

function defaultValueFor(variable:string,payload:Row,message:Row){
 const key=variable.toLowerCase();
 const candidates:Record<string,unknown>={
  booking_id:payload.bookingId??payload.booking_id??message.booking_id,
  bookingid:payload.bookingId??payload.booking_id??message.booking_id,
  service_code:payload.serviceCode??payload.service_code,
  servicecode:payload.serviceCode??payload.service_code,
  event_id:payload.eventId??payload.event_id,
  eventid:payload.eventId??payload.event_id,
  notification_id:payload.notificationId??payload.notification_id,
  notificationid:payload.notificationId??payload.notification_id,
  body:payload.body,
  title:payload.title,
  customer_id:message.customer_id,
  customerid:message.customer_id,
  scheduled_at:payload.scheduledAt??payload.scheduled_at,
  scheduledat:payload.scheduledAt??payload.scheduled_at,
  timestamp:payload.timestamp??payload.occurredAt??payload.occurred_at,
 };
 return candidates[key];
}

export function renderInteraktTemplateValues(input:{template:Row;payload:Row;message:Row}){
 const explicit=Array.isArray(input.payload.bodyValues)?input.payload.bodyValues:Array.isArray(input.payload.values)?input.payload.values:null;
 const variables=parse<string[]>(input.template.variables_json,[]);
 if(explicit){
  if(variables.length&&explicit.length!==variables.length)throw new Error(`Interakt template requires ${variables.length} values but received ${explicit.length}`);
  return explicit.map((value,index)=>{const rendered=text(value);if(!rendered)throw new Error(`Interakt template variable {{${index+1}}} is empty`);if(rendered.length>1024)throw new Error(`Interakt template variable {{${index+1}}} exceeds 1024 characters`);return rendered;});
 }
 if(!variables.length)return[];
 return variables.map((variable,index)=>{
  const pathValue=readPath(input.payload,variable);
  const rendered=text(pathValue??defaultValueFor(variable,input.payload,input.message));
  if(!rendered)throw new Error(`Missing required Interakt template variable {{${index+1}}} (${variable})`);
  if(rendered.length>1024)throw new Error(`Interakt template variable {{${index+1}}} exceeds 1024 characters`);
  return rendered;
 });
}
