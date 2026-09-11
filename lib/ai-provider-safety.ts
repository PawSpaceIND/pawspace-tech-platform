export const EXTERNAL_AI_REDACTION="[REDACTED]";

export type AiPrivacyCategory=
 |"email"
 |"phone"
 |"government_id"
 |"pan"
 |"upi"
 |"credential"
 |"sensitive_field";

export type SanitizedAiProviderText={text:string;redacted:boolean;categories:AiPrivacyCategory[]};

const EMAIL=/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g;
const INDIAN_PHONE=/\b(?:\+?91[\s().-]*)?[6-9](?:[\s().-]*\d){9}\b/g;
const GENERIC_E164=/\+[1-9](?:[\s().-]*\d){7,14}\b/g;
/*
 * Government IDs and card numbers, INCLUDING the grouped forms people actually write.
 *
 * The unbroken-digits-only pattern missed the most common real spelling of the most sensitive
 * identifier in India: an Aadhaar number is written "1234 5678 9012" in 4-4-4 groups essentially
 * everywhere, and a card PAN as "4111 1111 1111 1111". Measured against this module before the
 * fix, both reached the external AI provider in clear text - and this is the last-mile boundary
 * whose entire job is to stop exactly that.
 *
 * 12 to 19 digits in separator-delimited groups. It is applied before the phone patterns (see
 * redactPatterns below), so a grouped run is redacted whole rather than being partly consumed by
 * a narrower match first; an Indian mobile is 10 digits and so cannot reach this length. [D31-W15]
 */
const GOVERNMENT_ID=/\b\d(?:[ -]?\d){11,18}\b/g;
const PAN=/\b[A-Z]{5}\d{4}[A-Z]\b/g;
const UPI=/\b[a-z0-9._-]{2,128}@(ybl|ibl|axl|upi|paytm|okaxis|okhdfcbank|okicici|oksbi|apl|icici|sbi|kotak)\b/gi;
const CREDENTIAL=/(?:\bBearer\s+[A-Za-z0-9._~+\/-]+=*|\bsk-ant-[A-Za-z0-9_-]{8,}|\bsk-[A-Za-z0-9_-]{16,}|\brzp_(?:test|live)_[A-Za-z0-9_-]{6,})/gi;

const SENSITIVE_KEYS=new Set([
 "email","emailaddress","primaryemail","secondaryemail",
 "phone","phonenumber","mobile","mobilenumber","primaryphone","secondaryphone","caller","recipient",
 "address","addressline1","addressline2","street","area","pincode","postalcode","postcode",
 "customername","providername","displayname","businessname","firstname","lastname","petname",
 "vaccinationstatus","vaccination","health","healthstatus","medical","medicalnotes","diagnosis",
 "subject","ticketsubject","supportsubject","notes","interviewnotes",
 "customerid","providerid","petid","governmentid","aadhaar","aadhar","pan",
]);

const normaliseKey=(value:string)=>value.toLowerCase().replace(/[^a-z0-9]/g,"");

function redactPatterns(value:string,categories:Set<AiPrivacyCategory>){
 let output=value;
 const replace=(pattern:RegExp,category:AiPrivacyCategory)=>{
  pattern.lastIndex=0;
  if(pattern.test(output))categories.add(category);
  pattern.lastIndex=0;
  output=output.replace(pattern,EXTERNAL_AI_REDACTION);
 };
 replace(CREDENTIAL,"credential");
 replace(EMAIL,"email");
 replace(UPI,"upi");
 replace(PAN,"pan");
 replace(GOVERNMENT_ID,"government_id");
 replace(INDIAN_PHONE,"phone");
 replace(GENERIC_E164,"phone");
 return output;
}

function sanitizeValue(value:unknown,categories:Set<AiPrivacyCategory>,key:string|null,depth:number):unknown{
 if(depth>16)return EXTERNAL_AI_REDACTION;
 if(key&&SENSITIVE_KEYS.has(normaliseKey(key))){categories.add("sensitive_field");return value==null?value:EXTERNAL_AI_REDACTION;}
 if(typeof value==="string")return redactPatterns(value,categories);
 /*
  * NUMBERS ARE VALUES TOO. sanitizeValue() only ever pattern-checked strings, so an identifier
  * sent as a JSON number went straight through: {"idNumber":123456789012} reached the provider in
  * clear while {"idNumber":"123456789012"} - the identical value - was redacted. The field-name
  * layer caught it only when the key happened to be in SENSITIVE_KEYS, which "idNumber" is not.
  *
  * Only long integer runs are treated as identifiers, because everything else a payload legitimately
  * carries as a number - a price, a count, a percentage, a duration - is short. The one long number
  * that IS legitimate context is an epoch-millisecond timestamp, so 13-digit values inside a
  * plausible epoch window are left alone; redacting those would strip every timestamp the assistant
  * needs to answer "when". Aadhaar is 12 digits (below that window entirely) and card PANs are 14-19
  * (above it), so both are still caught. The narrow gap this leaves is a 13-digit card that happens
  * to fall inside the epoch range, which is the deliberate trade. [D31-W15]
  */
 if(typeof value==="number"&&Number.isFinite(value)&&Number.isInteger(value)){
  const digits=Math.abs(value).toString();
  const plausibleEpochMs=digits.length===13&&Math.abs(value)>=1e12&&Math.abs(value)<4e12;
  if(digits.length>=12&&digits.length<=19&&!plausibleEpochMs){categories.add("government_id");return EXTERNAL_AI_REDACTION;}
 }
 if(Array.isArray(value))return value.map(item=>sanitizeValue(item,categories,null,depth+1));
 if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([entryKey,entryValue])=>[entryKey,sanitizeValue(entryValue,categories,entryKey,depth+1)]));
 return value;
}

/**
 * Last-mile privacy guard for every external LLM request. Structured JSON is scrubbed by field name
 * and then every remaining string is pattern-redacted. Plain-text prompts still receive the pattern
 * layer, so callers cannot bypass the boundary by avoiding JSON.
 */
export function sanitizeAiProviderText(input:string):SanitizedAiProviderText{
 const source=String(input??"");
 const categories=new Set<AiPrivacyCategory>();
 let text:string;
 try{
  const parsed=JSON.parse(source) as unknown;
  text=JSON.stringify(sanitizeValue(parsed,categories,null,0));
 }catch{
  text=redactPatterns(source,categories);
 }
 return{text,redacted:categories.size>0,categories:[...categories].sort()};
}
