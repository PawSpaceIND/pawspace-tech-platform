import type {CustomerPet} from "./customer-account-client";

/** Never substitute the first pet if an explicit selection is absent or stale. */
export function walkingPetForSelection(pets: CustomerPet[], selectedId: string) {
 const pet = pets.find(item => item.id === selectedId && item.species === "dog");
 return pet ? {sourceId: pet.sourceId ?? pet.id, id: pet.id, name: pet.name, species: "dog" as const, breed: pet.breed ?? "", vaccinationStatus: pet.vaccinationStatus} : null;
}
