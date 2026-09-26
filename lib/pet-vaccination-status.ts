/**
 * Which stored canonical_pets.vaccination_status values mean the dog is vaccinated. "verified" is the
 * account profile value, "vaccinated" is what booking payloads and the pet form send, and "recorded" is
 * written when a dated vaccination record is added (lib/pet-vaccination-governance.ts). Everything else
 * ("pending", "not_provided", blank) means not yet vaccinated for Training's session-start rule.
 */
const VACCINATED=new Set(["verified","vaccinated","recorded"]);
export function isVaccinatedStatus(status:unknown){return VACCINATED.has(String(status??"").trim().toLowerCase());}
