import {trainingEligibilityProblem, type TrainingAgePet} from "./training-age-eligibility";
// Read-only, bounded lookup. Do not accept age or species claims from a booking payload.
export async function assertTrainingPetEligibility(db: D1Database, input: {customerId: string; petIds: string[]; packageCode: string}, today?: string) {
  if(!input.petIds.length || input.petIds.length>4 || input.petIds.some(id=>typeof id!=="string" || !id.trim()) || new Set(input.petIds).size!==input.petIds.length)
    throw new Response("Choose one to four distinct saved dogs.",{status:400});
  const pets: TrainingAgePet[]=[];
  const resolved=new Set<string>();
  for(const id of input.petIds){
    const result=await db.prepare("SELECT * FROM canonical_pets WHERE customer_id=? AND (id=? OR source_pet_id=?) LIMIT 2").bind(input.customerId,id,id).all<Record<string,unknown>>();
    if(result.results.length!==1 || resolved.has(String(result.results[0].id)))throw new Response("Update and save each selected dog in your pet profiles before booking.",{status:409});
    const row=result.results[0]; resolved.add(String(row.id));
    let profile: TrainingAgePet["profile"]=null;
    try { const parsed=JSON.parse(String(row.profile_json||"null")); if(parsed && typeof parsed==="object" && !Array.isArray(parsed)) profile={dateOfBirth:typeof parsed.dateOfBirth==="string"?parsed.dateOfBirth:undefined,ageBand:typeof parsed.ageBand==="string"?parsed.ageBand:undefined}; } catch { profile={dateOfBirth:"invalid"}; }
    pets.push({species:String(row.species),ageYears:typeof row.age_years==="number"?row.age_years:null,profile});
  }
  const problem=trainingEligibilityProblem(input.packageCode,pets,today);
  if(problem)throw new Response(problem,{status:409});
}
