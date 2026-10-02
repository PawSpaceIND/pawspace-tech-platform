import type {ReactNode} from "react";
import type {TrainingPackage} from "../../lib/training-commercial-client";
import {groupTrainingPlans} from "./training-family-map";
import styles from "./training-family-choices.module.css";
export default function TrainingFamilyChoices({plans,selectedCode,renderChoice}:{plans:TrainingPackage[];selectedCode:string;renderChoice:(plan:TrainingPackage)=>ReactNode}) {
 const {meet,families,other}=groupTrainingPlans(plans);
 const selected=plans.find(plan=>plan.package_code===selectedCode);
 const choice=(plan:TrainingPackage)=><div key={plan.package_code} className={styles.plan}>{renderChoice(plan)}<p className={styles.inclusions}>{plan.sessions} {plan.sessions===1?"session":"sessions"} · {Number.isFinite(plan.direct_minutes_per_pet+plan.coaching_minutes_per_pet)?`${plan.direct_minutes_per_pet+plan.coaching_minutes_per_pet} minutes per dog each session`:"Session duration unavailable"} · use within {plan.validity_days} days</p></div>;
 return <div className={styles.presentation}>
  {selected&&<p className={styles.selected} role="status">Selected programme: <strong>{selected.name}</strong><span className={styles.selectedDetail}>Review all dates in your session calendar below. Changing a programme checks its price and availability again.</span></p>}
  {meet.length>0&&<section aria-label="Trainer introductions" className={styles.introduction}><h3>Meet &amp; Greet</h3><div className={styles.options}>{meet.map(choice)}</div></section>}
  <p className={styles.guide}>Start with your goal: puppy foundations, everyday obedience, an assessment, or leash skills. Your trainer can help refine the focus; outcomes depend on your dog and practice.</p><div className={styles.families}>{families.map(family=>{
   const chosen=family.plans.find(plan=>plan.package_code===selectedCode);
   return <details key={family.id} className={styles.family} open={Boolean(chosen)} data-selected={Boolean(chosen)}>
    <summary><strong>{family.label}</strong><span>{family.description}</span><small>{chosen?`Selected: ${chosen.name}`:`${family.plans.length} available ${family.plans.length===1?"programme":"programmes"}`}</small></summary>
    <div className={styles.options}>{family.plans.length?family.plans.map(choice):<p>No programme is currently available in this family.</p>}</div>
   </details>;
  })}</div>
  {other.length>0&&<details className={styles.family} open={other.some(plan=>plan.package_code===selectedCode)}><summary><strong>Other available programmes</strong><span>More options from the current catalogue</span></summary><div className={styles.options}>{other.map(choice)}</div></details>}
 </div>;
}
