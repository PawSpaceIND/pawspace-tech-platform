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
const GOVERNMENT_ID=/\b(?:\d{12}|\d{16})\b/g;
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
