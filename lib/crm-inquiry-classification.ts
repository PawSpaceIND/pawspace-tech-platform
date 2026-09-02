export const CRM_INQUIRY_CATEGORIES=[
 "grooming",
 "training",
 "dog_walking",
 "pet_sitting",
 "pet_boarding",
 "pet_taxi",
 "pet_relocation",
 "pet_funeral_memorial",
 "pet_food",
 "subscription_membership",
]as const;
export type CrmInquiryCategory=(typeof CRM_INQUIRY_CATEGORIES)[number];

export const CRM_INQUIRY_QUEUES:Record<CrmInquiryCategory,string>={
 grooming:"sales-grooming",
 training:"sales-training",
 dog_walking:"ops-walking",
 pet_sitting:"ops-sitting",
 pet_boarding:"ops-boarding",
 pet_taxi:"ops-taxi",
 pet_relocation:"cx-relocation",
 pet_funeral_memorial:"cx-sensitive-care",
 pet_food:"sales-food",
 subscription_membership:"sales-subscriptions",
};

const text=(value:unknown)=>String(value??"").trim().toLowerCase();
const contains=(value:string,terms:string[])=>terms.some(term=>value.includes(term));

export function classifyCrmInquiry(input:{service?:unknown;message?:unknown}):CrmInquiryCategory{
 const value=`${text(input.service)} ${text(input.message)}`;
 if(contains(value,["subscription","membership","renewal","package plan"]))return"subscription_membership";
 if(contains(value,["relocation","move pet","intercity","international pet"]))return"pet_relocation";
 if(contains(value,["funeral","memorial","cremation","last rites","passed away"]))return"pet_funeral_memorial";
 if(contains(value,["boarding","boarder","overnight stay","home boarding"]))return"pet_boarding";
 if(contains(value,["sitting","pet sitter","home sitting","sitter"]))return"pet_sitting";
 if(contains(value,["taxi","pet cab","pet transport","pickup drop"]))return"pet_taxi";
 if(contains(value,["walking","dog walk","walker"]))return"dog_walking";
 if(contains(value,["training","trainer","behaviour","behavior","obedience"]))return"training";
 if(contains(value,["food","meal","fresh food","diet plan"]))return"pet_food";
 return"grooming";
}

export function queueForCrmInquiry(category:CrmInquiryCategory){return CRM_INQUIRY_QUEUES[category];}

export type GroomingRecommendationInput={species?:unknown;size?:unknown;coat?:unknown;lastGroomingDays?:unknown;shedding?:unknown;skinSensitivity?:unknown;matting?:unknown;requestedService?:unknown};
export type GroomingRecommendation={packageCode:"bath_hygiene"|"full_grooming"|"deshedding_full_grooming"|"sensitive_skin_assisted";label:string;reason:string[];requiresHumanReview:boolean};

export function recommendGroomingPackage(input:GroomingRecommendationInput):GroomingRecommendation{
 const species=text(input.species)||"dog",size=text(input.size),coat=text(input.coat),requested=text(input.requestedService),days=Number(input.lastGroomingDays||0),shedding=["high","heavy","severe","yes","true"].includes(text(input.shedding)),sensitive=["yes","true","sensitive","allergy","allergies"].includes(text(input.skinSensitivity)),matted=["yes","true","matted","heavy","severe"].includes(text(input.matting));
 const reason:string[]=[];
 if(species!=="dog"&&species!=="cat")return{packageCode:"sensitive_skin_assisted",label:"Assisted grooming assessment",reason:["Species or pet profile requires an operator-confirmed grooming plan."],requiresHumanReview:true};
 if(sensitive||matted){if(sensitive)reason.push("Skin sensitivity/allergy was reported.");if(matted)reason.push("Matting was reported and needs groomer assessment.");return{packageCode:"sensitive_skin_assisted",label:"Assisted grooming assessment",reason,requiresHumanReview:true};}
 if(shedding||contains(coat,["double","long","thick","husky","golden","german shepherd"])){reason.push("Coat/shedding profile benefits from de-shedding plus full grooming.");return{packageCode:"deshedding_full_grooming",label:"De-shedding + full grooming",reason,requiresHumanReview:false};}
 if(days>=30||contains(requested,["haircut","trim","full","nail","ear cleaning"])){if(days>=30)reason.push("Last grooming was 30+ days ago.");if(requested)reason.push("Requested services indicate a complete grooming session.");return{packageCode:"full_grooming",label:"Full grooming",reason,requiresHumanReview:false};}
 if(["small","medium","large","xl"].includes(size))reason.push(`Pet size recorded as ${size}.`);reason.push("Routine hygiene need without a full-grooming trigger.");return{packageCode:"bath_hygiene",label:"Bath + hygiene grooming",reason,requiresHumanReview:false};
}
