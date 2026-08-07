export type GroomingPetType="dog"|"cat"|"other";
export type GroomingOfferType="regular"|"young"|"subscription";
export type GroomingCatalogueItem={
  code:string;name:string;offerType:GroomingOfferType;eligiblePetTypes:GroomingPetType[];singlePrice:number;multiPetPrice?:number;
  sessions?:number;validityMonths?:number;servicePackageCode?:string;version:string;active:boolean;
};

export const GROOMING_CATALOGUE_VERSION="2026-08-07.v1";

export const groomingCatalogue:GroomingCatalogueItem[]=[
  {code:"dog-bath",name:"Essential Bath",offerType:"regular",eligiblePetTypes:["dog"],singlePrice:1349,multiPetPrice:1149,version:GROOMING_CATALOGUE_VERSION,active:true},
  {code:"dog-basic",name:"Bath & Basic",offerType:"regular",eligiblePetTypes:["dog"],singlePrice:1899,multiPetPrice:1649,version:GROOMING_CATALOGUE_VERSION,active:true},
  {code:"dog-makeover",name:"Complete Makeover",offerType:"regular",eligiblePetTypes:["dog"],singlePrice:2399,multiPetPrice:2149,version:GROOMING_CATALOGUE_VERSION,active:true},
  {code:"dog-trim",name:"Just Trim",offerType:"regular",eligiblePetTypes:["dog"],singlePrice:1599,multiPetPrice:1399,version:GROOMING_CATALOGUE_VERSION,active:true},
  {code:"cat-routine",name:"Routine Grooming",offerType:"regular",eligiblePetTypes:["cat"],singlePrice:1149,multiPetPrice:999,version:GROOMING_CATALOGUE_VERSION,active:true},
  {code:"cat-basic",name:"Bath & Basic",offerType:"regular",eligiblePetTypes:["cat"],singlePrice:1899,multiPetPrice:1649,version:GROOMING_CATALOGUE_VERSION,active:true},
  {code:"cat-makeover",name:"Complete Makeover",offerType:"regular",eligiblePetTypes:["cat"],singlePrice:2399,multiPetPrice:2149,version:GROOMING_CATALOGUE_VERSION,active:true},
  {code:"cat-trim",name:"Just Trim",offerType:"regular",eligiblePetTypes:["cat"],singlePrice:1599,multiPetPrice:1399,version:GROOMING_CATALOGUE_VERSION,active:true},
  {code:"young-basic",name:"Bath & Basic",offerType:"young",eligiblePetTypes:["dog","cat"],singlePrice:999,multiPetPrice:899,version:GROOMING_CATALOGUE_VERSION,active:true},
  {code:"young-makeover",name:"Complete Makeover",offerType:"young",eligiblePetTypes:["dog","cat"],singlePrice:1399,multiPetPrice:1299,version:GROOMING_CATALOGUE_VERSION,active:true},
  {code:"sub-3-dog",name:"3 sessions · Dog",offerType:"subscription",eligiblePetTypes:["dog"],singlePrice:3597,sessions:3,validityMonths:4,servicePackageCode:"dog-basic",version:GROOMING_CATALOGUE_VERSION,active:true},
  {code:"sub-3-cat",name:"3 sessions · Cat Routine",offerType:"subscription",eligiblePetTypes:["cat"],singlePrice:2999,sessions:3,validityMonths:4,servicePackageCode:"cat-routine",version:GROOMING_CATALOGUE_VERSION,active:true},
  {code:"sub-6",name:"6 sessions",offerType:"subscription",eligiblePetTypes:["dog","cat"],singlePrice:6594,sessions:6,validityMonths:8,servicePackageCode:"dog-basic",version:GROOMING_CATALOGUE_VERSION,active:true},
  {code:"sub-12",name:"12 sessions",offerType:"subscription",eligiblePetTypes:["dog","cat"],singlePrice:11988,sessions:12,validityMonths:15,servicePackageCode:"dog-basic",version:GROOMING_CATALOGUE_VERSION,active:true},
  {code:"sub-trim",name:"3 Just Trim sessions",offerType:"subscription",eligiblePetTypes:["dog","cat"],singlePrice:4197,sessions:3,validityMonths:4,servicePackageCode:"dog-trim",version:GROOMING_CATALOGUE_VERSION,active:true},
];

export type GroomingGovernanceInput={
  packageCode:string;packageName?:string;pets:Array<{species?:GroomingPetType}>;submittedTotal:number;submittedAmountDueNow:number;
  paymentMode:string;existingSubscriptionId?:string;
};
export type GroomingGovernanceResult={
  packageCode:string;packageName:string;catalogueVersion:string;offerType:GroomingOfferType;petCount:number;totalAmount:number;amountDueNow:number;
  subscriptionPlan?:{planCode:string;sessions:number;validityMonths:number;reserveSessions:number;servicePackageCode:string};
};

export function governGroomingBooking(input:GroomingGovernanceInput):GroomingGovernanceResult{
  const item=groomingCatalogue.find(row=>row.active&&row.code===input.packageCode);
  if(!item)throw new Error("Grooming package is not present in the governed catalogue");
  const petCount=input.pets.length;
  if(petCount<1||petCount>4)throw new Error("Grooming supports between 1 and 4 pets per booking");
  for(const pet of input.pets){const species=pet.species??"other";if(!item.eligiblePetTypes.includes(species))throw new Error(`${item.name} is not eligible for ${species}`);}
  const totalAmount=item.offerType==="subscription"?item.singlePrice:(petCount===1?item.singlePrice:(item.multiPetPrice??item.singlePrice)*petCount);
  if(Math.round(input.submittedTotal)!==Math.round(totalAmount))throw new Error(`Submitted Grooming total does not match catalogue version ${item.version}`);
  const amountDueNow=input.paymentMode==="prepaid"?totalAmount:0;
  if(Math.round(input.submittedAmountDueNow)!==Math.round(amountDueNow))throw new Error("Submitted amount due now does not match the governed payment mode");
  if(item.offerType==="subscription"&&input.existingSubscriptionId)throw new Error("A subscription-plan purchase cannot also consume an existing subscription");
  if(item.offerType==="subscription"&&petCount>Number(item.sessions||0))throw new Error("The selected subscription does not contain enough sessions for all selected pets");
  return {
    packageCode:item.code,packageName:item.name,catalogueVersion:item.version,offerType:item.offerType,petCount,totalAmount,amountDueNow,
    subscriptionPlan:item.offerType==="subscription"?{planCode:item.code,sessions:Number(item.sessions),validityMonths:Number(item.validityMonths),reserveSessions:petCount,servicePackageCode:String(item.servicePackageCode)}:undefined,
  };
}

export function subscriptionExpiry(startedAt:number,validityMonths:number){const date=new Date(startedAt);date.setUTCMonth(date.getUTCMonth()+validityMonths);return date.getTime();}
