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

// ---------------------------------------------------------------------------------------------------
// The other half of "a booking may not damage a saved pet": it may not DUPLICATE one either.
//
// The clause above is guarded by ON CONFLICT(id), so it only protects a row the booking actually
// addresses. The sitting and both taxi routes addressed a row they had MINTED — `PET-<customer>-<source>`
// — unconditionally, without first asking whether the customer already had a row for that source id.
// A pet saved under its own source id (seeded rows, and anything whose id is not the minted shape) can
// never match that mint, so ON CONFLICT(id) found nothing and INSERTED a SECOND row: the customer's one
// dog appeared twice in /api/customer-account, and grooming — which prices PER PET — quoted the two-pet
// price to a customer who ticked both copies of the same animal.
//
// app/api/canonical-bookings/route.ts already resolves identity before minting. Its rules are ported
// here verbatim in intent so all four booking surfaces share ONE implementation rather than four
// copies, which is the reason this module exists at all.
// ---------------------------------------------------------------------------------------------------

/** What a booking payload carries per pet. */
export type BookingPetInput={sourceId:string;name:string;species?:string;breed?:string;vaccinationStatus?:string};
/** What the booking must write and reference: an EXISTING row's id where one was found, a mint otherwise. */
export type ResolvedBookingPet={id:string;name:string;species:string;breed:string|null;vaccinationStatus:string;sourceId:string};
export type CanonicalPetResolution={ok:true;pets:ResolvedBookingPet[]}|{ok:false;error:string;status:number};
type SavedPetRow=Record<string,unknown>;

const petKey=(value:unknown)=>String(value??"").trim().toLowerCase();
const petToken=(value:string)=>value.replace(/[^A-Za-z0-9]/g,"").toUpperCase();
/**
 * The id a booking mints for a pet the customer has NOT saved yet.
 *
 * Identical to canonicalPetId() in lib/customer-account.ts on purpose: a pet first seen by a booking
 * and the same pet later saved through the pet manager land on the same row instead of two.
 */
export const mintCanonicalPetId=(customerId:string,sourceId:string)=>`PET-${petToken(customerId)}-${petToken(sourceId)}`;

/**
 * Resolve a booking's pets to canonical_pets rows BEFORE any id is minted.
 *
 * Resolution runs in PHASES over the whole payload rather than pet by pet, because identity has to be
 * settled for every pet before a weaker rule may claim a row — deciding pet-by-pet made the outcome
 * depend on payload order.
 */
