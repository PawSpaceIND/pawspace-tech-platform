type Db=D1Database;
type Row=Record<string,unknown>;

export type ServiceZone={zoneId:string;zoneName:string;description:string;color:string;serviceAvailable:boolean};
export type ZoneAssignment={pincode:string;zoneId:string;city:string;area:string};

// Bengaluru service zone mapping: pincode -> zone
// Zones: blr-east, blr-west, blr-north, blr-south, blr-central
// Bengaluru pincode -> zone. The previous table was fabricated: it placed Koramangala in the WEST
// zone under pincode 560018 (which is Chamarajpet), Whitefield in the NORTH under 560048, listed
// "Whitehall" as a locality, and omitted HSR Layout, Koramangala, Bellandur, BTM, Bannerghatta and
// Indiranagar's real pincodes entirely. A customer in HSR Layout - one of the densest pet-owning
// areas in the city - was told PawSpace does not serve them, and the funnel ended there.
//
// These are the operations-reviewed pincodes and their real zones. The resolver deliberately fails
// closed instead of treating a broad city radius/range as proof that a pincode can be fulfilled.
const PINCODE_ZONE_MAP:Record<string,ZoneAssignment>={
  // blr-east
  "560016":{pincode:"560016",zoneId:"blr-east",city:"Bengaluru",area:"Ramamurthy Nagar"},
  "560017":{pincode:"560017",zoneId:"blr-east",city:"Bengaluru",area:"Vimanapura"},
  "560036":{pincode:"560036",zoneId:"blr-east",city:"Bengaluru",area:"KR Puram"},
  "560037":{pincode:"560037",zoneId:"blr-east",city:"Bengaluru",area:"Marathahalli"},
  "560038":{pincode:"560038",zoneId:"blr-east",city:"Bengaluru",area:"Indiranagar"},
  "560043":{pincode:"560043",zoneId:"blr-east",city:"Bengaluru",area:"Kalyan Nagar & Banaswadi"},
  "560048":{pincode:"560048",zoneId:"blr-east",city:"Bengaluru",area:"Hoodi & ITPL"},
  "560049":{pincode:"560049",zoneId:"blr-east",city:"Bengaluru",area:"Avalahalli"},
  "560066":{pincode:"560066",zoneId:"blr-east",city:"Bengaluru",area:"Whitefield"},
  "560071":{pincode:"560071",zoneId:"blr-east",city:"Bengaluru",area:"Domlur"},
  "560075":{pincode:"560075",zoneId:"blr-east",city:"Bengaluru",area:"New Thippasandra"},
  "560087":{pincode:"560087",zoneId:"blr-east",city:"Bengaluru",area:"Varthur"},
  "560093":{pincode:"560093",zoneId:"blr-east",city:"Bengaluru",area:"CV Raman Nagar"},
  "560103":{pincode:"560103",zoneId:"blr-east",city:"Bengaluru",area:"Bellandur"},
  // blr-south
  "560011":{pincode:"560011",zoneId:"blr-south",city:"Bengaluru",area:"Jayanagar 4th Block"},
  "560029":{pincode:"560029",zoneId:"blr-south",city:"Bengaluru",area:"Wilson Garden & Lakkasandra"},
  "560034":{pincode:"560034",zoneId:"blr-south",city:"Bengaluru",area:"Koramangala"},
  "560041":{pincode:"560041",zoneId:"blr-south",city:"Bengaluru",area:"Jayanagar"},
  "560061":{pincode:"560061",zoneId:"blr-south",city:"Bengaluru",area:"Uttarahalli"},
  "560062":{pincode:"560062",zoneId:"blr-south",city:"Bengaluru",area:"Kanakapura Road"},
  "560068":{pincode:"560068",zoneId:"blr-south",city:"Bengaluru",area:"BTM Layout & Bommanahalli"},
  "560069":{pincode:"560069",zoneId:"blr-south",city:"Bengaluru",area:"JP Nagar 6th Phase"},
  "560070":{pincode:"560070",zoneId:"blr-south",city:"Bengaluru",area:"Banashankari"},
  "560076":{pincode:"560076",zoneId:"blr-south",city:"Bengaluru",area:"Bannerghatta Road & Arekere"},
  "560078":{pincode:"560078",zoneId:"blr-south",city:"Bengaluru",area:"JP Nagar"},
  "560085":{pincode:"560085",zoneId:"blr-south",city:"Bengaluru",area:"Banashankari 3rd Stage"},
  "560095":{pincode:"560095",zoneId:"blr-south",city:"Bengaluru",area:"Koramangala 8th Block"},
  "560100":{pincode:"560100",zoneId:"blr-south",city:"Bengaluru",area:"Electronic City"},
  "560102":{pincode:"560102",zoneId:"blr-south",city:"Bengaluru",area:"HSR Layout"},
  // blr-central
  "560001":{pincode:"560001",zoneId:"blr-central",city:"Bengaluru",area:"MG Road & CBD"},
  "560002":{pincode:"560002",zoneId:"blr-central",city:"Bengaluru",area:"Chickpet"},
  "560005":{pincode:"560005",zoneId:"blr-central",city:"Bengaluru",area:"Frazer Town"},
  "560008":{pincode:"560008",zoneId:"blr-central",city:"Bengaluru",area:"Ulsoor"},
  "560009":{pincode:"560009",zoneId:"blr-central",city:"Bengaluru",area:"Majestic"},
  "560025":{pincode:"560025",zoneId:"blr-central",city:"Bengaluru",area:"Richmond Town"},
  "560027":{pincode:"560027",zoneId:"blr-central",city:"Bengaluru",area:"Shanthinagar"},
  "560042":{pincode:"560042",zoneId:"blr-central",city:"Bengaluru",area:"Shivajinagar"},
  "560046":{pincode:"560046",zoneId:"blr-central",city:"Bengaluru",area:"Jayamahal & Benson Town"},
  "560047":{pincode:"560047",zoneId:"blr-central",city:"Bengaluru",area:"Austin Town & Viveknagar"},
  "560051":{pincode:"560051",zoneId:"blr-central",city:"Bengaluru",area:"Vasanth Nagar"},
  "560052":{pincode:"560052",zoneId:"blr-central",city:"Bengaluru",area:"Gandhi Nagar"},
  "560053":{pincode:"560053",zoneId:"blr-central",city:"Bengaluru",area:"Balepet"},
  // blr-north
  "560003":{pincode:"560003",zoneId:"blr-north",city:"Bengaluru",area:"Malleswaram"},
  "560024":{pincode:"560024",zoneId:"blr-north",city:"Bengaluru",area:"Ganganagar"},
  "560032":{pincode:"560032",zoneId:"blr-north",city:"Bengaluru",area:"RT Nagar & Hebbal"},
  "560033":{pincode:"560033",zoneId:"blr-north",city:"Bengaluru",area:"Kaval Byrasandra"},
  "560045":{pincode:"560045",zoneId:"blr-north",city:"Bengaluru",area:"Nagavara"},
  "560054":{pincode:"560054",zoneId:"blr-north",city:"Bengaluru",area:"Mathikere"},
  "560063":{pincode:"560063",zoneId:"blr-north",city:"Bengaluru",area:"Jakkur"},
  "560064":{pincode:"560064",zoneId:"blr-north",city:"Bengaluru",area:"Yelahanka"},
  "560065":{pincode:"560065",zoneId:"blr-north",city:"Bengaluru",area:"GKVK"},
  "560077":{pincode:"560077",zoneId:"blr-north",city:"Bengaluru",area:"Thanisandra"},
  "560080":{pincode:"560080",zoneId:"blr-north",city:"Bengaluru",area:"Sadashivanagar"},
  "560092":{pincode:"560092",zoneId:"blr-north",city:"Bengaluru",area:"Sahakar Nagar"},
  "560094":{pincode:"560094",zoneId:"blr-north",city:"Bengaluru",area:"Sanjaynagar"},
  "560097":{pincode:"560097",zoneId:"blr-north",city:"Bengaluru",area:"Vidyaranyapura"},
  // blr-west
  "560010":{pincode:"560010",zoneId:"blr-west",city:"Bengaluru",area:"Rajajinagar"},
  "560015":{pincode:"560015",zoneId:"blr-west",city:"Bengaluru",area:"Peenya"},
  "560018":{pincode:"560018",zoneId:"blr-west",city:"Bengaluru",area:"Chamarajpet"},
  "560021":{pincode:"560021",zoneId:"blr-west",city:"Bengaluru",area:"Srirampuram"},
  "560022":{pincode:"560022",zoneId:"blr-west",city:"Bengaluru",area:"Prakash Nagar"},
  "560023":{pincode:"560023",zoneId:"blr-west",city:"Bengaluru",area:"Govindarajanagar"},
  "560026":{pincode:"560026",zoneId:"blr-west",city:"Bengaluru",area:"Bapujinagar"},
  "560040":{pincode:"560040",zoneId:"blr-west",city:"Bengaluru",area:"Vijayanagar"},
  "560055":{pincode:"560055",zoneId:"blr-west",city:"Bengaluru",area:"Malleswaram West"},
  "560058":{pincode:"560058",zoneId:"blr-west",city:"Bengaluru",area:"Peenya Industrial"},
  "560059":{pincode:"560059",zoneId:"blr-west",city:"Bengaluru",area:"Kengeri"},
  "560072":{pincode:"560072",zoneId:"blr-west",city:"Bengaluru",area:"Nagarbhavi"},
  "560079":{pincode:"560079",zoneId:"blr-west",city:"Bengaluru",area:"Basaveshwaranagar"},
  "560086":{pincode:"560086",zoneId:"blr-west",city:"Bengaluru",area:"Mahalakshmi Layout"},
  "560091":{pincode:"560091",zoneId:"blr-west",city:"Bengaluru",area:"Kengeri Satellite Town"},
  "560098":{pincode:"560098",zoneId:"blr-west",city:"Bengaluru",area:"Rajarajeshwari Nagar"},
};

