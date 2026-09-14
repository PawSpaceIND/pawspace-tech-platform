/** Stable evidence codes, shared by the API and partner UI. */
export const BEFORE_SERVICE = [
  {id:"pet_identity",label:"I verified the pet and booked service"},
  {id:"safety_review",label:"I reviewed behaviour, medical and handling notes with the customer"},
  {id:"safe_setup",label:"The pet and equipment are safe to begin"},
] as const;
export const AFTER_SERVICE = [
  {id:"service_delivered",label:"I completed the booked service and add-ons"},
  {id:"pet_welfare",label:"I checked the pet’s wellbeing and reported any concerns"},
  {id:"customer_handover",label:"I completed the customer handover"},
  {id:"proof_captured",label:"I captured the required before and after service photos"},
] as const;
export function checklistComplete(stage:"before"|"after",value:unknown):boolean {
  return Array.isArray(value) && (stage==="before"?BEFORE_SERVICE:AFTER_SERVICE).every(item=>value.includes(item.id));
}
export const DUTY_STATES = ["assigned","on_the_way","arrived","in_service"] as const;
export function isGroomerOnDuty(job:{serviceCode?:string;status:string}) {
  return job.serviceCode!=="dog_training" && (DUTY_STATES as readonly string[]).includes(job.status);
}
