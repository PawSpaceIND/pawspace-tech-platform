// The single definition of how a booking may write to canonical_pets.
//
// This clause was written for the boarding route after a booking that carried no breed or vaccination
// status was found ERASING what the customer had already saved. The sitting and taxi routes kept the
// original destructive upsert, so the same defect survived on those paths: booking a sitting stay or a
// taxi ride reset the pet's vaccination status to 'not_provided' and its breed to NULL, and boarding —
// which requires a verified status — then refused the very pet the customer had just vaccinated.
//
// It lives here, in one place, so a third booking surface cannot be written against the old semantics.
/**
 * The conflict clause for canonical_pets.
 *
 * The upsert used to overwrite unconditionally, so a booking carrying no breed or vaccination status
 * ERASED what the customer had already saved. A booking may now FILL a blank field and nothing else:
 * it may not overwrite a stored value, and it may not renormalize one either. A stored value that is
 * merely padded or oddly cased is still the customer's own value, so blankness is TESTED with a trim
 * while the ORIGINAL column is what gets written back.
 *
 * 'not_provided' is the vaccination column's own sentinel for "unknown", so it counts as blank —
 * matched case-insensitively on BOTH sides, because the sentinel has been written in more than one
 * casing. A genuinely recorded status is preserved byte for byte, spacing and casing included, and a
 * sentinel is only ever displaced by a real status, never rewritten into another sentinel spelling.
 *
 * updated_at moves only when a gap was genuinely filled, so a booking against an already-complete row
 * leaves that row untouched down to its timestamp — nothing downstream sees a phantom edit.
 *
 * The WHERE guard is the last line of defence: an update proposed against a row owned by another
 * customer is skipped rather than applied.
 */
export const PET_FIELDS=["name","species","breed","source_pet_id"] as const;
// SQL's bare TRIM() strips spaces ONLY, while the resolver's petKey() uses JS trim(). A tab-only value
// was therefore blank to the resolver and non-blank to this clause, so it could never be healed. The
// explicit character set — space, tab, LF, VT, FF, CR — brings SQL into line for ASCII whitespace.
const BLANK_CHARS="' '||CHAR(9)||CHAR(10)||CHAR(11)||CHAR(12)||CHAR(13)";
const blank=(expression:string)=>`TRIM(COALESCE(${expression},''),${BLANK_CHARS})`;
// A write happens ONLY where the stored side is blank AND the payload actually carries something, so
// "the column changed" and "updated_at moved" are the same condition — there is no write that leaves
// the timestamp behind, and no timestamp bump without a write.
const petFills=(column:string)=>`(${blank(`canonical_pets.${column}`)}='' AND ${blank(`excluded.${column}`)}<>'')`;
const petKeep=(column:string)=>`${column}=CASE WHEN ${petFills(column)} THEN excluded.${column} ELSE canonical_pets.${column} END`;
const VACCINATION_FILLS=`(LOWER(${blank("canonical_pets.vaccination_status")}) IN ('','not_provided') AND LOWER(${blank("excluded.vaccination_status")}) NOT IN ('','not_provided'))`;
export const CANONICAL_PET_UPSERT=`INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ${PET_FIELDS.map(petKeep).join(",")},vaccination_status=CASE WHEN ${VACCINATION_FILLS} THEN excluded.vaccination_status ELSE canonical_pets.vaccination_status END,updated_at=CASE WHEN ${[...PET_FIELDS.map(petFills),VACCINATION_FILLS].join(" OR ")} THEN excluded.updated_at ELSE canonical_pets.updated_at END WHERE canonical_pets.customer_id=excluded.customer_id`;
