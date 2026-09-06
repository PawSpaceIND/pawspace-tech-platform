import{authError,requirePermission,requireProviderOwnership,resolveActor}from"../../../lib/server-auth";
import{sanitizeProviderDetail}from"../../../lib/provider-pii-sanitizer";

type Db=Awaited<ReturnType<typeof database>>;
type Row=Record<string,unknown>;

const json=(value:unknown,status=200)=>Response.json(value,{status});
async function database(){const{env}=await import("cloudflare:workers");return env.DB;}

async function ensureTables(db:Db){await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'uat_customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT NOT NULL,breed TEXT,vaccination_status TEXT NOT NULL DEFAULT 'not_provided',source_pet_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS grooming_service_proof (booking_id TEXT PRIMARY KEY,before_photo_ref TEXT,after_photo_ref TEXT,checklist_json TEXT NOT NULL DEFAULT '[]',completion_notes TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_invoices (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,invoice_number TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'draft',currency TEXT NOT NULL DEFAULT 'INR',gross_amount REAL NOT NULL,tax_amount REAL NOT NULL DEFAULT 0,net_amount REAL NOT NULL,issued_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
]);}

function maskPhone(value:unknown){const digits=String(value||"").replace(/\D/g,"");return digits.length>=4?`+91 ••••••${digits.slice(-4)}`:"Masked";}
// Partners get the customer's FIRST NAME only - full names, phone numbers and emails are customer
// contact data and must never leave the customer surface unmasked.
function partnerFirstName(value:unknown){const first=String(value||"").trim().split(/\s+/)[0];return first||"Customer";}
function parseJson<T>(value:unknown,fallback:T):T{try{return JSON.parse(String(value??"")) as T;}catch{return fallback;}}

export async function GET(request:Request){
  try{
    const actor=await resolveActor(request);requirePermission(actor,"bookings.view");
    const providerId=new URL(request.url).searchParams.get("providerId")?.trim();
    if(!providerId)return json({error:"Provider ID is required"},400);
    const db=await database();await ensureTables(db);await requireProviderOwnership(db,actor,providerId);
    const rows=await db.prepare(`SELECT w.id work_order_id,w.booking_id,w.provider_id,w.provider_name,w.provider_model,w.status work_order_status,w.occurrence_count,
      b.status booking_status,b.package_code,b.package_name,b.zone_id,b.city_id,b.scheduled_start,b.scheduled_end,b.total_amount,b.currency,b.pricing_json,b.customer_id,b.pet_ids_json,
      c.name customer_name,c.primary_phone,p.method payment_method,p.mode payment_mode,p.status payment_status,p.amount payment_amount,p.amount_due_now
      FROM provider_work_orders w
      JOIN canonical_bookings b ON b.id=w.booking_id
      JOIN canonical_customers c ON c.id=b.customer_id
      JOIN booking_payments p ON p.booking_id=b.id
      WHERE w.provider_id=? AND w.service_code='grooming'
      ORDER BY b.scheduled_start ASC LIMIT 100`).bind(providerId).all<Row>();
    const jobs=[];
    for(const row of rows.results){
      const[pets,events,proof,invoice]=await Promise.all([
        db.prepare("SELECT id,name,species,breed,vaccination_status FROM canonical_pets WHERE customer_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY name").bind(row.customer_id,row.pet_ids_json).all<Row>(),
        db.prepare("SELECT event_type,entity_type,actor_id,detail_json,occurred_at FROM booking_lifecycle_events WHERE booking_id=? ORDER BY occurred_at DESC LIMIT 50").bind(row.booking_id).all<Row>(),
        db.prepare("SELECT before_photo_ref,after_photo_ref,checklist_json,completion_notes,updated_at FROM grooming_service_proof WHERE booking_id=?").bind(row.booking_id).first<Row>(),
        db.prepare("SELECT invoice_number,status,net_amount,issued_at FROM booking_invoices WHERE booking_id=?").bind(row.booking_id).first<Row>(),
      ]);
      const pricing=parseJson<Record<string,unknown>>(row.pricing_json,{});
      const addOns=Array.isArray(pricing.addOns)?pricing.addOns.filter((item):item is string=>typeof item==="string"):[];
      const safetyRequirements=Array.isArray(pricing.requirements)?pricing.requirements.filter((item):item is string=>typeof item==="string"):[];
      jobs.push({
        bookingId:String(row.booking_id),workOrderId:String(row.work_order_id),providerId:String(row.provider_id),providerName:String(row.provider_name),providerModel:String(row.provider_model),
        status:String(row.booking_status),workOrderStatus:String(row.work_order_status),occurrenceCount:Number(row.occurrence_count||1),packageCode:String(row.package_code),packageName:String(row.package_name),
        zoneId:String(row.zone_id),cityId:String(row.city_id),scheduledStart:String(row.scheduled_start),scheduledEnd:String(row.scheduled_end),totalAmount:Number(row.total_amount||0),currency:String(row.currency||"INR"),
        customer:{id:String(row.customer_id),name:partnerFirstName(row.customer_name),maskedPhone:maskPhone(row.primary_phone)},
        pets:pets.results.map(pet=>({id:String(pet.id),name:String(pet.name),species:String(pet.species),breed:String(pet.breed||""),vaccinationStatus:String(pet.vaccination_status)})),
        payment:{method:String(row.payment_method),mode:String(row.payment_mode),status:String(row.payment_status),amount:Number(row.payment_amount||0),amountDueNow:Number(row.amount_due_now||0)},
        subscription:pricing.subscription?String(pricing.subscription):null,
        addOns,
        safetyRequirements,
        proof:proof?{beforePhotoRef:proof.before_photo_ref?String(proof.before_photo_ref):null,afterPhotoRef:proof.after_photo_ref?String(proof.after_photo_ref):null,checklist:parseJson<string[]>(proof.checklist_json,[]),completionNotes:proof.completion_notes?String(proof.completion_notes):null,updatedAt:Number(proof.updated_at||0)}:null,
        invoice:invoice?{invoiceNumber:String(invoice.invoice_number),status:String(invoice.status),netAmount:Number(invoice.net_amount||0),issuedAt:Number(invoice.issued_at||0)}:null,
        events:events.results.map(item=>({eventType:String(item.event_type),entityType:String(item.entity_type),actorId:String(item.actor_id),detail:sanitizeProviderDetail(parseJson<Record<string,unknown>>(item.detail_json,{})),occurredAt:Number(item.occurred_at||0)})),
      });
    }
    return json({source:"canonical UAT provider work orders",providerId,jobs});
  }catch(error){return authError(error,"Unable to load Partner Grooming jobs");}
}
