type GroomingPetType = "dog" | "cat" | "puppy" | "kitten";
type Pet = { id: string; species: string };

/** Preserve an explicit package choice; never silently substitute another species. */
export function groomingEntryPets(pets: Pet[], requestedType?: GroomingPetType) {
  const firstSupported = pets.find(pet => pet.species === "dog" || pet.species === "cat");
  const type: GroomingPetType = requestedType ?? (firstSupported?.species === "cat" ? "cat" : "dog");
  const species = type === "cat" || type === "kitten" ? "cat" : "dog";
  const match = pets.find(pet => pet.species === species);
  return { type, selectedPetIds: match ? [match.id] : [] };
}
