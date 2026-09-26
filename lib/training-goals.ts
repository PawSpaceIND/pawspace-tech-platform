/** Training goals offered when the governed list (/api/training-requirements) can't be read. Used by the mobile flow and V2. */
export const TRAINING_FALLBACK_GOALS=["Toilet routine","Biting & chewing","Leash walking","Recall","Basic obedience","Socialisation","Excess barking","Separation anxiety"] as const;

/** The core programme: recommended when no selected goal points at a plan, and the winner of any tie it is part of. */
export const TRAINING_CORE_PACKAGE_CODE="training-8-basic";
/** The Puppy Training Plan is for "Puppies up to 8 months" (its catalogue copy in app/mobile-app/training-flow.tsx). */
export const PUPPY_PLAN_MAX_AGE_MONTHS=8;
const PUPPY_PACKAGE_CODE="training-4-puppy",STARTER_PACKAGE_CODE="training-2-starter";

/**
 * The entry programme each governed goal points to, keyed on the trimmed, lower-cased label (the convention
 * lib/training-provider-projection.ts uses). Custom, staff-added and renamed goals are not listed, so they never
 * score. Leash 12, Advanced and Pro are level steps that goals cannot reveal, and the Meet & Greet is not a
 * programme, so no goal points at them; they stay selectable.
 */
export const TRAINING_GOAL_PACKAGE:ReadonlyMap<string,string>=new Map([
 ["toilet routine","training-4-puppy"], // Puppy Training Plan outcome "Toilet routine"
 ["biting & chewing","training-4-puppy"], // Puppy Training Plan outcome "Biting control"
 ["socialisation","training-4-puppy"], // Puppy Training Plan: "Early habits, confidence, socialisation…", outcome "Social confidence"
 ["basic obedience","training-8-basic"], // Basic Obedience Plan: "Obedience, impulse control, home manners and communication."
 ["recall","training-8-basic"], // Basic Obedience Plan outcome "Sit, stay and recall"
 ["recall practice","training-8-basic"], // legacy label for Recall, still shown to trainers
 ["leash walking","training-8-leash"], // Leash Obedience Plan · 8: "Pulling, reactivity, heel positioning…", outcome "Loose-leash walk"
 // No plan names barking or anxiety, so this is a judgement call: the Starter Plan is the assessment-first plan
 // "for dogs of any age" and the smallest suitable one (lib/maya-knowledge-base.ts: "Recommend the smallest suitable package first").
 ["excess barking","training-2-starter"], // Starter Plan outcomes "Behaviour assessment · Home routine · Action plan"
 ["separation anxiety","training-2-starter"], // Starter Plan outcomes "Behaviour assessment · Home routine · Action plan"
]);
// A tie goes to the first tied plan in this fixed order: the core programme, then the smallest plan.
const TIE_ORDER=[TRAINING_CORE_PACKAGE_CODE,STARTER_PACKAGE_CODE,PUPPY_PACKAGE_CODE,"training-8-leash"];

/** The age fields of a customer's pet (a CustomerPet fits). */
export type TrainingPlanDog={ageYears?:number|null;profile?:{dateOfBirth?:string}|null};
export type TrainingPlanRecommendation={packageCode:string;basis:"goals"|"catalogue_default";matchedGoals:string[];puppyPlanAgeExcluded:boolean};

/** Full calendar months from a yyyy-mm-dd birth date to the local date of `now`, counted as lib/pet-profile-options.ts
 *  ageBandFromDateOfBirth counts them. Null for a malformed or future date. */
function fullMonthsSince(dateOfBirth:string,now:number){
 const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);if(!match)return null;
 const[year,month,day]=[Number(match[1]),Number(match[2]),Number(match[3])],dob=new Date(Date.UTC(year,month-1,day));
 if(dob.getUTCFullYear()!==year||dob.getUTCMonth()!==month-1||dob.getUTCDate()!==day)return null;
 const at=new Date(now),today=new Date(Date.UTC(at.getFullYear(),at.getMonth(),at.getDate()));
 if(dob.getTime()>today.getTime())return null;
 let months=(today.getUTCFullYear()-dob.getUTCFullYear())*12+today.getUTCMonth()-dob.getUTCMonth();
 if(today.getUTCDate()<dob.getUTCDate())months-=1;
 return months;
}
/**
 * Whether a dog is past the Puppy plan's "up to 8 months". As in lib/grooming-package-eligibility.ts, only a birth
 * date establishes age. Without one, a saved age of a year or more counts; the "< 6 months" (0.25) and "6–12 months"
 * (0.75) bands and unknown ages never do. A saved age is a snapshot that only under-reports, so this can miss an
 * older dog but never wrongly excludes a puppy.
 */
function pastPuppyPlan(dog:TrainingPlanDog,now:number){
 const months=dog.profile?.dateOfBirth?fullMonthsSince(dog.profile.dateOfBirth,now):null;
 return months!==null?months>PUPPY_PLAN_MAX_AGE_MONTHS:(dog.ageYears??0)>=1;
}

/**
 * The programme the customer's goals point to, with the goals behind it (the pure-recommender pattern of
 * recommendGroomingPackage in lib/crm-inquiry-classification.ts). Each recognised goal counts for its plan if that
 * plan is in `packageCodes`, and the plan with the most goals wins, ties going by TIE_ORDER. If any dog is past the Puppy plan, puppy goals point to the Starter Plan instead ("a puppy or starter
 * programme", lib/maya-knowledge-base.ts). With no recognised goal the core programme is the catalogue default, and
 * with that missing too there is no recommendation.
 */
export function recommendTrainingPlan({goals,packageCodes,dogs=[],now=Date.now()}:{goals:readonly string[];packageCodes:readonly string[];dogs?:readonly TrainingPlanDog[];now?:number}):TrainingPlanRecommendation|null{
 const catalogue=new Set(packageCodes),pastPuppy=dogs.some(dog=>pastPuppyPlan(dog,now)),seen=new Set<string>(),byPlan=new Map<string,string[]>();
 let puppyPlanAgeExcluded=false;
 for(const raw of goals){
  if(typeof raw!=="string")continue;
  const goal=raw.trim(),key=goal.toLowerCase();
  if(!goal||seen.has(key))continue;
  seen.add(key);
  let code=TRAINING_GOAL_PACKAGE.get(key);
  if(code===PUPPY_PACKAGE_CODE&&pastPuppy){code=STARTER_PACKAGE_CODE;puppyPlanAgeExcluded=true;}
  if(!code||!catalogue.has(code))continue;
  byPlan.set(code,[...(byPlan.get(code)||[]),goal]);
 }
 let best:{code:string;goals:string[]}|null=null;
 for(const code of TIE_ORDER){const matched=byPlan.get(code);if(matched&&matched.length>(best?.goals.length??0))best={code,goals:matched};}
 if(best)return{packageCode:best.code,basis:"goals",matchedGoals:best.goals,puppyPlanAgeExcluded};
 return catalogue.has(TRAINING_CORE_PACKAGE_CODE)?{packageCode:TRAINING_CORE_PACKAGE_CODE,basis:"catalogue_default",matchedGoals:[],puppyPlanAgeExcluded}:null;
}
