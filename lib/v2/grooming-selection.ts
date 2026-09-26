import type { V2GroomingPackage } from './grooming-client';
import { youngGroomingEligibility } from '../grooming-package-eligibility';

type Pet = { species: string; ageYears?: number | null; name?: string; profile?: { dateOfBirth?: string; ageBand?: string; weightBand?: string; aggression?: string } | null };

function validBirthDate(pet: Pet, serviceDate?: string): string | null {
  const value = pet.profile?.dateOfBirth;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return !serviceDate || value <= serviceDate ? value : null;
}

/**
 * A pet is young when its date of birth is within six months of the service date, the rule the server
 * applies at booking. The saved ageYears is fixed when the pet is saved and goes stale, so it is only the
 * fallback for pets without a usable date of birth.
 */
export function v2GroomingPetAudience(pet: Pet, serviceDate?: string): V2GroomingPackage['audience'] | null {
  const species = String(pet.species || '').toLowerCase();
  if (species !== 'dog' && species !== 'cat') return null;
  const born = serviceDate ? validBirthDate(pet, serviceDate) : null;
  if (born && serviceDate) return youngGroomingEligibility({ species, profile: { dateOfBirth: born } }, serviceDate) === null ? 'young' : species;
  if (typeof pet.ageYears === 'number' && pet.ageYears >= 0 && pet.ageYears <= 0.5) return 'young';
  return species;
}
/** Age categories do not erase species: a puppy and a kitten are still different care flows. */
export function v2GroomingSelectionIssue(pets: Pet[], audience?: V2GroomingPackage['audience'], serviceDate?: string): string | null {
  if (!pets.length) return 'Choose at least one pet before booking.';
  if (pets.length > 4) return 'Book up to four pets, or send a large-family enquiry.';
  const audienceOf = (pet: Pet) => v2GroomingPetAudience(pet, serviceDate);
  if (pets.some(pet => audienceOf(pet) === null)) return 'Grooming currently supports dogs and cats only.';
  if (new Set(pets.map(pet => String(pet.species).toLowerCase())).size > 1)
    return 'Dog and cat care cannot be mixed in one grooming booking. Create separate appointments for their safety.';
  if (new Set(pets.map(audienceOf)).size > 1)
    return 'Young-pet and adult care need separate appointments with the appropriate package.';
  if (audience && pets.some(pet => audienceOf(pet) !== audience))
    return 'The published package must match the selected pets and their age category.';
  return null;
}

/** Owner decision (QA M10): same price, but 30 extra minutes for a giant dog or an aggressive temperament. */
export const EXTRA_CARE_MINUTES = 30;
const EXTRA_CARE_WEIGHTS = new Set(['45–60 kg', '60+ kg']), EXTRA_CARE_TEMPERAMENTS = new Set(['Aggressive during bath', 'Very aggressive']);
export function v2ExtraCareReason(pets: Array<{ name?: string; profile?: { weightBand?: string; aggression?: string } | null }>): string | null {
  for (const pet of pets) {
    const weight = pet.profile?.weightBand ?? '', temperament = pet.profile?.aggression ?? '';
    if (EXTRA_CARE_WEIGHTS.has(weight) || EXTRA_CARE_TEMPERAMENTS.has(temperament))
      return `${pet.name || 'Your pet'} gets ${EXTRA_CARE_MINUTES} extra minutes (${[EXTRA_CARE_WEIGHTS.has(weight) ? weight : '', EXTRA_CARE_TEMPERAMENTS.has(temperament) ? temperament.toLowerCase() : ''].filter(Boolean).join(', ')}) at no extra cost, and your groomer is told.`;
  }
  return null;
}

/** IST calendar date of a service start, the date the young-package limit is measured on. */
export function v2GroomingServiceDate(scheduledStart: string): string | undefined {
  const at = Date.parse(scheduledStart);
  if (!Number.isFinite(at)) return undefined;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export type V2YoungPackageIssue = { message: string; fix: 'add_date_of_birth' | 'update_date_of_birth' | null };

/**
 * Young packages need a date of birth within six months of the service date. Applying the server's own
 * rule here stops V2 from quoting and reserving a groomer for a booking the server will refuse, and says
 * which profile change (if any) would make the pet eligible.
 */
export function v2YoungPackageIssue(pets: Pet[], serviceDate: string): V2YoungPackageIssue | null {
  for (const pet of pets) {
    const message = youngGroomingEligibility({ name: pet.name, species: String(pet.species || '').toLowerCase(), ageYears: pet.ageYears ?? null, profile: pet.profile ?? null }, serviceDate);
    if (!message) continue;
    const fix = !pet.profile?.dateOfBirth ? 'add_date_of_birth' : validBirthDate(pet, serviceDate) ? null : 'update_date_of_birth';
    return { message, fix };
  }
  return null;
}
