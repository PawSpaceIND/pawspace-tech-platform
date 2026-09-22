type AddressParts={line1:string;line2?:string|null;area?:string|null;city?:string|null;postalCode?:string|null;country?:string|null};
const clean=(value:string)=>value.trim().replace(/\s+/g," ");
const key=(value:string)=>clean(value).toLocaleLowerCase("en-IN");

/** Keep structured locality fields from being appended again when line1 is already a full address.
 * Only duplicate known locality/PIN/country components are collapsed; street/unit text is retained. */
export function serviceAddressText(address:AddressParts){
 const locality=[address.area,address.city,address.postalCode,address.country].filter((value):value is string=>Boolean(value?.trim())).map(clean);
 const known=new Set(locality.map(key)),seen=new Set<string>();
 const parts=[address.line1,address.line2].filter((value):value is string=>Boolean(value?.trim())).flatMap(value=>value.split(",")).map(clean).filter(Boolean).filter(value=>{
  const normalized=key(value);
  if(!known.has(normalized))return true;
  if(seen.has(normalized))return false;
  seen.add(normalized);return true;
 });
 for(const value of locality){
  const normalized=key(value);
  if(seen.has(normalized))continue;
  // A PIN may already be part of a state/postal segment in a Maps-formatted address.
  if(/^\d{6}$/.test(value)&&parts.some(part=>new RegExp(`\\b${value}\\b`).test(part))){seen.add(normalized);continue;}
  parts.push(value);seen.add(normalized);
 }
 return parts.join(", ");
}
