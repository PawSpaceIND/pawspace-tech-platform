/**
 * CMS / Content / Feature Controls - the "CMS / Offers / Content / Feature Controls" row of the
 * business gap check (P1).
 *
 * Content blocks are versioned, placement-scoped copy (home banner / service page / FAQ /
 * announcement), optionally narrowed to a city or service, with an explicit publish window. The
 * PUBLIC read serves ONLY published, in-window blocks - drafts, archived blocks and expired copy
 * can never leak to the customer app. Feature controls are governed flags with city/service
 * rollout scopes and an audit trail; evaluation is server-side so the app never guesses. Editing
 * a published block bumps its version, so every live copy change is traceable.
 */

type Db=D1Database;
type Row=Record<string,unknown>;

export type ContentPlacement="home_banner"|"service_page"|"faq"|"announcement";
export type ContentBlockInput={id?:string;title:string;bodyMd:string;placement:ContentPlacement;serviceCode?:string|null;cityId?:string|null;validFrom?:number|null;validUntil?:number|null;actorId:string};

const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
const PLACEMENTS=new Set<ContentPlacement>(["home_banner","service_page","faq","announcement"]);
const parse=<T>(value:unknown,fallback:T):T=>{try{return JSON.parse(String(value??"")) as T}catch{return fallback}};

export async function ensureContentControlTables(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS cms_content_blocks (id TEXT PRIMARY KEY,title TEXT NOT NULL,body_md TEXT NOT NULL,placement TEXT NOT NULL,service_code TEXT,city_id TEXT,status TEXT NOT NULL DEFAULT 'draft',version INTEGER NOT NULL DEFAULT 1,valid_from INTEGER,valid_until INTEGER,updated_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_cms_blocks_public ON cms_content_blocks(status,placement)"),
 db.prepare("CREATE TABLE IF NOT EXISTS feature_controls (key TEXT PRIMARY KEY,description TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,city_ids_json TEXT NOT NULL DEFAULT '[]',service_codes_json TEXT NOT NULL DEFAULT '[]',updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS content_control_events (id TEXT PRIMARY KEY,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
]);}

async function controlEvent(db:Db,entityType:string,entityId:string,eventType:string,actorId:string,detail:unknown={}){await db.prepare("INSERT INTO content_control_events (id,entity_type,entity_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?)").bind(crypto.randomUUID(),entityType,entityId,eventType,actorId,JSON.stringify(detail),Date.now()).run();}
function requireText(value:unknown,name:string,min=3){const text=String(value||"").trim();if(text.length<min)throw new Response(`${name} is required`,{status:400});return text;}

/** Create or edit a block. Editing a PUBLISHED block bumps its version so live copy changes are traceable. */
export async function saveContentBlock(db:Db,input:ContentBlockInput){
 await ensureContentControlTables(db);
 const title=requireText(input.title,"Content title"),bodyMd=requireText(input.bodyMd,"Content body",5);
 if(!PLACEMENTS.has(input.placement))throw new Response("Placement must be home_banner, service_page, faq or announcement",{status:400});
 const validFrom=input.validFrom==null?null:Number(input.validFrom),validUntil=input.validUntil==null?null:Number(input.validUntil);
 if((validFrom!=null&&!Number.isFinite(validFrom))||(validUntil!=null&&!Number.isFinite(validUntil)))throw new Response("Publish window timestamps must be numbers",{status:400});
 if(validFrom!=null&&validUntil!=null&&validUntil<=validFrom)throw new Response("The publish window must end after it starts",{status:400});
 const now=Date.now();
 if(input.id){
  const existing=await db.prepare("SELECT * FROM cms_content_blocks WHERE id=?").bind(input.id).first<Row>();
  if(!existing)throw new Response("Content block not found",{status:404});
  if(String(existing.status)==="archived")throw new Response("An archived content block cannot be edited",{status:409});
  const nextVersion=String(existing.status)==="published"?Number(existing.version)+1:Number(existing.version);
  await db.prepare("UPDATE cms_content_blocks SET title=?,body_md=?,placement=?,service_code=?,city_id=?,version=?,valid_from=?,valid_until=?,updated_by=?,updated_at=? WHERE id=?")
   .bind(title,bodyMd,input.placement,input.serviceCode||null,input.cityId||null,nextVersion,validFrom,validUntil,input.actorId,now,input.id).run();
  await controlEvent(db,"content_block",input.id,nextVersion>Number(existing.version)?"republished":"updated",input.actorId,{version:nextVersion});
  return{blockId:input.id,version:nextVersion,status:String(existing.status)};
 }
 const id=uid("CMS");
 await db.prepare("INSERT INTO cms_content_blocks (id,title,body_md,placement,service_code,city_id,status,version,valid_from,valid_until,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,'draft',1,?,?,?,?,?)")
  .bind(id,title,bodyMd,input.placement,input.serviceCode||null,input.cityId||null,validFrom,validUntil,input.actorId,now,now).run();
 await controlEvent(db,"content_block",id,"created",input.actorId,{placement:input.placement});
 return{blockId:id,version:1,status:"draft"};
}

export async function setContentBlockStatus(db:Db,input:{blockId:string;status:"published"|"archived";actorId:string}){
 await ensureContentControlTables(db);
 const block=await db.prepare("SELECT id,status FROM cms_content_blocks WHERE id=?").bind(String(input.blockId||"")).first<Row>();
 if(!block)throw new Response("Content block not found",{status:404});
 if(String(block.status)===input.status)return{blockId:String(block.id),status:input.status,duplicatePrevented:true};
 if(input.status==="published"&&String(block.status)==="archived")throw new Response("An archived content block cannot be republished; create a new block",{status:409});
 await db.prepare("UPDATE cms_content_blocks SET status=?,updated_at=? WHERE id=?").bind(input.status,Date.now(),block.id).run();
 await controlEvent(db,"content_block",String(block.id),input.status,input.actorId);
 return{blockId:String(block.id),status:input.status,duplicatePrevented:false};
}

