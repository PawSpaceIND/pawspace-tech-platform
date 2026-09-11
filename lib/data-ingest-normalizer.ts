type RawRow=Record<string,string>;
export type NormalizedIngestRow={
 customerId:string;leadId:string;name:string;primaryPhone:string;secondaryPhone:string|null;email:string|null;area:string;cityId:string;source:string;
 pet:{id:string;name:string;species:string;breed:string}|null;service:string;dropOffReason:string|null;lastServiceDate:string|null;historicalStatus:string;
 propensity:{total:number;engagement:number;profile:number;recency:number;value:number;grade:string;factors:Record<string,unknown>};
};

const aliases:Record<string,string[]>={
 customer_id:["customer_id","customerid","contact_id","crm_id"],name:["customer_name","name","full_name"],primary_phone:["primary_phone","phone","mobile","mobile_number","phone_number"],secondary_phone:["secondary_phone","alternate_phone","alt_phone"],email:["email","email_address"],area:["area","locality","sub_area"],city:["city","city_id"],source:["source","lead_source"],pet_name:["pet_name","pet","pet_names"],pet_species:["pet_species","species","pet_type"],pet_breed:["pet_breed","breed"],service:["service","service_code","last_service","primary_service"],drop_off_reason:["drop_off_reason","dropoff_reason","lost_reason","lead_drop_reason"],last_service_date:["last_service_date","last_service_at","last_booking_date"],historical_status:["historical_status","lead_status","status","stage"]
};
const clean=(v:unknown,max=240)=>String(v??"").replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim().slice(0,max);
const key=(v:string)=>v.toLowerCase().trim().replace(/[\s-]+/g,"_");
function pick(row:RawRow,name:keyof typeof aliases){for(const a of aliases[name]){const value=row[a];if(clean(value))return clean(value);}return"";}
export function canonicalizeHeaders(headers:string[]){return headers.map(key);}
export function rowFromValues(headers:string[],values:string[]):RawRow{const out:RawRow={};headers.forEach((h,i)=>{out[h]=values[i]??""});return out;}
export function normalizeIndianPhone(value:string){const digits=clean(value,32).replace(/\D/g,"");if(!digits)return"";if(digits.length===10&&/^[6-9]/.test(digits))return`+91${digits}`;if(digits.length===12&&digits.startsWith("91")&&/^[6-9]/.test(digits.slice(2)))return`+${digits}`;if(digits.length===11&&digits.startsWith("0")&&/^[6-9]/.test(digits.slice(1)))return`+91${digits.slice(1)}`;return"";}
function normalizeDate(value:string){const v=clean(value,40);if(!v)return null;if(/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(`${v}T00:00:00Z`)))return v;const parsed=Date.parse(v);return Number.isNaN(parsed)?null:new Date(parsed).toISOString().slice(0,10);}
function slug(value:string,fallback:string){return clean(value,80).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||fallback;}
function hashIdentity(phone:string,email:string,name:string){const seed=`${phone}|${email.toLowerCase()}|${name.toLowerCase()}`;let h=2166136261;for(let i=0;i<seed.length;i++){h^=seed.charCodeAt(i);h=Math.imul(h,16777619)}return(h>>>0).toString(36).toUpperCase();}
function baselinePropensity(input:{dropOffReason:string|null;lastServiceDate:string|null;hasPet:boolean;email:string|null}){
 let recency=15,engagement=20,value=10,profile=15;const factors:Record<string,unknown>={model:"ingest_baseline_v1"};
 if(input.lastServiceDate){const days=Math.max(0,Math.floor((Date.now()-Date.parse(`${input.lastServiceDate}T00:00:00Z`))/86400000));recency=days<=30?30:days<=90?24:days<=180?16:8;factors.recencyDays=days;}
 const r=(input.dropOffReason||"").toLowerCase();if(r){if(/price|cost|expensive|budget/.test(r)){engagement=24;value=14;factors.dropOffSignal="price_sensitive";}else if(/no response|unreachable|rnr|not reachable/.test(r)){engagement=10;factors.dropOffSignal="unreachable";}else if(/timing|slot|availability|later|postpone/.test(r)){engagement=27;factors.dropOffSignal="timing";}else if(/competitor|other provider/.test(r)){engagement=18;factors.dropOffSignal="competitor";}else{engagement=17;factors.dropOffSignal="other";}}
 if(input.hasPet)profile+=8;if(input.email)profile+=4;const total=Math.max(0,Math.min(100,engagement+profile+recency+value));return{total,engagement,profile,recency,value,grade:total>=75?"A":total>=60?"B":total>=45?"C":"D",factors};
}
export function normalizeIngestRow(row:RawRow,rowNumber:number):NormalizedIngestRow{
 const name=pick(row,"name")||"Unknown customer",primaryPhone=normalizeIndianPhone(pick(row,"primary_phone")),email=clean(pick(row,"email"),180).toLowerCase()||null;if(!primaryPhone)throw new Error(`row_${rowNumber}: invalid_or_missing_primary_phone`);
 const supplied=clean(pick(row,"customer_id"),100),identity=hashIdentity(primaryPhone,email||"",name),customerId=supplied||`IMP-CU-${identity}`,leadId=`IMP-LEAD-${identity}`;
 const petName=pick(row,"pet_name"),petSpecies=slug(pick(row,"pet_species"),"unknown"),petBreed=pick(row,"pet_breed")||"Unknown",petIdentity=petName?hashIdentity(primaryPhone,petSpecies,petName):"";const pet=petName?{id:`IMP-PET-${identity}-${petIdentity}`,name:petName,species:petSpecies,breed:petBreed}:null;
 const dropOffReason=pick(row,"drop_off_reason")||null,lastServiceDate=normalizeDate(pick(row,"last_service_date")),service=slug(pick(row,"service"),"general_inquiry");
 return{customerId,leadId,name,primaryPhone,secondaryPhone:normalizeIndianPhone(pick(row,"secondary_phone"))||null,email,area:pick(row,"area")||pick(row,"city")||"Unknown",cityId:slug(pick(row,"city"),"blr"),source:pick(row,"source")||"founder_csv_import",pet,service,dropOffReason,lastServiceDate,historicalStatus:pick(row,"historical_status")||"imported",propensity:baselinePropensity({dropOffReason,lastServiceDate,hasPet:Boolean(pet),email})};
}

/** RFC4180-aware streaming CSV parser. Carries quoted fields/newlines across Web Stream chunks. */
export async function* parseCsvStream(stream:ReadableStream<Uint8Array>){const reader=stream.getReader(),decoder=new TextDecoder();let field="",row:string[]=[],quoted=false,pendingQuote=false;const push=()=>{row.push(field);field=""};const emit=()=>{push();const out=row;row=[];return out};
 while(true){const{done,value}=await reader.read();const text=decoder.decode(value||new Uint8Array(),{stream:!done});for(let i=0;i<text.length;i++){const ch=text[i];if(pendingQuote){if(ch==='"'){field+='"';pendingQuote=false;continue}quoted=false;pendingQuote=false}
   if(quoted){if(ch==='"')pendingQuote=true;else field+=ch;continue}if(ch==='"'&&field===""){quoted=true;continue}if(ch===','){push();continue}if(ch==='\n'){if(row.length||field){const out=emit();if(out.some(v=>v!==""))yield out}continue}if(ch==='\r')continue;field+=ch}
  if(done)break}
 if(pendingQuote){quoted=false;pendingQuote=false}if(quoted)throw new Error("unterminated_quoted_csv_field");if(row.length||field){const out=emit();if(out.some(v=>v!==""))yield out}}
