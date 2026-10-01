import type {ReactNode} from "react";
import type {TrainingPackage} from "../../lib/training-commercial-client";
import {groupTrainingPlans} from "./training-family-map";
import styles from "./training-family-choices.module.css";
export default function TrainingFamilyChoices({plans,selectedCode,renderChoice}:{plans:TrainingPackage[];selectedCode:string;renderChoice:(plan:TrainingPackage)=>ReactNode}) {
 const {meet,families,other}=groupTrainingPlans(plans);
 const selected=plans.find(plan=>plan.package_code===selectedCode);
 return <div className={styles.presentation}>
  {selected&&<p className={styles.selected} role="status">Selected programme: <strong>{selected.name}</strong></p>}
  {meet.length>0&&<section aria-label="Trainer introductions" className={styles.introduction}><h3>Meet &amp; Greet</h3><div className={styles.options}>{meet.map(renderChoice)}</div></section>}
  <div className={styles.families}>{families.map(family=>{
   const chosen=family.plans.find(plan=>plan.package_code===selectedCode);
   return <details key={family.id} className={styles.family} open={Boolean(chosen)} data-selected={Boolean(chosen)}>
    <summary><strong>{family.label}</strong><span>{family.description}</span><small>{chosen?`Selected: ${chosen.name}`:`${family.plans.length} available ${family.plans.length===1?"programme":"programmes"}`}</small></summary>
    <div className={styles.options}>{family.plans.length?family.plans.map(renderChoice):<p>No programme is currently available in this family.</p>}</div>
   </details>;
  })}</div>
  {other.length>0&&<details className={styles.family} open={other.some(plan=>plan.package_code===selectedCode)}><summary><strong>Other available programmes</strong><span>More options from the current catalogue</span></summary><div className={styles.options}>{other.map(renderChoice)}</div></details>}
 </div>;
}
