/*
 * Does this customer's Care Card ask for medication? One rule per service, kept here so the two places
 * that must agree read the SAME rule:
 *
 *   - the governed proof workflows (lib/boarding-proof-governance.ts, lib/sitting-proof-governance.ts)
 *     refuse medication evidence when the Care Card asks for none, and
 *   - the partner pending-proof projection (lib/provider-workspace.ts) owes medication proof only when
 *     the Care Card asks for medication. A pet that needs none can never be evidenced, so demanding it
 *     showed "missing medication" on every completed stay and visit.
 *
 * Pure and import-free, like lib/care-proof-photo-claims.ts, so either side can read it.
 */
function medicationText(plan:unknown){
 if(!plan||typeof plan!=="object"||Array.isArray(plan))return"";
 return String((plan as Record<string,unknown>).medication??"").trim();
}

/** Boarding: blank, "none", "no medication" and "n/a" are not an instruction. Returns the instruction or null. */
export function boardingMedicationInstruction(plan:unknown):string|null{
 const value=medicationText(plan);
 return value&&!/^(none|no medication|n\/a)$/i.test(value)?value:null;
}

/** Pet Sitting: blank and "none" are not an instruction. Returns the instruction or null. */
export function sittingMedicationInstruction(plan:unknown):string|null{
 const value=medicationText(plan);
 return value&&value.toLowerCase()!=="none"?value:null;
}
