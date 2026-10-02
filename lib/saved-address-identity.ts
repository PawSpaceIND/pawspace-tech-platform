type Address=Record<string,unknown>;
const clean=(value:unknown)=>String(value??"").trim().toLowerCase().replace(/\s+/g," ").replace(/\bbangalore\b/g,"bengaluru");
const pin=(a:Address)=>clean(a.postalCode??a.postal_code);
/** Normalize only known locality components. Never sort, discard or fuzzy-match street/unit text. */
export function savedAddressIdentity(a:Address,locality:Address=a){
 const known=new Set([a.area,a.city,locality.area,locality.city,"India",pin(a)].map(clean).filter(Boolean));
 const parts=[a.line1,a.line2].flatMap(value=>String(value??"").split(",")).map(clean).filter(Boolean).filter(part=>!known.has(part)&&part!==`karnataka ${pin(a)}`);
 return JSON.stringify([pin(a),clean(a.area||locality.area),clean(a.city||locality.city),parts]);
}
export function sameSavedAddress(a:Address,b:Address){
 if(!pin(a)||pin(a)!==pin(b))return false;
 if(a.area&&b.area&&clean(a.area)!==clean(b.area))return false;
 if(a.city&&b.city&&clean(a.city)!==clean(b.city))return false;
 return savedAddressIdentity(a,b)===savedAddressIdentity(b,a);
}
/** Read-only projection: retain canonical IDs/rows and keep different or unknown coordinate evidence apart. */
export function distinctSavedAddresses<T extends Address>(addresses:T[]):T[]{
 const visible:T[]=[];
 for(const address of addresses){
  if(!visible.some(other=>sameSavedAddress(address,other)&&address.latitude===other.latitude&&address.longitude===other.longitude))visible.push(address);
 }
 return visible;
}

/** Full digest includes the exact owner, rather than a lossy display token or a 32-bit suffix. */
export async function savedAddressId(customerId:string,address:Address){
 const bytes=new TextEncoder().encode(JSON.stringify([customerId,savedAddressIdentity(address)]));
 const digest=await crypto.subtle.digest("SHA-256",bytes);
 return `ADDR-${Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,"0")).join("")}`;
}
