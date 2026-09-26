import { mutateCustomerAccount } from "./customer-account";

type Db=D1Database;
type Row=Record<string,unknown>;
export type AssistedPet={sourceId:string;canonicalId?:string;name:string;species?:"dog"|"cat"|"other";breed?:string;vaccinationStatus?:string};
export type AssistedCustomer={id:string;name:string;primaryPhone:string;secondaryPhone?:string;email?:string};
type AssistedDb=Db;
type Input={idempotencyKey:string;cityId?:string;customer:AssistedCustomer;pets:AssistedPet[]};
type PetInput=AssistedPet;
// Customer 360 shows staff masked contact ("+91 ••••••1234"); a masked value must never reach a booking.
const MASKED=/[•*]/;
export async function assistedCustomer(db:AssistedDb,customer:AssistedCustomer){
  const canonical=await db.prepare("SELECT primary_phone,email FROM canonical_customers WHERE id=?").bind(customer.id).first<Row>().catch(()=>null);
  const crm=canonical?null:await db.prepare("SELECT primary_phone,email FROM crm_contacts WHERE id=?").bind(customer.id).first<Row>().catch(()=>null);
  const stored=canonical??crm,phone=String(stored?.primary_phone||"").trim()||customer.primaryPhone,email=String(stored?.email||"").trim()||customer.email||"";
  if(!phone||MASKED.test(phone))throw new Response("This customer's phone number is not available to book with. Add it to the CRM record, then try again.",{status:400});
  return{customer:{...customer,primaryPhone:phone,email:email&&!MASKED.test(email)?email:undefined,secondaryPhone:customer.secondaryPhone&&!MASKED.test(customer.secondaryPhone)?customer.secondaryPhone:undefined},canonical:Boolean(canonical)};
}
/** The scheduler only reserves saved pets owned by the customer, so each pet is resolved (or saved) first. */
export async function assistedPetIds(db:AssistedDb,resolved:Awaited<ReturnType<typeof assistedCustomer>>,input:Input){
  const customer=resolved.customer,find=(pet:PetInput)=>db.prepare("SELECT id,source_pet_id FROM canonical_pets WHERE customer_id=? AND (id=? OR id=? OR source_pet_id=?) LIMIT 1").bind(customer.id,pet.canonicalId||"",pet.sourceId,pet.sourceId).first<Row>().catch(()=>null);
  if(!resolved.canonical){const now=Date.now();await db.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,'assisted_order','{}',?,?) ON CONFLICT(id) DO NOTHING").bind(customer.id,input.cityId||"blr",customer.name,customer.primaryPhone,customer.secondaryPhone??null,customer.email??null,now,now).run();}
  const ids:string[]=[],pets:PetInput[]=[];
  for(const pet of input.pets){
    let row=await find(pet);
    if(!row){await mutateCustomerAccount(db,{customerId:customer.id,action:"upsert_pet",idempotencyKey:`assisted-pet:${input.idempotencyKey}:${pet.sourceId}`,pet:{sourceId:pet.sourceId,name:pet.name,species:pet.species||"dog",breed:pet.breed,vaccinationStatus:pet.vaccinationStatus||"not_provided"}});row=await find(pet);}
    if(!row)throw new Response(`${pet.name} could not be saved to the customer's pets. Add the pet in the customer's profile, then try again.`,{status:409});
    ids.push(String(row.id));pets.push({sourceId:String(row.source_pet_id||row.id),name:pet.name,species:pet.species,breed:pet.breed,vaccinationStatus:pet.vaccinationStatus});
  }
  return{ids,pets};
}
