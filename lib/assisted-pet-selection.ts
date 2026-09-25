import type {AssistedOrderPet} from './assisted-orders-client';

export function assistedPetKey(pet:AssistedOrderPet){return pet.canonicalId||pet.sourceId;}

/** Explicit pet selection, shared by the UI and its regression tests. */
export function selectAssistedPets(pets:AssistedOrderPet[],keys:string[]){
 const selected=pets.filter(pet=>keys.includes(assistedPetKey(pet)));
 if(selected.length<1||selected.length>4||new Set(keys).size!==keys.length||selected.length!==keys.length)throw new Error('Choose one to four registered pets for this booking.');
 if(new Set(selected.map(pet=>pet.species)).size!==1)throw new Error('Book dogs and cats in separate grooming appointments.');
 return selected;
}
