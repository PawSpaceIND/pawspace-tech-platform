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

const seeds:CanonicalPricingSeed[]=[];
for(const [code,name,price,minutes] of groomingSingles){
  seeds.push({id:`canonical_groom_${code}`,serviceCode:"grooming",packageCode:code,name,description:`Canonical Grooming price for ${name}`,basePrice:price,slotMinutes:minutes,blockingMinutes:minutes+30});
  for(const count of [2,3,4])seeds.push({id:`canonical_groom_${code}_${count}`,serviceCode:"grooming",packageCode:`${code}__${count}_pets`,name:`${name} · ${count} pets`,description:`Canonical ${count}-pet Grooming bundle price`,basePrice:groomingMultiPerPet[code]*count,slotMinutes:count>=4?240:count===3?150:120,blockingMinutes:(count>=4?240:count===3?150:120)+30});
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

export async function ensurePricingControlSchema(db:Db){if(pricingSchemaEnsured.has(db))return;await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS service_packages (id text PRIMARY KEY NOT NULL,service_code text NOT NULL,package_code text NOT NULL UNIQUE,name text NOT NULL,description text NOT NULL,base_price real NOT NULL,currency text DEFAULT 'INR' NOT NULL,tax_inclusive integer DEFAULT 1 NOT NULL,slot_minutes integer NOT NULL,blocking_minutes integer NOT NULL,active integer DEFAULT 1 NOT NULL,version integer DEFAULT 1 NOT NULL,effective_from text NOT NULL,effective_to text,updated_by text NOT NULL,updated_at integer NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS dynamic_pricing_rules (id text PRIMARY KEY NOT NULL,name text NOT NULL,service_code text NOT NULL,package_code text,city_id text DEFAULT 'blr' NOT NULL,zone_id text,rule_type text NOT NULL,days_json text DEFAULT '[]' NOT NULL,start_time text,end_time text,effective_from text NOT NULL,effective_to text,adjustment_type text NOT NULL,adjustment_value real NOT NULL,coupon_policy text DEFAULT 'stackable' NOT NULL,priority integer DEFAULT 100 NOT NULL,status text DEFAULT 'draft' NOT NULL,version integer DEFAULT 1 NOT NULL,updated_by text NOT NULL,updated_at integer NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS pricing_audit_events (id text PRIMARY KEY NOT NULL,entity_type text NOT NULL,entity_id text NOT NULL,action text NOT NULL,before_json text,after_json text NOT NULL,actor_id text NOT NULL,reason text NOT NULL,created_at integer NOT NULL)"),
]);pricingSchemaEnsured.add(db);}

export async function seedCanonicalPricingPackages(db:Db){
  if(pricingPackagesSeeded.has(db))return;
  await ensurePricingControlSchema(db);const now=Date.now();
  await db.batch(seeds.map(item=>db.prepare("INSERT OR IGNORE INTO service_packages (id,service_code,package_code,name,description,base_price,currency,tax_inclusive,slot_minutes,blocking_minutes,active,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,?,?,?,?,?,'INR',1,?,?,0,1,'2026-08-01',NULL,'founder_seed',?)")
    .bind(item.id,item.serviceCode,item.packageCode,item.name,item.description,item.basePrice,item.slotMinutes,item.blockingMinutes,now)));
  pricingPackagesSeeded.add(db);
}

export async function ensurePricingControlRuntime(db:Db){await seedCanonicalPricingPackages(db);}
