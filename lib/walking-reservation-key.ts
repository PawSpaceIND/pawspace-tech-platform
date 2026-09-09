import type {WalkingOwnerCare} from "./walking-owner-care";
export async function walkingReservationKey(input:{customerId:string;petId:string;address:string;pincode:string;packageCode:string;scheduledStart:string;scheduledEnd:string;walkCount:number;weekdays:number[];ownerCare:WalkingOwnerCare}) {
 const normalized=[input.customerId,input.petId,input.address.trim(),input.pincode.trim(),input.packageCode,input.scheduledStart,input.scheduledEnd,input.walkCount,[...input.weekdays].sort((a,b)=>a-b),input.ownerCare.instructions.trim(),input.ownerCare.handoverPreference];
 const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(normalized)));
 return `walking-${Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("")}`;
}
