import type { V2GroomingPackage } from './grooming-client';

type Pet = { species: string; ageYears?: number | null };
export function v2GroomingPetAudience(pet: Pet): V2GroomingPackage['audience'] | null {
  const species = String(pet.species || '').toLowerCase();
  if (species !== 'dog' && species !== 'cat') return null;
  if (typeof pet.ageYears === 'number' && pet.ageYears >= 0 && pet.ageYears <= 0.5) return 'young';
  return species;
}
/** Age categories do not erase species: a puppy and a kitten are still different care flows. */
export function v2GroomingSelectionIssue(pets: Pet[], audience?: V2GroomingPackage['audience']): string | null {
  if (!pets.length) return 'Choose at least one pet before booking.';
  if (pets.length > 4) return 'Book up to four pets, or send a large-family enquiry.';
  if (pets.some(pet => v2GroomingPetAudience(pet) === null)) return 'Grooming currently supports dogs and cats only.';
  if (new Set(pets.map(pet => String(pet.species).toLowerCase())).size > 1)
    return 'Dog and cat care cannot be mixed in one grooming booking. Create separate appointments for their safety.';
  if (new Set(pets.map(v2GroomingPetAudience)).size > 1)
    return 'Young-pet and adult care need separate appointments with the appropriate package.';
  if (audience && pets.some(pet => v2GroomingPetAudience(pet) !== audience))
    return 'The published package must match the selected pets and their age category.';
  return null;
}
