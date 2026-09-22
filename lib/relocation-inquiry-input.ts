/**
 * Shared Relocation inquiry input contract — used by the customer form (/relocation, /v2/relocation),
 * the API route and the governance engine so every layer applies the SAME normalisation and refusals.
 *
 * Why this exists (V2-045): the customer form used to carry hidden hardcoded values for the pet's age,
 * size and the destination COUNTRY ("United Arab Emirates"). A domestic Road move Bengaluru → Pune was
 * therefore stored as "Pune, United Arab Emirates" and staff triaged a wrong case. Country, age and size
 * are now explicit, required, visible fields; nothing is defaulted silently. A missing or invalid value
 * is refused with a field-level message before any case row is written.
 */
export const RELOCATION_TRAVEL_MODES=["air","road","sea"] as const;
export type RelocationTravelMode=typeof RELOCATION_TRAVEL_MODES[number];
export const RELOCATION_SIZE_CLASSES=["small","medium","large","giant"] as const;
export type RelocationSizeClass=typeof RELOCATION_SIZE_CLASSES[number];
export const RELOCATION_MAX_AGE_YEARS=30;
export const RELOCATION_MAX_NAME_LENGTH=80;
export const RELOCATION_MAX_PLACE_LENGTH=120;
/** Suggestions only (datalist). Any properly spelled country name is accepted; the server never substitutes one. */
export const RELOCATION_COUNTRY_SUGGESTIONS=["India","United Arab Emirates","Singapore","United Kingdom","United States","Germany","Australia","Canada","Netherlands","France","Sri Lanka","Nepal"] as const;
export const RELOCATION_DEFAULT_CRATE_REQUIREMENT="assessment_required";

export type RelocationInquiryInput={
 customerId:string;petName:string;breed:string;ageYears:number;sizeClass:RelocationSizeClass;travelMode:RelocationTravelMode;
 originCountry:string;originCity:string;destinationCountry:string;destinationCity:string;targetTravelDate:string;crateRequirement:string;
};
export type RelocationInquiryField=keyof RelocationInquiryInput;
export type RelocationInquiryErrors=Partial<Record<RelocationInquiryField,string>>;
export type RelocationKind="domestic"|"international";
export type RelocationInquiryValidation=
 |{ok:true;value:RelocationInquiryInput;kind:RelocationKind;errors:Record<string,never>}
 |{ok:false;value:null;kind:null;errors:RelocationInquiryErrors;message:string};

