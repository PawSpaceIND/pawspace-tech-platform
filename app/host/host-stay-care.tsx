import type{BoardingStay}from"../../lib/boarding-stay-client";
import styles from"./host.module.css";

// Same wording the Pet Sitting workspace uses for the same rule (app/sitter/sitting-workspace.tsx).
export const WITHHELD_UNTIL_ACCEPTED="Shared once the booking is paid and you have accepted it";
const careFields=[["feeding","Feeding"],["medication","Medication"],["specialInstructions","Special instructions"],["emergencyContact","Emergency contact"],["vet","Vet"],["homeAccess","Home access"]] as const;
const optionalFields=new Set<string>(["homeAccess"]);

export function petSummary(stay:BoardingStay){return stay.pets?.length?stay.pets.map(pet=>pet.name).join(", "):`${stay.pet_count} pet${stay.pet_count===1?"":"s"}`;}
function species(value:string){return value?value[0].toUpperCase()+value.slice(1):"Species not provided";}

/** Who is coming and the customer's care plan, for a host deciding on or running a Boarding stay. */
export default function HostStayCare({stay}:{stay:BoardingStay}){
 const pets=stay.pets??[],care=stay.carePlan??null,plan=care?.plan??{},withheld=care?.withheldUntilAccepted??[],extras=care?.requestedExtras??[];
 const text=(key:string)=>typeof plan[key]==="string"&&String(plan[key]).trim()?String(plan[key]):withheld.includes(key)?WITHHELD_UNTIL_ACCEPTED:"Not provided";
 return <div className={styles.careNotes} role="region" aria-label="Pets and care plan">
  <strong>Pets coming</strong>
  {pets.length?pets.map((pet,index)=><span key={`${pet.name}:${index}`}>{pet.name} · {species(pet.species)} · {pet.breed||"Breed not provided"}</span>):<span>{petSummary(stay)} · pet details not available</span>}
  <strong>Care plan</strong>
  {care?<dl>{careFields.filter(([key])=>!optionalFields.has(key)||key in plan||withheld.includes(key)).map(([key,label])=><div key={key}><dt>{label}</dt><dd style={{whiteSpace:"pre-line"}}>{text(key)}</dd></div>)}</dl>:<span>The customer has not shared the care plan yet.</span>}
  <strong>Requested extras</strong>
  {extras.length?<><div className={styles.badges}>{extras.map(item=><span key={item}>{item}</span>)}</div><span>Requested by the customer, subject to your agreement.</span></>:<span>No extras requested.</span>}
 </div>;
}
