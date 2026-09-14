/** Young packages are limited to six calendar months on the service date. */
export type GroomingPetAge = {
  name?: string; species: string; ageYears?: number | null;
  profile?: { dateOfBirth?: string; ageBand?: string } | null;
};

function calendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

export function youngGroomingEligibility(pet: GroomingPetAge, serviceDate: string): string | null {
  const adult = pet.species === "cat" ? "Adult Cat" : "Adult Dog";
  const guidance = `Choose an ${adult} package for ${pet.name || "this pet"}.`;
  const date = calendarDate(serviceDate);
  if (!date) return "Choose a valid service date before checking package eligibility.";
  const dobText = pet.profile?.dateOfBirth;
  if (dobText) {
    const dob = calendarDate(dobText);
    if (!dob || dob > date) return `Update this pet’s date of birth. ${guidance}`;
    // Clamp Aug 31 + six months to February's last day, rather than rolling into March.
    const lastDay = new Date(Date.UTC(dob.getUTCFullYear(), dob.getUTCMonth() + 7, 0)).getUTCDate();
    const limit = new Date(Date.UTC(dob.getUTCFullYear(), dob.getUTCMonth() + 6, Math.min(dob.getUTCDate(), lastDay)));
    return date <= limit ? null : `Puppy and Kitten packages are only for pets up to 6 months old. ${guidance}`;
  }
  if (pet.profile?.ageBand === "< 6 months") return null;
  // A broad 6–12 month band cannot establish eligibility at the six-month boundary.
  if (pet.profile?.ageBand) return `Confirm the date of birth for a package limited to 6 months. ${guidance}`;
  if (pet.ageYears != null && Number.isFinite(pet.ageYears) && pet.ageYears >= 0) {
    return pet.ageYears <= 0.5 ? null : `Puppy and Kitten packages are only for pets up to 6 months old. ${guidance}`;
  }
  return `Add this pet’s date of birth to confirm the 6-month limit. ${guidance}`;
}