export async function resolveCanonicalPets(db:D1Database,customerId:string,pets:readonly BookingPetInput[]):Promise<CanonicalPetResolution>{
 // A PRECONDITION, not an optimisation. Treating a failed read as "this customer has no pets" is worse
 // than failing: the booking would mint a fresh empty row beside the saved profile and bind to it —
 // precisely the defect being fixed — while reporting success. Callers run this before their write
 // batch, so returning here leaves no partial booking behind.
 //
 // Ordered by a STABLE TOTAL order: created_at breaks by age, id (the primary key) breaks every
 // remaining tie, so the same rows always yield the same candidate order on any SQLite.
 const existing=await db.prepare("SELECT id,source_pet_id,name,species,breed,vaccination_status FROM canonical_pets WHERE customer_id=? ORDER BY created_at ASC,id ASC").bind(customerId).all<SavedPetRow>().catch(()=>null);
 if(!existing)return{ok:false,error:"Unable to read this customer's pets right now",status:503};
 const saved=existing.results??[];
 const petText=(value:unknown)=>petKey(value)?String(value).trim():null;
 // 'not_provided' is the column's own sentinel for "unknown", so it counts as blank on both sides.
 const petVaccination=(value:unknown)=>petKey(value)&&petKey(value)!=="not_provided"?String(value).trim():null;
 const petHasProfile=(row:SavedPetRow)=>Boolean(petText(row.breed))||Boolean(petVaccination(row.vaccination_status));
 // The ONLY row a pre-fix booking could mint from a name-as-source-id payload carries this fingerprint:
 // source_pet_id equals the row's own name, and no profile was ever written. Nothing the account flow
 // saves looks like this, which keeps duplicate-healing from opening the door to same-name substitution.
 const isLegacyBookingArtifact=(row:SavedPetRow)=>petKey(row.source_pet_id)===petKey(row.name)&&!petHasProfile(row);
 const identityRowsFor=(sourceId:string)=>saved.filter(row=>petKey(row.source_pet_id)&&petKey(row.source_pet_id)===petKey(sourceId));
 const assignedRowIds=new Set<string>();
 const matches:Array<SavedPetRow|undefined>=new Array(pets.length);
 const take=(index:number,row:SavedPetRow)=>{matches[index]=row;assignedRowIds.add(String(row.id));};

 // PHASE 1 — reserve genuine exact source_pet_id identities across the WHOLE payload first. A pet the
 // customer already saved keeps its EXISTING row and its EXISTING id, whatever shape that id is in.
 // This is the phase the three routes never had, and the one the duplicate came from.
 pets.forEach((pet,index)=>{
  const genuine=identityRowsFor(pet.sourceId).filter(row=>!isLegacyBookingArtifact(row)&&!assignedRowIds.has(String(row.id)));
  const claim=genuine.find(petHasProfile)??genuine[0];
  if(claim)take(index,claim);
 });
 // PHASE 2 — legacy healing, deferred until identity is settled. A pet whose only identity match is a
 // pre-fix artifact adopts the saved pet of that name if one is still unclaimed; otherwise it keeps its
 // own artifact. The adoption target is chosen by the ARTIFACT's name — which, by the definition above,
 // IS its source_pet_id — never by the payload's name, so one animal's booking cannot reach another's row.
 pets.forEach((pet,index)=>{
  if(matches[index])return;
  const artifact=identityRowsFor(pet.sourceId).find(row=>isLegacyBookingArtifact(row)&&!assignedRowIds.has(String(row.id)));
  if(!artifact)return;
  take(index,saved.find(row=>petKey(row.name)===petKey(artifact.name)&&petHasProfile(row)&&!isLegacyBookingArtifact(row)&&!assignedRowIds.has(String(row.id)))??artifact);
 });
 // PHASE 3 — the legacy name-as-source-id fallback, and ONLY that: the flows that send the pet's NAME
 // as its source id, where the name is the only identity the payload carries. A source id that does not
 // match an existing row denotes a DISTINCT pet even when another pet shares its name, so a second dog
 // also called Bruno is minted in PHASE 4 instead of being bound to the first Bruno's row. A duplicate
 // row is recoverable; binding a booking to the wrong animal is not, so this gate fails towards minting.
 pets.forEach((pet,index)=>{
  if(matches[index]||petKey(pet.sourceId)!==petKey(pet.name))return;
  const named=saved.filter(row=>petKey(row.name)===petKey(pet.name)&&!assignedRowIds.has(String(row.id)));
  const claim=named.find(petHasProfile)??named[0];
  if(claim)take(index,claim);
 });
 // PHASE 4 — mint the rest, and fail closed rather than let two pets in one booking share an id: the
 // guarded upsert would silently no-op on the second, and the booking would record two animals against
 // one row.
 const taken=new Set(assignedRowIds);
 const minted=new Map<number,string>();
 for(let index=0;index<pets.length;index++){
  if(matches[index])continue;
  const id=mintCanonicalPetId(customerId,pets[index].sourceId);
  if(taken.has(id))return{ok:false,error:"Unable to allocate a canonical pet identifier for this booking",status:409};
  taken.add(id);minted.set(index,id);
 }
 // Stored values win wherever they are non-blank; the payload may only populate what is missing. The
 // conflict clause enforces the same rule in SQL — this keeps the two halves saying the same thing.
 return{ok:true,pets:pets.map((pet,index)=>{const match=matches[index];return{
  id:match?String(match.id):String(minted.get(index)),
  name:(match&&petText(match.name))??petText(pet.name)??String(pet.name),
  species:(match&&petText(match.species))??petText(pet.species)??"other",
  breed:(match&&petText(match.breed))??petText(pet.breed),
  vaccinationStatus:(match&&petVaccination(match.vaccination_status))??petVaccination(pet.vaccinationStatus)??"not_provided",
  sourceId:pet.sourceId,
 };})};
}
