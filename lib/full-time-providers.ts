// Which providers are full-time. Owner decision 7 (26 Sept 2026): full-time providers are contractors paid
// a monthly fixed fee, an incentive and petrol through lib/contractor-pay.ts, and are never paid commission.
// A provider counts as full-time when any canonical provider record says so: the capacity profile's
// provider_model or contract_type, or an active legacy compensation profile. Any one of them is enough, so a
// record that disagrees can only keep a full-time provider OUT of commission, never pay them twice.
type Db=D1Database;type Row=Record<string,unknown>;
async function columns(db:Db,table:string){return new Set(((await db.prepare(`PRAGMA table_info(${table})`).all<Row>()).results||[]).map(r=>String(r.name)));}
// A table or column that was never created is simply not a source. A table that exists but cannot be read
// throws instead of answering "nobody is full-time", which would let a full-time provider be paid commission.
export async function fullTimeProviderIds(db:Db){
 const[capacity,compensation]=await Promise.all([columns(db,"provider_capacity_profiles"),columns(db,"provider_compensation_profiles")]),reads:string[]=[];
 if(capacity.has("provider_model"))reads.push(`SELECT id provider_id FROM provider_capacity_profiles WHERE provider_model='full_time'${capacity.has("contract_type")?" OR contract_type='full_time'":""}`);
 if(compensation.has("engagement_model")&&compensation.has("status"))reads.push("SELECT provider_id FROM provider_compensation_profiles WHERE status='active' AND engagement_model='full_time'");
 const found=await Promise.all(reads.map(async sql=>((await db.prepare(sql).all<Row>()).results||[]).map(r=>String(r.provider_id??"").trim()).filter(Boolean)));
 return new Set(found.flat());
}