/** The exact, operations-reviewed Bengaluru coverage advertised by UAT. */
export const BENGALURU_SUPPORTED_PINCODES=Object.freeze(Object.keys(PINCODE_ZONE_MAP).sort());

export const SERVICE_ZONES:Record<string,ServiceZone>={
  "blr-east":{zoneId:"blr-east",zoneName:"East Bengaluru",description:"Indiranagar, Whitefield, Marathahalli, Bellandur",color:"#00BCD4",serviceAvailable:true},
  "blr-north":{zoneId:"blr-north",zoneName:"North Bengaluru",description:"Hebbal, Yelahanka, Malleswaram, RT Nagar",color:"#FF9800",serviceAvailable:true},
  "blr-west":{zoneId:"blr-west",zoneName:"West Bengaluru",description:"Rajajinagar, Vijayanagar, Nagarbhavi, RR Nagar",color:"#4CAF50",serviceAvailable:true},
  "blr-south":{zoneId:"blr-south",zoneName:"South Bengaluru",description:"Koramangala, HSR Layout, JP Nagar, Jayanagar, BTM",color:"#9C27B0",serviceAvailable:true},
  "blr-central":{zoneId:"blr-central",zoneName:"Central Bengaluru",description:"CBD, Shivajinagar, Ulsoor",color:"#E91E63",serviceAvailable:true},
};

