const SENSITIVE_KEY=/(?:^|_)(?:phone|mobile|email|address|doorstep|street|house|flat|apartment|landmark|pincode|postal_code)(?:$|_)/i;
const EMAIL=/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE=/(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{9}(?!\d)/g;

function sanitizeString(value:string){return value.replace(EMAIL,"[redacted-email]").replace(PHONE,"[redacted-phone]");}

/** Provider-facing lifecycle details are untrusted historical JSON. Strip contact/location keys
 * recursively and redact contact-shaped strings even when an old producer used an unexpected key. */
export function sanitizeProviderDetail(value:unknown):unknown{
  if(typeof value==="string")return sanitizeString(value);
  if(Array.isArray(value))return value.map(sanitizeProviderDetail);
  if(value&&typeof value==="object"){
    const clean:Record<string,unknown>={};
    for(const[key,item]of Object.entries(value as Record<string,unknown>)){
      if(SENSITIVE_KEY.test(key))continue;
      clean[key]=sanitizeProviderDetail(item);
    }
    return clean;
  }
  return value;
}
