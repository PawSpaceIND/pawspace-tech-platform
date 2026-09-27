/*
 * Does this customer's Care Card ask for medication? One rule, kept here so the places that must agree
 * read the SAME rule:
 *
 *   - the governed Boarding and Pet Sitting proof workflows (lib/boarding-proof-governance.ts,
 *     lib/sitting-proof-governance.ts) refuse medication evidence when the Care Card asks for none, and
 *   - the partner pending-proof projection (lib/provider-workspace.ts) owes medication proof only when
 *     the Care Card asks for medication. A pet that needs none can never be evidenced, so demanding it
 *     showed "missing medication" on every completed stay and visit.
 *
 * Blank, "none", "no medication" and "n/a" are not an instruction. Pet Sitting used to accept evidence
 * against "no medication" or "n/a" as if they were one.
 *
 * Pure and import-free, like lib/care-proof-photo-claims.ts, so either side can read it.
 */
export function careCardMedicationInstruction(plan:unknown):string|null{
 if(!plan||typeof plan!=="object"||Array.isArray(plan))return null;
 const value=String((plan as Record<string,unknown>).medication??"").trim();
 return value&&!/^(none|no medication|n\/a)$/i.test(value)?value:null;
}
