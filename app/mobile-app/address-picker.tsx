"use client";
import{useState,useEffect}from"react";
import{resolveServiceCoverage}from"../../lib/service-zone-client";
import{resolveAddress,searchAddresses,type AddressSuggestion}from"../../lib/address-autocomplete-client";
import{createAddressSessionToken}from"../../lib/grooming-booking-calendar";
import{validGpsCoordinates}from"../../lib/gps-telemetry-policy";

export type Zone={zoneId:string;zoneName:string;description:string;color:string;serviceAvailable:boolean};
export type ZoneResult={zone:Zone;assignment:{pincode:string;zoneId:string;cityId:string;city:string;area:string};address:string;latitude:number;longitude:number;placeId:string};
export const SELECTED_SERVICE_ADDRESS_KEY="pawspace.selected-service-address";

const container={maxWidth:600,margin:"0 auto",padding:0,fontFamily:"inherit",display:"grid",gap:16} as const;
const box={background:"var(--ds-surface)",border:"1px solid var(--ds-border)",borderRadius:"var(--ds-radius-lg)",padding:16,display:"grid",gap:12} as const;
const label={display:"grid",gap:6,fontSize:14,fontWeight:500,color:"var(--ds-text)"} as const;
const input={minWidth:0,width:"100%",boxSizing:"border-box",color:"var(--ds-text)",background:"var(--ds-surface)",padding:"12px 14px",borderRadius:"var(--ds-radius-sm)",border:"1px solid var(--ds-border)",fontSize:15,fontFamily:"inherit"} as const;
const button={padding:"12px 20px",borderRadius:"var(--ds-radius-sm)",border:"none",fontSize:15,fontWeight:600,cursor:"pointer",transition:"background 0.2s"} as const;
const primaryButton={...button,background:"var(--ds-primary-500)",color:"#fff"} as const;
const zoneCard={padding:14,borderRadius:"var(--ds-radius-sm)",border:"2px solid var(--ds-border)",background:"var(--ds-surface)",transition:"all 0.2s"} as const;
const zoneCardActive=(color:string)=>({...zoneCard,borderColor:color,background:`${color}11`}) as const;
const badge={display:"inline-block",padding:"4px 8px",borderRadius:"var(--ds-radius-sm)",fontSize:12,fontWeight:600,textTransform:"uppercase"} as const;
function remember(result:ZoneResult|null){try{if(result)sessionStorage.setItem(SELECTED_SERVICE_ADDRESS_KEY,JSON.stringify({address:result.address,pincode:result.assignment.pincode,latitude:result.latitude,longitude:result.longitude,placeId:result.placeId}));else sessionStorage.removeItem(SELECTED_SERVICE_ADDRESS_KEY);}catch{/* storage is convenience only; server authority still fails closed */}}

