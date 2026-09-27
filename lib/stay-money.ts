/**
 * Rupees on the Boarding and Pet Sitting booking screens. Whole amounts keep their short form (₹3,495); anything with
 * paise is shown to the paisa - the 50/50 split of a ₹3,495 stay read "₹1,747.5" on round-2 staging (BRD-05) and is
 * "₹1,747.50" now. Used only at the stay call sites; the shared formatters other services use are unchanged.
 */
export function stayMoney(amount:number){
 return new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",minimumFractionDigits:Number.isInteger(amount)?0:2,maximumFractionDigits:2}).format(amount);
}
