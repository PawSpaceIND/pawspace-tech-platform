import { youngGroomingEligibility } from "./grooming-package-eligibility";
import type { CustomerPet } from "./customer-account-client";
export type GroomingPetType = "dog" | "cat" | "puppy" | "kitten";
export function groomingPetIssue(pet: CustomerPet, type: GroomingPetType, date: string): string | null {
  const species = type === "cat" || type === "kitten" ? "cat" : "dog";
  if (pet.species !== species) return `Choose a ${pet.species === "cat" ? "Cat" : pet.species === "dog" ? "Dog" : "different"} package for ${pet.name}.`;
  return type === "puppy" || type === "kitten" ? youngGroomingEligibility(pet, date) : null;
}
export function groomingSelectionForType(pets: CustomerPet[], selected: string[], type: GroomingPetType, date: string): string[] {
  const eligible = pets.filter(pet => !groomingPetIssue(pet, type, date));
  const kept = selected.filter(id => eligible.some(pet => pet.id === id)).slice(0, 4);
  return kept.length ? kept : eligible[0] ? [eligible[0].id] : [];
}
