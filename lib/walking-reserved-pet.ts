type Row=Record<string,unknown>;
/** Booking creation reads the already-reserved, owned dog; it cannot create or edit a pet. */
export async function resolveWalkingReservedPet(db:D1Database,customerId:string,submitted:{sourceId:string;species?:string},reservations:Row[]) {
 if(!submitted||typeof submitted.sourceId!=="string"||!submitted.sourceId.trim()||(submitted.species!==undefined&&submitted.species!=="dog"))throw new Response("Dog Walking requires one saved dog",{status:400});
 let petId="";
 for(const reservation of reservations){let ids:unknown;try{ids=JSON.parse(String(reservation.pet_ids_json))}catch{throw new Response("The reserved dog could not be verified",{status:409})}
 if(!Array.isArray(ids)||ids.length!==1||typeof ids[0]!=="string"||!ids[0]||(petId&&petId!==ids[0]))throw new Response("Every walk must reserve the same single dog",{status:409});petId=ids[0];}
 if(!petId)throw new Response("A dog reservation is required before booking",{status:409});
 const pet=await db.prepare("SELECT id,customer_id,source_pet_id,name,species FROM canonical_pets WHERE id=? AND customer_id=?").bind(petId,customerId).first<Row>();
 if(!pet)throw new Response("The reserved pet is not available on your account",{status:403});
 if(pet.species!=="dog")throw new Response("Dog Walking is available only for dogs",{status:400});
 if(submitted.sourceId!==String(pet.id)&&submitted.sourceId!==String(pet.source_pet_id||pet.id))throw new Response("The selected dog does not match the reservation",{status:409});
 return pet;
}
