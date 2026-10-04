"use client";

import type {CSSProperties} from "react";

type Kind="feeding"|"medication"|"specialInstructions";
const choices:Record<Kind,Array<{label:string;details:boolean}>>={
 feeding:[{label:"Owner-provided food",details:true}],
 medication:[{label:"No medication or allergies reported",details:false},{label:"Medication or allergy instructions",details:true}],
 specialInstructions:[{label:"No additional care instructions",details:false}],
};
const control:CSSProperties={width:"100%",minHeight:44,padding:10,border:"1px solid var(--paw-muted)",borderRadius:"calc(8px * var(--paw-radius-scale))",fontSize:16};

/** Options remain ordinary care-plan text, preserving the existing saved-plan API. */
export default function StayCareChoice({kind,title,value,onChange,disabled=false}:{kind:Kind;title:string;value:string;onChange:(value:string)=>void;disabled?:boolean}){
 const options=choices[kind],selected=options.find(option=>value===option.label||value.startsWith(`${option.label}\n`));
 const selection=selected?.label||(value?"custom":""),details=selected?value.slice(selected.label.length).replace(/^\n/,""):value;
 const writeDetails=(next:string)=>onChange(selected?`${selected.label}${next?`\n${next}`:""}`:next);
 const choose=(next:string)=>{
  const option=options.find(item=>item.label===next);
  onChange(option?`${option.label}${option.details&&details?`\n${details}`:""}`:next==="custom"?details:"");
 };
 return <label style={{display:"grid",gap:6}}><span>{title}</span>
  <select aria-label={`${title} option`} value={selection} disabled={disabled} onChange={event=>choose(event.target.value)} style={control}>
   <option value="">Choose an option</option>{options.map(option=><option key={option.label} value={option.label}>{option.label}</option>)}<option value="custom">Custom instructions</option>
  </select>
  {(!selected||selected.details)&&<textarea aria-label={`${title} details`} value={details} disabled={disabled} onChange={event=>writeDetails(event.target.value)} placeholder={kind==="feeding"?"Food, portions and feeding times":kind==="medication"?"Your vet's instructions, or allergy details":"Your pet's care needs"} style={{...control,minHeight:72}}/>}
 </label>;
}
