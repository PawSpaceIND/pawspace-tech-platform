export type BoardingRequirements={medicationRequired?:boolean;noResidentPets?:boolean;oneFamilyOnly?:boolean};
type Host={medicationSupport:boolean;residentPets:string;oneFamilyOnly:boolean};
export function boardingRequirements(needs:readonly string[]):BoardingRequirements{return{medicationRequired:needs.includes('Medication'),noResidentPets:needs.includes('No resident pets'),oneFamilyOnly:needs.includes('One family only')};}
export function hostMeetsRequirements(host:Host,requirements:BoardingRequirements={}){
 return(!requirements.medicationRequired||host.medicationSupport===true)&&(!requirements.oneFamilyOnly||host.oneFamilyOnly===true)&&(!requirements.noResidentPets||host.residentPets.trim().toLowerCase()==='none');
}
export function requireBoardingRequirements(value:unknown):BoardingRequirements{
 if(value==null)return{};
 if(typeof value!=='object'||Array.isArray(value))throw new Response('Invalid Boarding requirements.',{status:400});
 const source=value as Record<string,unknown>,out:BoardingRequirements={};
 for(const key of ['medicationRequired','noResidentPets','oneFamilyOnly']as const){if(source[key]!==undefined&&typeof source[key]!=='boolean')throw new Response('Boarding requirements must be true or false.',{status:400});out[key]=source[key]===true;}
 return out;
}
