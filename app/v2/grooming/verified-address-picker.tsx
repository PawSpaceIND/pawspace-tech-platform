"use client";
import {useState} from "react";
import AddressPicker,{type ZoneResult} from "../../mobile-app/address-picker";
import type {ResolvedServiceCoverage} from "../../../lib/service-zone-client";

export type GroomingAddressSelection={address:string;pincode:string;coverage:ResolvedServiceCoverage;selection:'map'|'typed'};
/** The existing selector's area proof is reused; client coordinates/place IDs never become booking authority. */
export function groomingAddressSelection(zone:ZoneResult):GroomingAddressSelection|null{
 if(!zone.address?.trim()||zone.address.trim().length<8||!/^\d{6}$/.test(zone.assignment.pincode)||!zone.zone.serviceAvailable||!zone.assignment.cityId||!zone.assignment.zoneId||!['map','typed'].includes(zone.verification))return null;
 return {address:zone.address.trim(),pincode:zone.assignment.pincode,selection:zone.verification,coverage:{cityId:zone.assignment.cityId,city:zone.assignment.city,zoneId:zone.assignment.zoneId,zoneName:zone.zone.zoneName,pincode:zone.assignment.pincode,area:zone.assignment.area,zone:zone.zone}};
}
export default function GroomingVerifiedAddressPicker({disabled,onSelect,onInvalidated}:{disabled:boolean;onSelect:(selection:GroomingAddressSelection)=>void;onInvalidated:()=>void}){
 const [kind,setKind]=useState<'map'|'typed'|null>(null);
 return <fieldset disabled={disabled} style={{border:0,padding:0,margin:'16px 0',minWidth:0}}><legend>Find your service doorstep</legend><p>Choose a Google address suggestion, then review your house or flat details. Your saved address can also be used below.</p><AddressPicker restoreSaved={false} autoLocate={false} summaryLabel="Google address selected — review your doorstep" onZoneResolved={zone=>{if(disabled)return;if(!zone){setKind(null);onInvalidated();return;}const draft=groomingAddressSelection(zone);if(!draft){setKind(null);onInvalidated();return;}setKind(draft.selection);onSelect(draft);}}/>{kind&&<p role="status">{kind==='map'?'Google address selected. PawSpace checks the complete doorstep again with groomer availability before booking.':'Only the service area is matched. Choose a Google suggestion or complete the address below; doorstep verification is still required.'}</p>}</fieldset>;
}