export async function setFeatureControl(db:Db,input:{key:string;description:string;enabled:boolean;cityIds?:string[];serviceCodes?:string[];actorId:string}){
 await ensureContentControlTables(db);
 const key=requireText(input.key,"Feature key").toLowerCase().replace(/\s+/g,"_");
 const description=requireText(input.description,"Feature description",5);
 const cityIds=(input.cityIds||[]).map(city=>String(city).trim()).filter(Boolean);
 const serviceCodes=(input.serviceCodes||[]).map(service=>String(service).trim()).filter(Boolean);
 await db.prepare("INSERT INTO feature_controls (key,description,enabled,city_ids_json,service_codes_json,updated_by,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET description=excluded.description,enabled=excluded.enabled,city_ids_json=excluded.city_ids_json,service_codes_json=excluded.service_codes_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
  .bind(key,description,input.enabled?1:0,JSON.stringify(cityIds),JSON.stringify(serviceCodes),input.actorId,Date.now()).run();
 await controlEvent(db,"feature_control",key,input.enabled?"enabled":"disabled",input.actorId,{cityIds,serviceCodes});
 return{key,enabled:input.enabled,cityIds,serviceCodes};
}

/** Server-side flag evaluation: enabled AND inside the rollout scope (empty scope = everywhere). */
export async function featureEnabled(db:Db,key:string,context:{cityId?:string;serviceCode?:string}={}){
 await ensureContentControlTables(db);
 const row=await db.prepare("SELECT * FROM feature_controls WHERE key=?").bind(String(key||"").toLowerCase()).first<Row>();
 if(!row||Number(row.enabled)!==1)return false;
 const cityIds=parse<string[]>(row.city_ids_json,[]),serviceCodes=parse<string[]>(row.service_codes_json,[]);
 if(cityIds.length&&(!context.cityId||!cityIds.includes(context.cityId)))return false;
 if(serviceCodes.length&&(!context.serviceCode||!serviceCodes.includes(context.serviceCode)))return false;
 return true;
}

/** PUBLIC read: only published blocks inside their window and matching the scope - drafts,
 *  archived blocks and expired copy can never leak. */
export async function publicContent(db:Db,input:{placement?:string;cityId?:string;serviceCode?:string;now?:number}={}){
 await ensureContentControlTables(db);
 const now=input.now??Date.now();
 const rows=await db.prepare("SELECT id,title,body_md,placement,service_code,city_id,version,valid_from,valid_until FROM cms_content_blocks WHERE status='published' ORDER BY updated_at DESC LIMIT 200").all<Row>();
 const blocks=rows.results
  .filter(row=>!input.placement||String(row.placement)===input.placement)
  .filter(row=>row.city_id==null||String(row.city_id)===String(input.cityId||""))
  .filter(row=>row.service_code==null||String(row.service_code)===String(input.serviceCode||""))
  .filter(row=>(row.valid_from==null||Number(row.valid_from)<=now)&&(row.valid_until==null||Number(row.valid_until)>now))
  .map(row=>({id:String(row.id),title:String(row.title),bodyMd:String(row.body_md),placement:String(row.placement),serviceCode:row.service_code?String(row.service_code):null,cityId:row.city_id?String(row.city_id):null,version:Number(row.version)}));
 const flags=await db.prepare("SELECT key,enabled,city_ids_json,service_codes_json FROM feature_controls WHERE enabled=1 ORDER BY key").all<Row>();
 const features:Record<string,boolean>={};
 for(const row of flags.results){
  const cityIds=parse<string[]>(row.city_ids_json,[]),serviceCodes=parse<string[]>(row.service_codes_json,[]);
  const cityOk=!cityIds.length||(Boolean(input.cityId)&&cityIds.includes(String(input.cityId)));
  const serviceOk=!serviceCodes.length||(Boolean(input.serviceCode)&&serviceCodes.includes(String(input.serviceCode)));
  if(cityOk&&serviceOk)features[String(row.key)]=true;
 }
 return{blocks,features,generatedAt:now};
}

/** Staff overview: everything including drafts, with the audit trail. */
export async function contentControlsOverview(db:Db){
 await ensureContentControlTables(db);
 const[blocks,flags,events]=await Promise.all([
  db.prepare("SELECT * FROM cms_content_blocks ORDER BY updated_at DESC LIMIT 200").all<Row>(),
  db.prepare("SELECT * FROM feature_controls ORDER BY key").all<Row>(),
  db.prepare("SELECT * FROM content_control_events ORDER BY created_at DESC LIMIT 100").all<Row>(),
 ]);
 return{blocks:blocks.results,features:flags.results.map(row=>({...row,cityIds:parse<string[]>(row.city_ids_json,[]),serviceCodes:parse<string[]>(row.service_codes_json,[])})),events:events.results,metrics:{published:blocks.results.filter(row=>String(row.status)==="published").length,draft:blocks.results.filter(row=>String(row.status)==="draft").length,enabledFeatures:flags.results.filter(row=>Number(row.enabled)===1).length},truth:{publicReadServesPublishedOnly:true,flagEvaluationServerSide:true,productionReady:false}};
}
