import{groomingCommercialPackages}from"./grooming-commercial-catalogue";
import{chunkedIn}from"./d1-chunked-in";
type Db=D1Database;

type CanonicalPricingSeed={
  id:string;serviceCode:string;packageCode:string;name:string;description:string;basePrice:number;slotMinutes:number;blockingMinutes:number;
};

const groomingSingles=[
  ["dog-bath","Essential Bath",1349,120],
  ["dog-basic","Bath & Basic",1899,120],
  ["dog-makeover","Complete Makeover",2399,150],
  ["dog-trim","Just Trim",1599,120],
  ["cat-routine","Routine Grooming",1149,120],
  ["cat-basic","Bath & Basic",1899,120],
  ["cat-makeover","Complete Makeover",2399,150],
  ["cat-trim","Just Trim",1599,120],
  ["young-basic","Young Pet Bath & Basic",999,120],
  ["young-makeover","Young Pet Complete Makeover",1399,150],
] as const;
const groomingMultiPerPet:Record<string,number>={
  "dog-bath":1149,"dog-basic":1649,"dog-makeover":2149,"dog-trim":1399,
  "cat-routine":999,"cat-basic":1649,"cat-makeover":2149,"cat-trim":1399,
  "young-basic":899,"young-makeover":1299,
};

/** Bundle slot by pet count, never shorter than one pet of the same package (a 2-pet makeover got 120 of 150 min). */
const legacyBundleMinutes=(count:number)=>count>=4?240:count===3?150:120;
const bundleMinutes=(count:number,singleMinutes:number)=>Math.max(singleMinutes,legacyBundleMinutes(count));
const seeds:CanonicalPricingSeed[]=[];
const bundleRepairs:Array<{id:string;from:number;to:number}>=[];
/** Customer-facing copy from the commercial catalogue (V2 used to show "Canonical Grooming price for ..."). */
const inclusions=(code:string)=>groomingCommercialPackages.find(item=>item.code===code)?.included??[];
const customerDescription=(code:string,count=1)=>{const included=inclusions(code);if(!included.length)return"";return`${count>1?`For ${count} pets, each groomed in full. `:""}Includes ${included.join(", ")}.`;};
const descriptionRepairs:Array<{id:string;from:string;to:string}>=[];
for(const [code,name,price,minutes] of groomingSingles){
  seeds.push({id:`canonical_groom_${code}`,serviceCode:"grooming",packageCode:code,name,description:customerDescription(code)||`Canonical Grooming price for ${name}`,basePrice:price,slotMinutes:minutes,blockingMinutes:minutes+30});
  for(const count of [2,3,4])seeds.push({id:`canonical_groom_${code}_${count}`,serviceCode:"grooming",packageCode:`${code}__${count}_pets`,name:`${name} · ${count} pets`,description:customerDescription(code,count)||`Canonical ${count}-pet Grooming bundle price`,basePrice:groomingMultiPerPet[code]*count,slotMinutes:bundleMinutes(count,minutes),blockingMinutes:bundleMinutes(count,minutes)+30});
  if(customerDescription(code))descriptionRepairs.push({id:`canonical_groom_${code}`,from:`Canonical Grooming price for ${name}`,to:customerDescription(code)});
  for(const count of [2,3,4])if(customerDescription(code,count))descriptionRepairs.push({id:`canonical_groom_${code}_${count}`,from:`Canonical ${count}-pet Grooming bundle price`,to:customerDescription(code,count)});
  for(const count of [2,3,4])if(bundleMinutes(count,minutes)!==legacyBundleMinutes(count))bundleRepairs.push({id:`canonical_groom_${code}_${count}`,from:legacyBundleMinutes(count),to:bundleMinutes(count,minutes)});
}
seeds.push(
  {id:"canonical_training_meet",serviceCode:"dog_training",packageCode:"trainer-meet-greet",name:"Trainer Meet & Greet",description:"Canonical paid trainer introduction",basePrice:500,slotMinutes:45,blockingMinutes:90},
  {id:"canonical_training_2",serviceCode:"dog_training",packageCode:"training-2-starter",name:"Starter Plan",description:"Canonical 2-session Training programme",basePrice:3500,slotMinutes:60,blockingMinutes:105},
  {id:"canonical_training_4",serviceCode:"dog_training",packageCode:"training-4-puppy",name:"Puppy Training Plan",description:"Canonical 4-session Training programme",basePrice:6000,slotMinutes:60,blockingMinutes:105},
  {id:"canonical_training_8_basic",serviceCode:"dog_training",packageCode:"training-8-basic",name:"Basic Obedience Plan",description:"Canonical 8-session Training programme",basePrice:12000,slotMinutes:60,blockingMinutes:105},
  {id:"canonical_training_8_leash",serviceCode:"dog_training",packageCode:"training-8-leash",name:"Leash Obedience Plan · 8",description:"Canonical 8-session leash programme",basePrice:12000,slotMinutes:60,blockingMinutes:105},
  {id:"canonical_training_12_leash",serviceCode:"dog_training",packageCode:"training-12-leash",name:"Leash Obedience Plan · 12",description:"Canonical 12-session leash programme",basePrice:16500,slotMinutes:60,blockingMinutes:105},
  {id:"canonical_training_12_advanced",serviceCode:"dog_training",packageCode:"training-12-advanced",name:"Advanced Obedience Plan",description:"Canonical 12-session advanced programme",basePrice:16500,slotMinutes:60,blockingMinutes:105},
  {id:"canonical_training_16",serviceCode:"dog_training",packageCode:"training-16-pro",name:"Pro Training Plan",description:"Canonical 16-session Training programme",basePrice:20000,slotMinutes:60,blockingMinutes:105},
  {id:"canonical_boarding_4h",serviceCode:"boarding",packageCode:"boarding-4h",name:"Standard Stay",description:"Canonical 4-hour Boarding stay price per pet",basePrice:499,slotMinutes:240,blockingMinutes:240},
  {id:"canonical_boarding_10h",serviceCode:"boarding",packageCode:"boarding-10h",name:"Premium Stay",description:"Canonical 10-hour Boarding stay price per pet",basePrice:599,slotMinutes:600,blockingMinutes:600},
  {id:"canonical_boarding_24h",serviceCode:"boarding",packageCode:"boarding-24h",name:"Luxury Stay",description:"Canonical 24-hour Boarding unit price per pet",basePrice:699,slotMinutes:1440,blockingMinutes:1440},
  {id:"canonical_sitting_visit",serviceCode:"pet_sitting",packageCode:"sitting-visit-60",name:"Home Visit",description:"Canonical Home Visit base price",basePrice:399,slotMinutes:60,blockingMinutes:90},
  {id:"canonical_sitting_visit_extra",serviceCode:"pet_sitting",packageCode:"sitting-visit-60__extra_pet",name:"Home Visit · extra pet",description:"Canonical extra-pet component for Home Visit",basePrice:149,slotMinutes:60,blockingMinutes:90},
  {id:"canonical_sitting_overnight",serviceCode:"pet_sitting",packageCode:"sitting-overnight",name:"Overnight Pet Sitting",description:"Canonical Overnight Sitting base price per night",basePrice:799,slotMinutes:720,blockingMinutes:720},
  {id:"canonical_sitting_overnight_extra",serviceCode:"pet_sitting",packageCode:"sitting-overnight__extra_pet",name:"Overnight Pet Sitting · extra pet",description:"Canonical extra-pet component for Overnight Sitting",basePrice:399,slotMinutes:720,blockingMinutes:720},
);

