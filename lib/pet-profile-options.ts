// Single source of truth for the pet-profile capture used by every booking form (grooming, boarding,
// pet sitting, pet taxi, training). Kept here so the breed lists, age bands, aggression levels and
// weight bands stay identical across services and the server can validate against the same sets.
//
// Breed lists are ordered popular-first (the ten most common domestic pets in India lead the list),
// then the rest alphabetically, then an explicit "Other / Mixed" so nothing is un-selectable.

export type PetSpecies = "dog" | "cat";

export const PET_GENDERS = ["Male", "Female"] as const;

// Popular-first, per the launch finding on the most common domestic dogs in India.
export const DOG_BREEDS = [
  "Indie (Indian Pariah)", "Labrador Retriever", "Golden Retriever", "German Shepherd", "Shih Tzu",
  "Pug", "Beagle", "Rottweiler", "Pomeranian", "Dobermann",
  // remainder, alphabetical
  "Boxer", "Bulldog", "Chihuahua", "Cocker Spaniel", "Dachshund", "Dalmatian", "Great Dane",
  "Lhasa Apso", "Maltese", "Mudhol Hound", "Rajapalayam", "Saint Bernard", "Shar Pei",
  "Siberian Husky", "Spitz", "Yorkshire Terrier",
  "Other / Mixed",
] as const;

export const CAT_BREEDS = [
  "Indian Billi (Domestic)", "Domestic Shorthair", "Persian", "Maine Coon", "Siamese",
  "Bengal", "Ragdoll", "British Shorthair", "Himalayan", "Sphynx",
  // remainder, alphabetical
  "Abyssinian", "American Shorthair", "Birman", "Bombay", "Burmese", "Munchkin", "Norwegian Forest",
  "Russian Blue", "Scottish Fold", "Turkish Angora",
  "Other / Mixed",
] as const;

export const breedsFor = (species: PetSpecies) => (species === "cat" ? CAT_BREEDS : DOG_BREEDS);

// "< 6 months", "6–12 months", then whole years 1..20, then "20+ years".
export const AGE_BANDS = [
  "< 6 months", "6–12 months",
  ...Array.from({ length: 20 }, (_, i) => `${i + 1} year${i === 0 ? "" : "s"}`),
  "20+ years",
] as const;

// Temperament, captured so a groomer/handler knows how to approach the pet — especially at bath time.
export const AGGRESSION_LEVELS = [
  "Friendly", "Moderate", "Aggressive during bath", "Very aggressive",
] as const;

// Weight bands (kg), with an explicit "Not sure" so the field is never a forced guess.
export const WEIGHT_BANDS = ["Not sure", "3–20 kg", "20–45 kg", "45–60 kg", "60+ kg"] as const;

export const VACCINATION_CHOICES = ["Vaccinated", "Not vaccinated"] as const;

// The captured profile a form collects for one pet, beyond name/species.
export type PetProfile = {
  gender?: string;
  breed: string;
  ageBand: string;
  dateOfBirth?: string;        // ISO yyyy-mm-dd, optional
  vaccinated: boolean;
  vaccinationDose?: string;    // e.g. "Rabies" — optional, only when vaccinated
  aggression: string;
  weightBand: string;
  photo?: string;              // compact data-URL thumbnail (UAT storage), optional
};

// Server-side allow-lists (so a client can't submit an off-catalogue value).
const asSet = (values: readonly string[]) => new Set(values.map((v) => v.toLowerCase()));
export const VALID = {
  gender: asSet(PET_GENDERS),
  dogBreed: asSet(DOG_BREEDS),
  catBreed: asSet(CAT_BREEDS),
  age: asSet(AGE_BANDS),
  aggression: asSet(AGGRESSION_LEVELS),
  weight: asSet(WEIGHT_BANDS),
};

export function validatePetProfile(species: PetSpecies, p: Partial<PetProfile>): string | null {
  const breedSet = species === "cat" ? VALID.catBreed : VALID.dogBreed;
  if (!p.breed || !breedSet.has(String(p.breed).toLowerCase())) return "Select the pet's breed";
  if (!p.ageBand || !VALID.age.has(String(p.ageBand).toLowerCase())) return "Select the pet's age";
  if (!p.aggression || !VALID.aggression.has(String(p.aggression).toLowerCase())) return "Select the pet's temperament";
  if (!p.weightBand || !VALID.weight.has(String(p.weightBand).toLowerCase())) return "Select the pet's weight range";
  if (p.gender && !VALID.gender.has(String(p.gender).toLowerCase())) return "Select a valid gender";
  if (typeof p.vaccinated !== "boolean") return "Tell us whether the pet is vaccinated";
  if (p.dateOfBirth) {
    // Shape *and* calendar validity — "2024-02-31" rolls over, so a round-trip mismatch catches it —
    // and a birth date can't be in the future.
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.dateOfBirth);
    if (!match) return "Date of birth must be a valid date";
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "Date of birth must be a valid date";
    if (date.getTime() > Date.now()) return "Date of birth can't be in the future";
  }
  return null;
}

// Reverse-derive the band selections from the legacy typed columns, so editing a pet captured before
// this profile existed pre-fills everything we can and only genuinely-new fields need a choice.
export function ageBandFromYears(years: number | null | undefined): string {
  if (years === null || years === undefined || !Number.isFinite(years) || years < 0) return "";
  if (years < 0.5) return "< 6 months";
  if (years < 1) return "6–12 months";
  if (years >= 20) return "20+ years";
  const whole = Math.round(years);
  const band = `${whole} year${whole === 1 ? "" : "s"}`;
  return (AGE_BANDS as readonly string[]).includes(band) ? band : "";
}
export function weightBandFromKg(kg: number | null | undefined): string {
  if (kg === null || kg === undefined || !Number.isFinite(kg) || kg <= 0) return "";
  if (kg < 20) return "3–20 kg";
  if (kg < 45) return "20–45 kg";
  if (kg < 60) return "45–60 kg";
  return "60+ kg";
}
