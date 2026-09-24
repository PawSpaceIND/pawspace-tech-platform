"use client";
import{useEffect,useRef,useState}from"react";
import{resolveServiceCoverage}from"../../lib/service-zone-client";
import{resolveAddress,searchAddresses,type AddressSuggestion}from"../../lib/address-autocomplete-client";
import{createAddressSessionToken}from"../../lib/grooming-booking-calendar";
import{serviceAddressPincodes}from"../../lib/service-address-pincode";
import{serviceAddressConflict}from"../../lib/service-address-consistency";
import{validGpsCoordinates}from"../../lib/gps-telemetry-policy";
import styles from"./address-picker.module.css";
import type{CSSProperties}from"react";
export type Zone={zoneId:string;zoneName:string;description:string;color:string;serviceAvailable:boolean};
export type ZoneResult={zone:Zone;assignment:{pincode:string;zoneId:string;cityId:string;city:string;area:string};address:string;addressLine1:string;addressLine2:string;latitude:number;longitude:number;placeId:string;verification:"map"|"typed"};
export const SELECTED_SERVICE_ADDRESS_KEY="pawspace.selected-service-address";
function remember(result:ZoneResult|null){try{result?sessionStorage.setItem(SELECTED_SERVICE_ADDRESS_KEY,JSON.stringify(result)):sessionStorage.removeItem(SELECTED_SERVICE_ADDRESS_KEY)}catch{}}
function pinFrom(value:string){return serviceAddressPincodes(value).at(-1)||""}
const AREA_PIN:Array<[RegExp,string]>=[
  [/jayanagar/i,"560041"],
  [/koramangala/i,"560034"],
  [/\bhsr\b|hsr layout/i,"560102"],
  [/\bbtm\b/i,"560068"],
  [/jp nagar/i,"560078"],
  [/indiranagar/i,"560038"],
  [/whitefield/i,"560066"],
];
function inferPin(value:string){const direct=pinFrom(value);if(direct)return direct;const hit=AREA_PIN.find(([re])=>re.test(value));return hit?.[1]||""}
export default function AddressPicker({onZoneResolved,restoreSaved=true,summaryLabel}:{onZoneResolved?:(zone:ZoneResult|null)=>void;restoreSaved?:boolean;summaryLabel?:string}){
 const[line1,setLine1]=useState(""),[line2,setLine2]=useState(""),[suggestions,setSuggestions]=useState<AddressSuggestion[]>([]),[resolvedZone,setResolvedZone]=useState<ZoneResult|null>(null),[zones,setZones]=useState<Zone[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState("");
 const session=useRef(createAddressSessionToken()),generation=useRef(0),line2Ref=useRef("");
 async function applyCoverage(addressText:string,pincode:string,place?:{latitude:number;longitude:number;placeId:string;verification:"map"|"typed"}){
  const request=generation.current,coverage=await resolveServiceCoverage(pincode);if(request!==generation.current)return;
  const apartment=line2Ref.current.trim();
  const conflict=serviceAddressConflict([addressText,apartment].filter(Boolean).join(", "),coverage.city,coverage.pincode);if(conflict)throw new Error(conflict);
  const zone:Zone={zoneId:coverage.zone.zoneId,zoneName:coverage.zone.zoneName,description:coverage.zone.description,color:coverage.zone.color,serviceAvailable:coverage.zone.serviceAvailable};
  const result:ZoneResult={zone,assignment:{pincode:coverage.pincode,zoneId:coverage.zoneId,cityId:coverage.cityId,city:coverage.city,area:coverage.area},address:[addressText,apartment].filter(Boolean).join(", "),addressLine1:addressText,addressLine2:apartment,latitude:place?.latitude||12.925,longitude:place?.longitude||77.5938,placeId:place?.placeId||`typed:${pincode}`,verification:place?.verification||"typed"};
  setLine1(addressText);setSuggestions([]);setResolvedZone(result);remember(result);onZoneResolved?.(result);
 }
 async function verifyTyped(source:string){
  const pincode=inferPin(`${source} ${line2Ref.current}`);
  if(!pincode)throw new Error("Add a 6-digit PIN, or a Bengaluru area name such as Jayanagar, so we can verify the service zone.");
  await applyCoverage(source.trim(),pincode);
 }
 useEffect(()=>{void fetch("/api/service-zone?action=list").then(r=>r.json()).then((b:{data?:Zone[]})=>b.data&&setZones(b.data)).catch(()=>{});try{const raw=restoreSaved?sessionStorage.getItem(SELECTED_SERVICE_ADDRESS_KEY):null;if(raw){const saved=JSON.parse(raw)as ZoneResult;if(typeof saved?.addressLine1==="string"){remember(null);queueMicrotask(()=>{setLine1(saved.addressLine1);line2Ref.current=typeof saved.addressLine2==="string"?saved.addressLine2:"";setLine2(line2Ref.current);setResolvedZone(null);onZoneResolved?.(null)})}}}catch{}}// eslint-disable-next-line react-hooks/exhaustive-deps
 ,[]);
 useEffect(()=>{function onVerify(){if(resolvedZone||loading)return;if(line1.trim().length<8){setError("Enter the street and area, then tap Verify service address.");return;}setLoading(true);setError("");void verifyTyped(line1).catch(e=>setError(e instanceof Error?e.message:"Could not verify this address")).finally(()=>setLoading(false));}window.addEventListener("pawspace-verify-address",onVerify);return()=>window.removeEventListener("pawspace-verify-address",onVerify);},[line1,line2,resolvedZone,loading]);
 useEffect(()=>{if(resolvedZone||line1.trim().length<3)return;const request=++generation.current,timer=window.setTimeout(()=>{setLoading(true);setError("");void(async()=>{
  let result;try{result=await searchAddresses(line1.trim(),session.current);}catch(problem){if(request!==generation.current)return;if(inferPin(line1)){await verifyTyped(line1);return;}throw problem;}
  if(request!==generation.current)return;
  if(result.status!=="configured"){if(inferPin(line1)){await verifyTyped(line1);return;}throw new Error(result.error||"Google Places Autocomplete is unavailable. Add a PIN or area name and tap Verify service address.");}
  const next=result.suggestions.filter(x=>Boolean(x.placeId&&x.fullText));setSuggestions(next);if(!next.length&&inferPin(line1))await verifyTyped(line1);
 })().catch(problem=>{if(request===generation.current){setSuggestions([]);setError(problem instanceof Error?problem.message:"Unable to verify this address");}}).finally(()=>{if(request===generation.current)setLoading(false)});},250);return()=>window.clearTimeout(timer)},[line1,resolvedZone]);
 function invalidate(value:string){generation.current++;setLine1(value);setResolvedZone(null);setSuggestions([]);setError("");remember(null);onZoneResolved?.(null)}
 async function chooseAddress(suggestion:AddressSuggestion){const request=++generation.current;setLoading(true);setError("");try{const place=await resolveAddress(suggestion.placeId,session.current);if(request!==generation.current)return;if(place.status!=="configured"||!validGpsCoordinates(Number(place.latitude),Number(place.longitude))){await verifyTyped(suggestion.fullText||line1);return;}const mapped=String(place.address||suggestion.fullText).trim(),pincode=pinFrom(mapped)||inferPin(mapped)||inferPin(line1);if(!pincode)throw new Error("The selected Google address does not include a serviceable 6-digit PIN code");await applyCoverage(mapped,pincode,{latitude:Number(place.latitude),longitude:Number(place.longitude),placeId:suggestion.placeId,verification:"map"});session.current=createAddressSessionToken()}catch(e){if(request===generation.current){setResolvedZone(null);remember(null);onZoneResolved?.(null);setError(e instanceof Error?e.message:"Failed to verify this Google address")}}finally{if(request===generation.current)setLoading(false)}}
 function updateLine2(value:string){line2Ref.current=value;setLine2(value);if(!resolvedZone)return;const conflict=serviceAddressConflict([resolvedZone.addressLine1,value].join(", "),resolvedZone.assignment.city,resolvedZone.assignment.pincode);if(conflict){setResolvedZone(null);remember(null);onZoneResolved?.(null);setError(conflict);return;}const next={...resolvedZone,addressLine2:value,address:[resolvedZone.addressLine1,value.trim()].filter(Boolean).join(", ")};setResolvedZone(next);remember(next);onZoneResolved?.(next)}
 return <div className={styles.container}><section className={styles.box}><label className={styles.label} htmlFor="grooming-address-line-1">Address Line 1 <b>*</b><p className={styles.hint}>Type the street and area (example: 18th Main Road, Jayanagar 9th Block). Choose a Google suggestion if it appears, or tap Verify service address.</p></label><input id="grooming-address-line-1" className={styles.input} value={line1} required aria-required="true" autoComplete="street-address" placeholder="House / flat, street, area and city" onChange={e=>invalidate(e.target.value)} disabled={loading}/><label className={styles.label} htmlFor="grooming-address-line-2">Address Line 2 <span>(optional)</span></label><input id="grooming-address-line-2" className={styles.input} value={line2} autoComplete="address-line2" placeholder="Apartment, floor or landmark" onChange={e=>updateLine2(e.target.value)} disabled={loading}/><p><button type="button" className={styles.primaryButton||styles.input} disabled={loading||line1.trim().length<8||Boolean(resolvedZone)} onClick={()=>{setLoading(true);setError("");void verifyTyped(line1).catch(e=>setError(e instanceof Error?e.message:"Could not verify this address")).finally(()=>setLoading(false));}}>Verify service address</button></p>{loading&&<p role="status" className={styles.hint}>Checking service area…</p>}{error&&<p role="alert" className={styles.error}>{error}</p>}</section>{suggestions.length>0&&<section className={styles.box} aria-label="Google address suggestions">{suggestions.map(s=><button key={s.placeId} type="button" className={styles.suggestion} onClick={()=>void chooseAddress(s)}><b>{s.mainText}</b><span>{s.secondaryText}</span></button>)}</section>}{resolvedZone&&<section className={styles.box}><p className={styles.caption}>{resolvedZone.verification==="map"?(summaryLabel||"Verified service doorstep"):"Service area matched - doorstep not map verified"}</p><div className={styles.activeZone} style={{"--zone-accent":resolvedZone.zone.color} as CSSProperties}><div className={styles.zoneRow}><div><h3 className={styles.zoneTitle}>{resolvedZone.zone.zoneName}</h3><p className={styles.caption}>{resolvedZone.address}</p><p className={styles.locationLine}>📍 {resolvedZone.assignment.area}, {resolvedZone.assignment.city} · {resolvedZone.verification==="map"?"Google map verified":"area verified"}</p></div><span className={styles.badge}>✓ Available</span></div></div></section>}{zones.length>0&&!resolvedZone&&<section className={styles.box}><p className={styles.caption}>Configured UAT service zones</p><div className={styles.zoneList}>{zones.map(zone=><div key={zone.zoneId} className={styles.zoneCard}><div className={styles.zoneRow}><div><h4 className={styles.zoneHeading}>{zone.zoneName}</h4><p className={styles.zoneDescription}>{zone.description}</p></div></div></div>)}</div></section>}</div>
}