// Per-isolate memoization: the schema and the ~56 canonical price rows are idempotent constants.
// resolveLivePrice() calls ensurePricingControlRuntime() on every priced booking, and before this the
// seed ran ~56 sequential INSERT OR IGNORE statements each time - the dominant cost of a canonical
// booking create. Batching collapses them to one round-trip and the WeakSet skips the work entirely
// once a given D1 binding has been seeded in this isolate.
const pricingSchemaEnsured=new WeakSet<Db>();
const pricingPackagesSeeded=new WeakSet<Db>();

export async function ensurePricingControlSchema(db:Db){if(pricingSchemaEnsured.has(db))return;const rows=await db.prepare("SELECT name FROM sqlite_master WHERE name IN ('service_packages','dynamic_pricing_rules','pricing_audit_events')").all<Record<string,unknown>>().catch(()=>({results:[] as Record<string,unknown>[]}));if(new Set(rows.results.map(row=>String(row.name))).size!==3)await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS service_packages (id text PRIMARY KEY NOT NULL,service_code text NOT NULL,package_code text NOT NULL UNIQUE,name text NOT NULL,description text NOT NULL,base_price real NOT NULL,currency text DEFAULT 'INR' NOT NULL,tax_inclusive integer DEFAULT 1 NOT NULL,slot_minutes integer NOT NULL,blocking_minutes integer NOT NULL,active integer DEFAULT 1 NOT NULL,version integer DEFAULT 1 NOT NULL,effective_from text NOT NULL,effective_to text,updated_by text NOT NULL,updated_at integer NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS dynamic_pricing_rules (id text PRIMARY KEY NOT NULL,name text NOT NULL,service_code text NOT NULL,package_code text,city_id text DEFAULT 'blr' NOT NULL,zone_id text,rule_type text NOT NULL,days_json text DEFAULT '[]' NOT NULL,start_time text,end_time text,effective_from text NOT NULL,effective_to text,adjustment_type text NOT NULL,adjustment_value real NOT NULL,coupon_policy text DEFAULT 'stackable' NOT NULL,priority integer DEFAULT 100 NOT NULL,status text DEFAULT 'draft' NOT NULL,version integer DEFAULT 1 NOT NULL,updated_by text NOT NULL,updated_at integer NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS pricing_audit_events (id text PRIMARY KEY NOT NULL,entity_type text NOT NULL,entity_id text NOT NULL,action text NOT NULL,before_json text,after_json text NOT NULL,actor_id text NOT NULL,reason text NOT NULL,created_at integer NOT NULL)"),
]);pricingSchemaEnsured.add(db);}

