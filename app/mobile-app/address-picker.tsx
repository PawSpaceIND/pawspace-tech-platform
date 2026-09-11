"use client";
import{useState,useEffect}from"react";
import{resolveServiceCoverage}from"../../lib/service-zone-client";
import{resolveAddress,searchAddresses,type AddressSuggestion}from"../../lib/address-autocomplete-client";
import{createAddressSessionToken}from"../../lib/grooming-booking-calendar";
import{validGpsCoordinates}from"../../lib/gps-telemetry-policy";
import styles from"./address-picker.module.css";
import type{CSSProperties}from"react";

export type Zone={zoneId:string;zoneName:string;description:string;color:string;serviceAvailable:boolean};
export type ZoneResult={zone:Zone;assignment:{pincode:string;zoneId:string;cityId:string;city:string;area:string};address:string;latitude:number;longitude:number;placeId:string};
export const SELECTED_SERVICE_ADDRESS_KEY="pawspace.selected-service-address";

function remember(result:ZoneResult|null){try{if(result)sessionStorage.setItem(SELECTED_SERVICE_ADDRESS_KEY,JSON.stringify({address:result.address,pincode:result.assignment.pincode,latitude:result.latitude,longitude:result.longitude,placeId:result.placeId}));else sessionStorage.removeItem(SELECTED_SERVICE_ADDRESS_KEY);}catch{/* storage is convenience only; server authority still fails closed */}}

export default function AddressPicker({onZoneResolved}:{onZoneResolved?:(zone:ZoneResult|null)=>void}){
 const[suggestions,setSuggestions]=useState<AddressSuggestion[]>([]),[lookupSession,setLookupSession]=useState("");
 const[address,setAddress]=useState(""),[pincode,setPincode]=useState(""),[resolvedZone,setResolvedZone]=useState<ZoneResult|null>(null),[zones,setZones]=useState<Zone[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState("");
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
 return <div className={styles.container}><section className={styles.box}><label className={styles.label}>Service area lookup<p className={styles.hint}>Enter your doorstep and pincode. PawSpace verifies the mapped coordinates before the booking can continue.</p></label><div className={styles.lookupRow}><input className={styles.input} type="text" placeholder="House / flat, street and landmark" value={address} onChange={e=>{setAddress(e.target.value);clear();}} disabled={loading} aria-label="Complete doorstep address"/><input className={styles.input} type="text" inputMode="numeric" aria-label="Pincode" placeholder="e.g., 560034" value={pincode} onChange={e=>{setPincode(e.target.value.replace(/\D/g,"").slice(0,6));clear();}} disabled={loading}/><button className={styles.primaryButton} onClick={()=>void resolveZone()} disabled={loading||address.trim().length<8||pincode.length!==6}>{loading?"Verifying…":"Verify map"}</button></div>{error&&<p role="alert" className={styles.error}>{error}</p>}</section>
 {suggestions.length>0&&<section className={styles.box} aria-label="Matching map addresses"><p className={styles.copy}>Choose your doorstep from the map matches. Check the street and PIN before continuing.</p>{suggestions.map(suggestion=><button key={suggestion.placeId} type="button" className={styles.suggestion} disabled={loading} onClick={()=>void chooseAddress(suggestion)}>{suggestion.fullText}</button>)}</section>}
 {resolvedZone&&<section className={styles.box}><p className={styles.caption}>Verified service doorstep</p><div className={styles.activeZone} style={{"--zone-accent":resolvedZone.zone.color} as CSSProperties}><div className={styles.zoneRow}><div><h3 className={styles.zoneTitle}>{resolvedZone.zone.zoneName}</h3><p className={styles.caption}>{resolvedZone.address}</p><p className={styles.locationLine}>📍 {resolvedZone.assignment.area}, {resolvedZone.assignment.city} · map verified</p></div><span className={styles.badge}>{resolvedZone.zone.serviceAvailable?"✓ Available":"Not available"}</span></div></div></section>}
 {zones.length>0&&!resolvedZone&&<section className={styles.box}><p className={styles.caption}>Configured UAT service zones</p><div className={styles.zoneList}>{zones.map(zone=><div key={zone.zoneId} className={styles.zoneCard} aria-disabled="true"><div className={styles.zoneRow}><div><h4 className={styles.zoneHeading}>{zone.zoneName}</h4><p className={styles.zoneDescription}>{zone.description}</p></div><span aria-hidden="true" className={styles.dot} style={{"--zone-accent":zone.color} as CSSProperties}/></div></div>)}</div></section>}</div>;
}
