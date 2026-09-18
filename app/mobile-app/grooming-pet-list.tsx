"use client";
import type { CustomerPet } from "../../lib/customer-account-client";
import { groomingPetIssue, type GroomingPetType } from "../../lib/grooming-pet-selection";
import styles from "./grooming-flow.module.css";
export default function GroomingPetList({pets,selected,type,date,onToggle}:{pets:CustomerPet[];selected:string[];type:GroomingPetType;date:string;onToggle:(id:string)=>void}) {
  return <div className={styles.petList} aria-label="Pets for this grooming visit">{pets.map(pet=>{
    const on=selected.includes(pet.id),issue=groomingPetIssue(pet,type,date);
    const detail=[pet.profile?.breed||pet.breed,pet.profile?.ageBand,pet.profile?.weightBand].filter(Boolean).join(" · ");
    return <button key={pet.id} type="button" aria-pressed={on} aria-disabled={Boolean(issue)&&!on} className={`${styles.pet} ${on?styles.selected:""}`} onClick={()=>onToggle(pet.id)}>
      <i aria-hidden="true">{pet.species==="cat"?"🐈":pet.species==="dog"?"🐕":"🐾"}</i>
      <span><b>{pet.name}</b><small>{issue||detail||"Saved pet profile"}</small></span>
      <em>{issue?"Not Eligible":on?"Selected":"Add"}</em>
    </button>;
  })}</div>;
}