export async function seedCanonicalPricingPackages(db:Db){
  if(pricingPackagesSeeded.has(db))return;await ensurePricingControlSchema(db);
  const ids=seeds.map(item=>item.id);const row=await db.prepare(`SELECT COUNT(*) n FROM service_packages WHERE id IN (${ids.map(()=>"?").join(",")})`).bind(...ids).first<Record<string,unknown>>();
  if(Number(row?.n||0)!==seeds.length){const now=Date.now();await db.batch(seeds.map(item=>db.prepare("INSERT OR IGNORE INTO service_packages (id,service_code,package_code,name,description,base_price,currency,tax_inclusive,slot_minutes,blocking_minutes,active,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,?,?,?,?,?,'INR',1,?,?,0,1,'2026-08-01',NULL,'founder_seed',?)").bind(item.id,item.serviceCode,item.packageCode,item.name,item.description,item.basePrice,item.slotMinutes,item.blockingMinutes,now)));}
  // Rows seeded before the bundle fix keep the short slot (INSERT OR IGNORE). Repair only rows whose duration
  // fields are still exactly as seeded, so a duration staff chose is never overwritten; each repair is audited.
  // Cold-isolate cost: these ~50 guarded repairs ran one after another on the first priced request of every
  // isolate (about 12 s at staging's ~250 ms per D1 call, three times over on a Boarding search). One read
  // now finds the rows still exactly as seeded; only those run the same guarded UPDATE and audit as before,
  // side by side (each repair touches its own row). A row staff changed is skipped either way.
  const repairIds=[...new Set([...bundleRepairs,...descriptionRepairs].map(item=>item.id))];
  const current=new Map((await chunkedIn(repairIds,async(chunk,placeholders)=>(await db.prepare(`SELECT id,slot_minutes,blocking_minutes,description FROM service_packages WHERE id IN (${placeholders})`).bind(...chunk).all<Record<string,unknown>>()).results)).map(item=>[String(item.id),item]));
  await Promise.all(bundleRepairs.filter(repair=>{const item=current.get(repair.id);return item&&Number(item.slot_minutes)===repair.from&&Number(item.blocking_minutes)===repair.from+30;}).map(async repair=>{
    const changed=await db.prepare("UPDATE service_packages SET slot_minutes=?,blocking_minutes=?,version=version+1,updated_at=? WHERE id=? AND slot_minutes=? AND blocking_minutes=? RETURNING id").bind(repair.to,repair.to+30,Date.now(),repair.id,repair.from,repair.from+30).first<Record<string,unknown>>();
    if(changed)await db.prepare("INSERT INTO pricing_audit_events (id,entity_type,entity_id,action,before_json,after_json,actor_id,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(`price_audit_${crypto.randomUUID().slice(0,12)}`,"package",repair.id,"seed_repair",JSON.stringify({slot_minutes:repair.from,blocking_minutes:repair.from+30}),JSON.stringify({slot_minutes:repair.to,blocking_minutes:repair.to+30}),"system",`A multi-pet bundle must not be shorter than one pet (${repair.to} min)`,Date.now()).run();
  }));
  // Replace the seeded internal text only where it is still exactly as seeded; staff-written copy stays.
  await Promise.all(descriptionRepairs.filter(repair=>current.get(repair.id)?.description===repair.from).map(async repair=>{
    const changed=await db.prepare("UPDATE service_packages SET description=?,version=version+1,updated_at=? WHERE id=? AND description=? RETURNING id").bind(repair.to,Date.now(),repair.id,repair.from).first<Record<string,unknown>>();
    if(changed)await db.prepare("INSERT INTO pricing_audit_events (id,entity_type,entity_id,action,before_json,after_json,actor_id,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(`price_audit_${crypto.randomUUID().slice(0,12)}`,"package",repair.id,"seed_repair",JSON.stringify({description:repair.from}),JSON.stringify({description:repair.to}),"system","Customer-facing package description",Date.now()).run();
  }));
  pricingPackagesSeeded.add(db);
}

export async function ensurePricingControlRuntime(db:Db){await seedCanonicalPricingPackages(db);}