export async function ensureServiceZonesTables(db:Db){
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS service_zone_mappings (pincode TEXT PRIMARY KEY, zone_id TEXT NOT NULL, city TEXT NOT NULL, area TEXT NOT NULL, created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS service_zone_area_idx ON service_zone_mappings(zone_id,city)"),
  ]);
}

export async function resolveZoneByPincode(db:Db,pincode:string):Promise<{zone:ServiceZone;assignment:ZoneAssignment}|null>{
  await ensureServiceZonesTables(db);
  const normalized=pincode.replace(/\D/g,"").slice(0,6);

  // First try in-memory lookup
  const assignment=PINCODE_ZONE_MAP[normalized];
  if(assignment){
    const zone=SERVICE_ZONES[assignment.zoneId];
    if(zone)return{zone,assignment};
  }

  // Fallback to database query (for custom/extended zones)
  const row=await db.prepare("SELECT zone_id,city,area FROM service_zone_mappings WHERE pincode=?").bind(normalized).first<Row>();
  if(row){
    const zone=SERVICE_ZONES[String(row.zone_id)];
    if(zone){
      const assignment:ZoneAssignment={pincode:normalized,zoneId:String(row.zone_id),city:String(row.city||"Bengaluru"),area:String(row.area||"")};
      return{zone,assignment};
    }
  }

  // Fail closed. A broad city range is not proof that Operations can fulfil a particular pincode.
  // New coverage becomes bookable only after an explicit service-zone mapping is reviewed.
  return null;
}

export async function listServiceZones(db:Db):Promise<ServiceZone[]>{
  await ensureServiceZonesTables(db);
  return Object.values(SERVICE_ZONES);
}

export async function seedDefaultZones(db:Db){
  await ensureServiceZonesTables(db);
  const now=Date.now();
  const entries=Object.values(PINCODE_ZONE_MAP);
  const batch=entries.map(entry=>
    db.prepare("INSERT INTO service_zone_mappings (pincode,zone_id,city,area,created_at) VALUES (?,?,?,?,?) ON CONFLICT(pincode) DO NOTHING")
      .bind(entry.pincode,entry.zoneId,entry.city,entry.area,now)
  );
  if(batch.length>0)await db.batch(batch);
}
