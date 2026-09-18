import { groomingCommercialAddOns } from "./grooming-commercial-catalogue";

// Keep canonical booking labels compatible with existing ledgers.
const labels: Record<string, string> = {
  "tick-flea-treatment": "Tick & flea treatment",
  "full-body-oil-massage": "Full-body oil massage",
};
export function groomingAddOnsForSpecies(species: string) {
  return groomingCommercialAddOns.filter(addOn => addOn.active && addOn.eligiblePetTypes.some(type => type === species))
    .map(addOn => ({ label: labels[addOn.code] ?? addOn.name, price: addOn.price }));
}
export function groomingAddOnsValid(addOns: string[], species: string) {
  const allowed = groomingAddOnsForSpecies(species);
  return new Set(addOns).size === addOns.length && addOns.every(label => allowed.some(item => item.label === label));
}
