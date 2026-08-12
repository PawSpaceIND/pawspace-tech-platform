/**
 * Pet Relocation enquiry capture — the front-door lead form at /relocation-enquiry. A prospective
 * customer leaves contact + pickup/drop details before any case exists; staff triage the list at
 * /team/relocation-enquiries. Deliberately separate from the richer relocation-case pipeline in
 * lib/relocation-governance.ts (documents/quotes/vendors/milestones) — this is just intake.
 * Sandbox/UAT, no live money.
 */
type Db=D1Database;
type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,10).toUpperCase()}`;

const PHONE_RE=/^\d{10}$/;
const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;
const TIME_RE=/^([01]\d|2[0-3]):[0-5]\d$/;
const PET_TYPES=["dog","cat"] as const;
export type PetType=typeof PET_TYPES[number];

export type RelocationEnquiryInput={
  customerName:string;phonePrimary:string;phoneSecondary?:string;email:string;petType:string;
  pickupDate:string;pickupApproxTime:string;pickupLocation:string;dropLocation:string;expectedTravelDate:string;
};

export type RelocationEnquiry={
  id:string;customerName:string;phonePrimary:string;phoneSecondary:string|null;email:string;petType:PetType;
  pickupDate:string;pickupApproxTime:string;pickupLocation:string;dropLocation:string;expectedTravelDate:string;
  status:"new";createdAt:number;
};

// Per-isolate memoization: this DDL is idempotent and createRelocationEnquiry runs it on every
// submission; the WeakSet keeps it to one round-trip per D1 binding, then a no-op for the rest of
// the isolate's life (same pattern as lib/server-auth.ts / lib/provider-capacity-governance.ts).
const relocationEnquiryTablesEnsured=new WeakSet<Db>();
export async function ensureRelocationEnquiryTables(db:Db){
  if(relocationEnquiryTablesEnsured.has(db))return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS relocation_enquiries (id TEXT PRIMARY KEY,customer_name TEXT NOT NULL,phone_primary TEXT NOT NULL,phone_secondary TEXT,email TEXT NOT NULL,pet_type TEXT NOT NULL,pickup_date TEXT NOT NULL,pickup_approx_time TEXT NOT NULL,pickup_location TEXT NOT NULL,drop_location TEXT NOT NULL,expected_travel_date TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'new',created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_relocation_enquiries_created ON relocation_enquiries(created_at)"),
  ]);
  relocationEnquiryTablesEnsured.add(db);
}

function rowToEnquiry(row:Row):RelocationEnquiry{return{
  id:text(row.id),customerName:text(row.customer_name),phonePrimary:text(row.phone_primary),phoneSecondary:row.phone_secondary?text(row.phone_secondary):null,
  email:text(row.email),petType:text(row.pet_type) as PetType,pickupDate:text(row.pickup_date),pickupApproxTime:text(row.pickup_approx_time),
  pickupLocation:text(row.pickup_location),dropLocation:text(row.drop_location),expectedTravelDate:text(row.expected_travel_date),
  status:"new",createdAt:Number(row.created_at||0),
};}

/** Strict field-contract validation. Throws a plain Error with a human-readable message on the first violation. */
function validate(input:RelocationEnquiryInput){
  const customerName=text(input.customerName);
  if(!customerName)throw new Error("Customer name is required");
  const phonePrimary=text(input.phonePrimary);
  if(!PHONE_RE.test(phonePrimary))throw new Error("Primary phone number must be exactly 10 digits");
  const phoneSecondaryRaw=text(input.phoneSecondary);
  if(phoneSecondaryRaw&&!PHONE_RE.test(phoneSecondaryRaw))throw new Error("Secondary phone number must be exactly 10 digits");
  const email=text(input.email);
  if(!EMAIL_RE.test(email))throw new Error("A valid email address is required");
  const petType=text(input.petType).toLowerCase();
  if(!(PET_TYPES as readonly string[]).includes(petType))throw new Error('Pet type must be "dog" or "cat"');
  const pickupDate=text(input.pickupDate);
  if(!DATE_RE.test(pickupDate))throw new Error("Pickup date must be in YYYY-MM-DD format");
  const pickupApproxTime=text(input.pickupApproxTime);
  if(!TIME_RE.test(pickupApproxTime))throw new Error('Pickup approximate time must be in HH:MM format (e.g. "10:00")');
  const pickupLocation=text(input.pickupLocation);
  if(!pickupLocation)throw new Error("Pickup location is required");
  const dropLocation=text(input.dropLocation);
  if(!dropLocation)throw new Error("Drop location is required");
  const expectedTravelDate=text(input.expectedTravelDate);
  if(!DATE_RE.test(expectedTravelDate))throw new Error("Expected travel date must be in YYYY-MM-DD format");
  return{customerName,phonePrimary,phoneSecondary:phoneSecondaryRaw||null,email,petType:petType as PetType,pickupDate,pickupApproxTime,pickupLocation,dropLocation,expectedTravelDate};
}

/** Customer-facing, public: capture one relocation enquiry. No case, quote or vendor logic — pure lead intake. */
export async function createRelocationEnquiry(db:Db,input:RelocationEnquiryInput):Promise<RelocationEnquiry>{
  await ensureRelocationEnquiryTables(db);
  const clean=validate(input);
  const id=uid("RELQ"),now=Date.now();
  await db.prepare("INSERT INTO relocation_enquiries (id,customer_name,phone_primary,phone_secondary,email,pet_type,pickup_date,pickup_approx_time,pickup_location,drop_location,expected_travel_date,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id,clean.customerName,clean.phonePrimary,clean.phoneSecondary,clean.email,clean.petType,clean.pickupDate,clean.pickupApproxTime,clean.pickupLocation,clean.dropLocation,clean.expectedTravelDate,"new",now).run();
  return{id,...clean,status:"new",createdAt:now};
}

/** Staff-facing: newest-first directory of submitted enquiries. Cold-DB safe. */
export async function listRelocationEnquiries(db:Db):Promise<RelocationEnquiry[]>{
  await ensureRelocationEnquiryTables(db);
  const rows=await db.prepare("SELECT * FROM relocation_enquiries ORDER BY created_at DESC LIMIT 500").all<Row>().catch(()=>({results:[] as Row[]}));
  return rows.results.map(rowToEnquiry);
}
