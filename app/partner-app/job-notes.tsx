import styles from "./partner.module.css";
/** Optional operational notes shared by Grooming and Training job projections. */
export default function PartnerJobNotes({safetyRequirements=[],addOns=[]}:{safetyRequirements?:string[];addOns?:string[]}){
 const label=(value:string)=>value.replaceAll("_"," ");
 /* pricing.requirements carries codes shaped `<category>:<detail>`, e.g. `grooming_safety:friendly`.
  * Replacing underscores alone left the colon-joined code on screen verbatim (LP-D06); the desktop
  * partner feed already strips the known prefix, so this mirrors it and humanises an unknown category. */
 const CATEGORY_LABELS:Record<string,string>={grooming_safety:"Safety",grooming_special:"Special instructions"};
 const requirementLabel=(value:string)=>{const separator=value.indexOf(":");if(separator<=0)return label(value);const category=value.slice(0,separator),detail=label(value.slice(separator+1)).trim();const known=CATEGORY_LABELS[category]??label(category);return detail?`${known}: ${detail}`:known;};
 return <>{safetyRequirements.length>0&&<section className={styles.notice} aria-label="Handling requirements"><b>Handling requirements</b><ul>{safetyRequirements.map(item=><li key={item}>{requirementLabel(item)}</li>)}</ul></section>}{addOns.length>0&&<section className={styles.proof} aria-label="Add-ons booked"><b>Add-ons booked</b><span>{addOns.map(label).join(", ")}</span></section>}</>;
}
