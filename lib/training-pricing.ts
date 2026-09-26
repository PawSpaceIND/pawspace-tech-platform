/**
 * Dog Training price for the number of dogs on one programme. Founder decision, 26 Sep 2026: every dog
 * after the first adds a share of the plan price (60% unless the package says otherwise), because each
 * extra dog adds an hour of trainer time (45 min training + 15 min coaching) to every session. Shared by
 * the server quote and the booking screens so the price a customer sees is the price the server charges.
 */
export const DEFAULT_EXTRA_PET_PERCENT=60;
export function trainingPriceForPets(planPrice:number,petCount:number,extraPetPercent:number=DEFAULT_EXTRA_PET_PERCENT){
 const price=Number(planPrice),pets=Math.max(1,Math.floor(Number(petCount)||1)),percent=Number(extraPetPercent);
 const share=Number.isFinite(percent)&&percent>=0?percent:DEFAULT_EXTRA_PET_PERCENT;
 return Math.round(price*(1+share/100*(pets-1)));
}
