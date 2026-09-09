export type TrainingAgePet = {species: string; ageYears?: number | null; profile?: {dateOfBirth?: string; ageBand?: string} | null};
export type TrainingAgeGroup = "puppy" | "adult" | "unknown";
const adultPackages = new Set(["training-8-basic","training-8-leash","training-12-leash","training-12-advanced","training-16-pro"]);
const dateOnly = (date: Date) => new Date(date.getTime()+330*60_000).toISOString().slice(0,10);
function validDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value+"T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10)===value ? date : null;
}
export function trainingAgeGroup(pet: TrainingAgePet, today = dateOnly(new Date())): TrainingAgeGroup {
  const now=validDate(today);
  if(!now) return "unknown";
  const dob=pet.profile?.dateOfBirth;
  // A recorded DOB is authoritative; never fall back from an invalid DOB to a guessed age band.
  if(dob){
    const born=validDate(dob);
    if(!born || born>now) return "unknown";
    const lastDay=new Date(Date.UTC(born.getUTCFullYear(),born.getUTCMonth()+7,0)).getUTCDate();
    const sixMonths=new Date(Date.UTC(born.getUTCFullYear(),born.getUTCMonth()+6,Math.min(born.getUTCDate(),lastDay)));
    return now<sixMonths ? "puppy" : "adult";
  }
  const band=pet.profile?.ageBand?.trim();
  if(band==="< 6 months") return "puppy";
  if(band==="6–12 months" || /^(?:[1-9]|1\d|20) years?$/.test(band||"") || band==="20+ years")return "adult";
  if(band) return "unknown";
  return typeof pet.ageYears==="number" && Number.isFinite(pet.ageYears) && pet.ageYears>=0
    ? pet.ageYears<0.5 ? "puppy" : "adult" : "unknown";
}
export function trainingEligibilityProblem(packageCode: string, pets: TrainingAgePet[], today?: string): string | null {
  if(!pets.length || pets.length>4 || pets.some(pet=>pet.species!=="dog"))return "Choose one to four saved dog profiles for training.";
  if(packageCode==="trainer-meet-greet" || packageCode==="training-2-starter")return null;
  if(packageCode!=="training-4-puppy" && !adultPackages.has(packageCode))return "This training programme is not available.";
  const groups=pets.map(pet=>trainingAgeGroup(pet,today));
  if(groups.includes("unknown"))return "Add a valid age or date of birth for every selected dog to see suitable programmes.";
  if(packageCode==="training-4-puppy")return groups.every(group=>group==="puppy") ? null : "Puppy training is for dogs under six months. Choose dogs in the same age group or book separately.";
  return groups.every(group=>group==="adult") ? null : "This programme is for dogs aged six months or older. Choose puppy training or book separate age groups.";
}
