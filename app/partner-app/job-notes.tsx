import styles from "./partner.module.css";
/** Optional operational notes shared by Grooming and Training job projections. */
export default function PartnerJobNotes({safetyRequirements=[],addOns=[]}:{safetyRequirements?:string[];addOns?:string[]}){
 const label=(value:string)=>value.replaceAll("_"," ");
 return <>{safetyRequirements.length>0&&<section className={styles.notice} aria-label="Handling requirements"><b>Handling requirements</b><ul>{safetyRequirements.map(item=><li key={item}>{label(item)}</li>)}</ul></section>}{addOns.length>0&&<section className={styles.proof} aria-label="Add-ons booked"><b>Add-ons booked</b><span>{addOns.map(label).join(", ")}</span></section>}</>;
}