const text=(value:unknown)=>String(value??"").replace(/\s+/g," ").trim();
// Letters from any script, spaces, apostrophes, dots, brackets and hyphens: "United Arab Emirates", "Côte d'Ivoire", "Korea (South)".
const COUNTRY_RE=/^\p{L}[\p{L}\s'’.()-]{1,79}$/u;
const isMissing=(value:unknown)=>value===undefined||value===null||text(value)==="";

/** Case-insensitive country comparison: same country = domestic move, otherwise international. */
export function relocationKindFor(originCountry:string,destinationCountry:string):RelocationKind{
 return text(originCountry).toLowerCase()===text(destinationCountry).toLowerCase()?"domestic":"international";
}

/**
 * Parse an explicit age. `""`, `null` and `undefined` are MISSING (refused); `0` and `"0"` are a valid explicit
 * answer for a pet under one year. Decimals are kept to one place ("0.5" → 0.5).
 */
export function parseRelocationAgeYears(value:unknown):{ok:true;years:number}|{ok:false;error:string}{
 if(isMissing(value))return{ok:false,error:"Enter your pet's age in years (use 0 for under one year)."};
 const years=typeof value==="number"?value:Number(text(value));
 if(!Number.isFinite(years)||years<0||years>RELOCATION_MAX_AGE_YEARS)return{ok:false,error:`Pet age must be a number between 0 and ${RELOCATION_MAX_AGE_YEARS} years.`};
 return{ok:true,years:Math.round(years*10)/10};
}

export function validateRelocationInquiry(raw:Record<string,unknown>,now=Date.now()):RelocationInquiryValidation{
 const errors:RelocationInquiryErrors={};
 const customerId=text(raw.customerId);if(!customerId)errors.customerId="Sign in as a customer to create a relocation inquiry.";
 const petName=text(raw.petName);if(!petName)errors.petName="Enter your pet's name.";else if(petName.length>RELOCATION_MAX_NAME_LENGTH)errors.petName=`Pet name must be ${RELOCATION_MAX_NAME_LENGTH} characters or fewer.`;
 const breed=text(raw.breed);if(!breed)errors.breed="Enter the breed (for example Indie, Labrador or Persian).";else if(breed.length>RELOCATION_MAX_NAME_LENGTH)errors.breed=`Breed must be ${RELOCATION_MAX_NAME_LENGTH} characters or fewer.`;
 const age=parseRelocationAgeYears(raw.ageYears);if(!age.ok)errors.ageYears=age.error;
 const sizeClass=text(raw.sizeClass).toLowerCase();
 if(!sizeClass)errors.sizeClass="Choose your pet's size.";else if(!(RELOCATION_SIZE_CLASSES as readonly string[]).includes(sizeClass))errors.sizeClass="Choose small, medium, large or giant.";
 const travelMode=text(raw.travelMode).toLowerCase();
 if(!(RELOCATION_TRAVEL_MODES as readonly string[]).includes(travelMode))errors.travelMode="Choose air, road or sea.";
 const originCountry=text(raw.originCountry);
 if(!originCountry)errors.originCountry="Enter the origin country.";else if(!COUNTRY_RE.test(originCountry))errors.originCountry="Enter a valid origin country name.";
 const destinationCountry=text(raw.destinationCountry);
 if(!destinationCountry)errors.destinationCountry="Enter the destination country.";else if(!COUNTRY_RE.test(destinationCountry))errors.destinationCountry="Enter a valid destination country name.";
 const originCity=text(raw.originCity);if(!originCity)errors.originCity="Enter the origin city.";else if(originCity.length>RELOCATION_MAX_PLACE_LENGTH)errors.originCity=`Origin city must be ${RELOCATION_MAX_PLACE_LENGTH} characters or fewer.`;
 const destinationCity=text(raw.destinationCity);if(!destinationCity)errors.destinationCity="Enter the destination city.";else if(destinationCity.length>RELOCATION_MAX_PLACE_LENGTH)errors.destinationCity=`Destination city must be ${RELOCATION_MAX_PLACE_LENGTH} characters or fewer.`;
 const targetTravelDate=text(raw.targetTravelDate);
 if(!targetTravelDate)errors.targetTravelDate="Choose a target travel date.";
 else{const at=new Date(targetTravelDate).getTime();if(!Number.isFinite(at))errors.targetTravelDate="Enter the target travel date as YYYY-MM-DD.";else if(at<=now)errors.targetTravelDate="Relocation target date must be in the future.";}
 const crateRequirement=text(raw.crateRequirement)||RELOCATION_DEFAULT_CRATE_REQUIREMENT;
 if(crateRequirement.length>200)errors.crateRequirement="Crate requirement must be 200 characters or fewer.";
 // A Road move to a different country is unusual but not refused here: transport eligibility is an Operations
 // decision, not a form rule. The form shows a non-blocking hint so a mistyped country is noticed before submit.
 const keys=Object.keys(errors) as RelocationInquiryField[];
 if(keys.length)return{ok:false,value:null,kind:null,errors,message:errors[keys[0]] as string};
 return{ok:true,errors:{},kind:relocationKindFor(originCountry,destinationCountry),value:{customerId,petName,breed,ageYears:(age as {ok:true;years:number}).years,sizeClass:sizeClass as RelocationSizeClass,travelMode:travelMode as RelocationTravelMode,originCountry,originCity,destinationCountry,destinationCity,targetTravelDate,crateRequirement}};
}

/** Server-side guard: refuses with a 400 Response carrying the first field message. */
export function normalizeRelocationInquiryInput(raw:Record<string,unknown>,now=Date.now()):RelocationInquiryInput{
 const result=validateRelocationInquiry(raw,now);
 if(!result.ok)throw new Response(result.message,{status:400});
 return result.value;
}