export default function AddressPicker({onZoneResolved}:{onZoneResolved?:(zone:ZoneResult|null)=>void}){
 const[suggestions,setSuggestions]=useState<AddressSuggestion[]>([]),[lookupSession,setLookupSession]=useState("");
 const[address,setAddress]=useState(""),[pincode,setPincode]=useState(""),[resolvedZone,setResolvedZone]=useState<ZoneResult|null>(null),[zones,setZones]=useState<Zone[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState("");
 // Discovery only prefills the PIN. Complete address/map verification below remains mandatory.
 useEffect(()=>{const timer=window.setTimeout(()=>{try{const pin=sessionStorage.getItem("pawspace.discovery.pin");if(pin&&/^[1-9]\d{5}$/.test(pin))setPincode(pin);}catch{/* Optional session preference. */}},0);return()=>window.clearTimeout(timer);},[]);
 useEffect(()=>{async function loadZones(){try{const r=await fetch("/api/service-zone?action=list");const body=await r.json() as{data?:Zone[]};if(body.data)setZones(body.data);}catch(e){console.error("Failed to load zones:",e);}}void loadZones();},[]);
 function clear(){setResolvedZone(null);setSuggestions([]);setLookupSession("");setError("");remember(null);onZoneResolved?.(null);}
 async function resolveZone(){clear();setLoading(true);try{
  if(address.trim().length<8)throw new Error("Enter the complete doorstep address");
  if(!/^[1-9]\d{5}$/.test(pincode))throw new Error("Please enter a valid 6-digit pincode");
  await resolveServiceCoverage(pincode);
  const sessionToken=createAddressSessionToken(),lookup=await searchAddresses(`${address.trim()}, ${pincode}`,sessionToken);
  if(lookup.status!=="configured")throw new Error("Address verification is unavailable right now. Please try again later or contact PawSpace support.");
  const matches=lookup.suggestions.filter(suggestion=>suggestion.placeId&&suggestion.fullText);
  if(!matches.length)throw new Error("No matching map address was found. Check your complete address and PIN, then try again.");
  setLookupSession(sessionToken);setSuggestions(matches);
 }catch(e){setError(e instanceof Error?e.message:"Failed to find mapped addresses");}finally{setLoading(false);}}
 async function chooseAddress(suggestion:AddressSuggestion){setError("");setLoading(true);try{
  const coverage=await resolveServiceCoverage(pincode),place=await resolveAddress(suggestion.placeId,lookupSession);
  if(place.status!=="configured"||!validGpsCoordinates(Number(place.latitude),Number(place.longitude)))throw new Error(place.error||"The doorstep coordinates could not be verified");
  const mappedAddress=String(place.address||suggestion.fullText);
  if(!mappedAddress.includes(pincode))throw new Error("The mapped doorstep does not match the selected pincode. Choose another match or edit your address.");
  const zone:Zone={zoneId:coverage.zone.zoneId,zoneName:coverage.zone.zoneName,description:coverage.zone.description,color:coverage.zone.color,serviceAvailable:coverage.zone.serviceAvailable};
  const result:ZoneResult={zone,assignment:{pincode:coverage.pincode,zoneId:coverage.zoneId,cityId:coverage.cityId,city:coverage.city,area:coverage.area},address:mappedAddress,latitude:Number(place.latitude),longitude:Number(place.longitude),placeId:suggestion.placeId};
  setAddress(mappedAddress);setResolvedZone(result);setSuggestions([]);remember(result);onZoneResolved?.(result);
 }catch(e){setResolvedZone(null);remember(null);onZoneResolved?.(null);setError(e instanceof Error?e.message:"Failed to verify this address");}finally{setLoading(false);}}
 return<div style={container}><section style={box}><label style={label}>Where should we visit?<p style={{fontSize:13,color:"var(--ds-text-muted)",margin:0}}>Add your home address so your care professional can reach the right doorstep. We’ll check that care is available here.</p></label><div style={{display:"grid",gridTemplateColumns:"minmax(0,1fr)",gap:8}}><AddressAutofill style={input} type="text" placeholder="House / flat, street and landmark" value={address} onChange={value=>{setAddress(value);const pin=value.match(/\b[1-9]\d{5}\b/)?.[0];if(pin)setPincode(pin);clear();}} disabled={loading} aria-label="Complete doorstep address"/><input style={input} type="text" inputMode="numeric" aria-label="Pincode" placeholder="e.g., 560034" value={pincode} onChange={e=>{setPincode(e.target.value.replace(/\D/g,"").slice(0,6));clear();}} disabled={loading}/><button style={primaryButton} onClick={()=>void resolveZone()} disabled={loading||address.trim().length<8||pincode.length!==6}>{loading?"Verifying…":"Verify map"}</button></div>{error&&<p role="alert" style={{color:"var(--ds-danger-500)",fontSize:14,margin:0}}>{error}</p>}</section>
 {suggestions.length>0&&<section style={box} aria-label="Matching map addresses"><p style={{margin:0,fontSize:14}}>Choose your doorstep from the map matches. Check the street and PIN before continuing.</p>{suggestions.map(suggestion=><button key={suggestion.placeId} type="button" style={{...zoneCard,textAlign:"left",fontSize:14,color:"var(--ds-text)",overflowWrap:"anywhere"}} disabled={loading} onClick={()=>void chooseAddress(suggestion)}>{suggestion.fullText}</button>)}</section>}
 {resolvedZone&&<section style={box}><p style={{margin:0,fontSize:13,color:"var(--ds-text-muted)"}}>Verified service doorstep</p><div style={{...zoneCardActive(resolvedZone.zone.color),padding:16}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"start",gap:12}}><div><h3 style={{margin:"0 0 4px 0",fontSize:16,color:"var(--ds-text)"}}>{resolvedZone.zone.zoneName}</h3><p style={{margin:0,fontSize:13,color:"var(--ds-text-muted)"}}>{resolvedZone.address}</p><p style={{margin:"8px 0 0 0",fontSize:13,color:"var(--ds-text)"}}>📍 {resolvedZone.assignment.area}, {resolvedZone.assignment.city} · map verified</p></div><span style={{...badge,background:resolvedZone.zone.color,color:"#fff"}}>{resolvedZone.zone.serviceAvailable?"✓ Available":"Not available"}</span></div></div></section>}
 {zones.length>0&&!resolvedZone&&<details style={box}><summary style={{fontSize:14,color:"var(--ds-text)",cursor:"pointer"}}>Explore service areas</summary><div style={{display:"grid",gap:8}}>{zones.map(zone=><div key={zone.zoneId} style={zoneCard} aria-disabled="true"><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12}}><div><h4 style={{margin:"0 0 4px 0",fontSize:14,fontWeight:600}}>{zone.zoneName}</h4><p style={{margin:0,fontSize:12,color:"var(--ds-text-muted)"}}>{zone.description}</p></div><span aria-hidden="true" style={{width:12,height:12,flexShrink:0,borderRadius:"50%",background:zone.color}}/></div></div>)}</div></details>}</div>;
}
