/** Presentation groups only; package records and commercial values are never modified. */
export const TRAINING_FAMILIES = [
 {id:"puppy",label:"Puppy",description:"Puppy foundations",codes:["training-4-puppy"]},
 {id:"obedience",label:"Obedience",description:"Basic through advanced programmes",codes:["training-8-basic","training-12-advanced","training-16-pro"]},
 {id:"behavioral",label:"Behavioral",description:"Assessment-led · starts with an assessment",codes:["training-2-starter"]},
 {id:"leash",label:"Leash",description:"Leash-focused programmes",codes:["training-8-leash","training-12-leash"]},
] as const;
export function groupTrainingPlans<T extends {package_code:string;meet_and_greet:number}>(plans:readonly T[]) {
 const meet = plans.filter(plan=>Boolean(plan.meet_and_greet));
 const programmes = plans.filter(plan=>!plan.meet_and_greet);
 const families = TRAINING_FAMILIES.map(family=>({...family,plans:programmes.filter(plan=>(family.codes as readonly string[]).includes(plan.package_code))}));
 const known = new Set<string>(TRAINING_FAMILIES.flatMap(family=>[...family.codes]));
 const other = programmes.filter(plan=>!known.has(plan.package_code));
 return {meet,families,other};
}
