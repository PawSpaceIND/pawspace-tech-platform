type Db=D1Database;
type Row=Record<string,unknown>;

export type ServiceZone={zoneId:string;zoneName:string;description:string;color:string;serviceAvailable:boolean};
export type ZoneAssignment={pincode:string;zoneId:string;city:string;area:string};

// Bengaluru service zone mapping: pincode -> zone
// Zones: blr-east, blr-west, blr-north, blr-south, blr-central
const PINCODE_ZONE_MAP:Record<string,ZoneAssignment>={
  // East (560034, 560037, 560040, 560042, 560046, 560047)
  "560034":{pincode:"560034",zoneId:"blr-east",city:"Bengaluru",area:"Indiranagar"},
  "560037":{pincode:"560037",zoneId:"blr-east",city:"Bengaluru",area:"Indira Nagar"},
  "560040":{pincode:"560040",zoneId:"blr-east",city:"Bengaluru",area:"Bangalore East"},
  "560042":{pincode:"560042",zoneId:"blr-east",city:"Bengaluru",area:"Horamavu"},
  "560046":{pincode:"560046",zoneId:"blr-east",city:"Bengaluru",area:"Varthur"},
  "560047":{pincode:"560047",zoneId:"blr-east",city:"Bengaluru",area:"CV Raman Nagar"},

  // North (560003, 560009, 560010, 560032, 560033, 560048)
  "560003":{pincode:"560003",zoneId:"blr-north",city:"Bengaluru",area:"Kingfisher Road"},
  "560009":{pincode:"560009",zoneId:"blr-north",city:"Bengaluru",area:"Vijayanagar"},
  "560010":{pincode:"560010",zoneId:"blr-north",city:"Bengaluru",area:"Yeshwanthpur"},
  "560032":{pincode:"560032",zoneId:"blr-north",city:"Bengaluru",area:"Hebbal"},
  "560033":{pincode:"560033",zoneId:"blr-north",city:"Bengaluru",area:"Nagavara"},
  "560048":{pincode:"560048",zoneId:"blr-north",city:"Bengaluru",area:"Whitefield"},

  // West (560004, 560005, 560006, 560018, 560022, 560030)
  "560004":{pincode:"560004",zoneId:"blr-west",city:"Bengaluru",area:"Kumara Park"},
  "560005":{pincode:"560005",zoneId:"blr-west",city:"Bengaluru",area:"Malleshwaram"},
  "560006":{pincode:"560006",zoneId:"blr-west",city:"Bengaluru",area:"Sadashivnagar"},
  "560018":{pincode:"560018",zoneId:"blr-west",city:"Bengaluru",area:"Koramangala"},
  "560022":{pincode:"560022",zoneId:"blr-west",city:"Bengaluru",area:"Jayanagar"},
  "560030":{pincode:"560030",zoneId:"blr-west",city:"Bengaluru",area:"Basaveshwaranagar"},

  // South (560002, 560019, 560023, 560025, 560029, 560078)
  "560002":{pincode:"560002",zoneId:"blr-south",city:"Bengaluru",area:"Whitehall"},
  "560019":{pincode:"560019",zoneId:"blr-south",city:"Bengaluru",area:"Bannerghatta"},
  "560023":{pincode:"560023",zoneId:"blr-south",city:"Bengaluru",area:"Banashankari"},
  "560025":{pincode:"560025",zoneId:"blr-south",city:"Bengaluru",area:"Rajarajeshwari Nagar"},
  "560029":{pincode:"560029",zoneId:"blr-south",city:"Bengaluru",area:"Kanakpura Road"},
  "560078":{pincode:"560078",zoneId:"blr-south",city:"Bengaluru",area:"Bommanahalli"},

  // Central (560001, 560007, 560008, 560011, 560012, 560024)
  "560001":{pincode:"560001",zoneId:"blr-central",city:"Bengaluru",area:"Central Business District"},
  "560007":{pincode:"560007",zoneId:"blr-central",city:"Bengaluru",area:"Shivajinagar"},
  "560008":{pincode:"560008",zoneId:"blr-central",city:"Bengaluru",area:"Frazer Town"},
  "560011":{pincode:"560011",zoneId:"blr-central",city:"Bengaluru",area:"Rajajinagar"},
  "560012":{pincode:"560012",zoneId:"blr-central",city:"Bengaluru",area:"Mathikere"},
  "560024":{pincode:"560024",zoneId:"blr-central",city:"Bengaluru",area:"Ulsoor"},
};

export const SERVICE_ZONES:Record<string,ServiceZone>={
  "blr-east":{zoneId:"blr-east",zoneName:"East Bengaluru",description:"Indiranagar, Varthur, CV Raman Nagar",color:"#00BCD4",serviceAvailable:true},
  "blr-north":{zoneId:"blr-north",zoneName:"North Bengaluru",description:"Whitefield, Hebbal, Yeshwanthpur",color:"#FF9800",serviceAvailable:true},
  "blr-west":{zoneId:"blr-west",zoneName:"West Bengaluru",description:"Koramangala, Jayanagar, Malleshwaram",color:"#4CAF50",serviceAvailable:true},
  "blr-south":{zoneId:"blr-south",zoneName:"South Bengaluru",description:"Bannerghatta, Banashankari, Bommanahalli",color:"#9C27B0",serviceAvailable:true},
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
