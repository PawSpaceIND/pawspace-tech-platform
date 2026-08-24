export type GroomingCommercialPetType="dog"|"cat";
export type GroomingCommercialPackage={
  code:string;
  petType:GroomingCommercialPetType|"young";
  name:string;
  price:number;
  twoPetPrice?:number;
  included:string[];
  excluded:string[];
};
export type GroomingCommercialAddOn={code:string;name:string;price:number;eligiblePetTypes:GroomingCommercialPetType[];active:boolean};
export type GroomingCommercialPromotion={
  code:string;
  packageCode:string;
  regularPrice:number;
  offerPrice:number;
  activeByDefault:false;
  activation:"operator_controlled";
};

export const GROOMING_COMMERCIAL_TRUTH_VERSION="2026-08-24.v1";

const routineCore=["Nail Clipping","Deshedding","Teeth Cleaning","Ear & Eye Cleaning","Sanitary Trimming","Hair Brushing & Combing"];
const bathCore=["Bath","Shampoo & Conditioning","Deshedding","Blow Drying","Combing & Brushing"];
const basicExtras=["Nail Clipping","Paw Massage","Teeth Cleaning","Ear & Eye Cleaning","Sanitary Trimming","Minor trimming on the face & paws"];
const makeoverExtras=["Hair Styling","Full Body Trimming"];

export const groomingCommercialPackages:GroomingCommercialPackage[]=[
  {code:"dog-bath",petType:"dog",name:"Essential Bath",price:1349,twoPetPrice:2298,included:bathCore,excluded:[...basicExtras,"Hair Styling","Full Body Trimming"]},
  {code:"dog-basic",petType:"dog",name:"Bath & Basic Grooming",price:1899,twoPetPrice:3298,included:[...bathCore,...basicExtras],excluded:["Hair Styling","Full Body Trimming"]},
  {code:"dog-makeover",petType:"dog",name:"Complete Makeover",price:2399,twoPetPrice:4298,included:[...bathCore,...basicExtras,...makeoverExtras],excluded:[]},
  {code:"dog-trim",petType:"dog",name:"Only Haircut",price:1599,included:["Haircut","Nail Clipping","Ear Cleaning"],excluded:[]},
  {code:"cat-routine",petType:"cat",name:"Routine Grooming",price:1149,twoPetPrice:1998,included:routineCore,excluded:["Bath","Shampoo & Conditioning","Paw Massage","Blow Drying","Minor Trim on the face & paws","Hair Styling","Full Body Trimming"]},
  {code:"cat-basic",petType:"cat",name:"Bath & Basic Grooming",price:1899,twoPetPrice:3298,included:[...routineCore,"Bath","Shampoo & Conditioning","Paw Massage","Blow Drying","Minor Trim on the face & paws"],excluded:["Hair Styling","Full Body Trimming"]},
  {code:"cat-makeover",petType:"cat",name:"Complete Makeover",price:2399,twoPetPrice:4298,included:[...routineCore,"Bath","Shampoo & Conditioning","Paw Massage","Blow Drying","Minor Trim on the face & paws","Hair Styling","Full Body Trimming"],excluded:[]},
  {code:"cat-trim",petType:"cat",name:"Only Haircut",price:1599,included:["Haircut","Nail Clipping","Ear Cleaning"],excluded:[]},
  {code:"young-basic",petType:"young",name:"Puppy / Kitten Bath & Basic Grooming",price:999,included:[...routineCore,"Bath","Shampoo & Conditioning","Paw Massage","Blow Drying","Minor Trim on the face & paws"],excluded:["Hair Styling","Full Body Trimming"]},
  {code:"young-makeover",petType:"young",name:"Puppy / Kitten Complete Makeover",price:1399,included:[...routineCore,"Bath","Shampoo & Conditioning","Paw Massage","Blow Drying","Minor Trim on the face & paws","Hair Styling","Full Body Trimming"],excluded:[]},
];

export const groomingCommercialAddOns:GroomingCommercialAddOn[]=[
  {code:"tick-flea-treatment",name:"Tick & Flea Treatment",price:499,eligiblePetTypes:["dog","cat"],active:true},
  {code:"full-body-oil-massage",name:"Full Body Oil Massage",price:299,eligiblePetTypes:["dog","cat"],active:true},
];

/**
 * Creative offer prices are recorded as controlled promotion truth only. They are intentionally not
 * active booking defaults because the supplied creatives do not define campaign dates, eligibility,
 * stacking rules or an activation code. Pricing Control must explicitly activate an offer before a
 * customer transaction can use it.
 */
export const groomingCommercialPromotions:GroomingCommercialPromotion[]=[
  {code:"creative-dog-bath-1299",packageCode:"dog-bath",regularPrice:1349,offerPrice:1299,activeByDefault:false,activation:"operator_controlled"},
  {code:"creative-dog-basic-1699",packageCode:"dog-basic",regularPrice:1899,offerPrice:1699,activeByDefault:false,activation:"operator_controlled"},
  {code:"creative-dog-makeover-2199",packageCode:"dog-makeover",regularPrice:2399,offerPrice:2199,activeByDefault:false,activation:"operator_controlled"},
  {code:"creative-cat-routine-1049",packageCode:"cat-routine",regularPrice:1149,offerPrice:1049,activeByDefault:false,activation:"operator_controlled"},
  {code:"creative-cat-basic-1699",packageCode:"cat-basic",regularPrice:1899,offerPrice:1699,activeByDefault:false,activation:"operator_controlled"},
  {code:"creative-cat-makeover-2199",packageCode:"cat-makeover",regularPrice:2399,offerPrice:2199,activeByDefault:false,activation:"operator_controlled"},
];

export const groomingSubscriptionCommercialTruth={
  semiannual:{planCode:"sub-6",sessions:6,price:6594,perSession:1099,validityValue:6,validityUnit:"months" as const},
  annual:{planCode:"sub-12",sessions:12,price:11988,perSession:999,validityValue:12,validityUnit:"months" as const},
};
