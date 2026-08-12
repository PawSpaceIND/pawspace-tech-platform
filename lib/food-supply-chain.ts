/**
 * Fresh Food supply chain - the inventory/procurement/batch module the business gap check called
 * for: SKU -> supplier -> purchase order -> stock -> batch -> preparation date -> expiry ->
 * wastage -> reorder -> kitchen -> delivery zone.
 *
 * Additive on top of the existing Food governance: receiving a purchase order creates a dated
 * batch and atomically raises the SAME food_inventory_uat counters the customer quote/order path
 * reads, so procurement immediately becomes sellable availability. Wastage and expiry take stock
 * OUT through guarded decrements that can never drive a batch or the zone inventory negative, and
 * every movement is idempotent (UNIQUE idempotency keys / one auto-wastage per expired batch).
 * Reorder is a governed suggestion (policy threshold vs live available-reserved), never an
 * automatic purchase.
 */

import{ensureFoodGovernanceTables}from"./food-governance";

type Db=D1Database;
type Row=Record<string,unknown>;

const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
const today=()=>new Date().toISOString().slice(0,10);

export async function ensureFoodSupplyChainTables(db:Db){await ensureFoodGovernanceTables(db);await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS food_suppliers (id TEXT PRIMARY KEY,name TEXT NOT NULL,contact_phone TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS food_kitchens (id TEXT PRIMARY KEY,name TEXT NOT NULL,zone_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS food_purchase_orders (id TEXT PRIMARY KEY,supplier_id TEXT NOT NULL,kitchen_id TEXT,sku TEXT NOT NULL,zone_id TEXT NOT NULL,quantity INTEGER NOT NULL,unit_cost REAL NOT NULL,status TEXT NOT NULL DEFAULT 'ordered',expected_at TEXT,received_at INTEGER,idempotency_key TEXT NOT NULL UNIQUE,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS food_stock_batches (id TEXT PRIMARY KEY,purchase_order_id TEXT NOT NULL UNIQUE,supplier_id TEXT NOT NULL,kitchen_id TEXT,sku TEXT NOT NULL,zone_id TEXT NOT NULL,quantity_received INTEGER NOT NULL,quantity_remaining INTEGER NOT NULL,unit_cost REAL NOT NULL,preparation_date TEXT NOT NULL,expiry_date TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'available',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_food_batches_expiry ON food_stock_batches(status,expiry_date)"),
 db.prepare("CREATE TABLE IF NOT EXISTS food_wastage_events (id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,sku TEXT NOT NULL,zone_id TEXT NOT NULL,quantity INTEGER NOT NULL,reason TEXT NOT NULL,source TEXT NOT NULL DEFAULT 'manual',recorded_by TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS food_reorder_policies (sku TEXT NOT NULL,zone_id TEXT NOT NULL,min_available_units INTEGER NOT NULL,reorder_quantity INTEGER NOT NULL,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(sku,zone_id))"),
]);}

function requirePositiveInt(value:unknown,name:string){const parsed=Math.floor(Number(value));if(!Number.isFinite(parsed)||parsed<1)throw new Response(`${name} must be a positive whole number`,{status:400});return parsed;}
function requireText(value:unknown,name:string,min=2){const text=String(value||"").trim();if(text.length<min)throw new Response(`${name} is required`,{status:400});return text;}
const DATE=/^\d{4}-\d{2}-\d{2}$/;
function requireDate(value:unknown,name:string){const text=String(value||"").trim();if(!DATE.test(text))throw new Response(`${name} must be a YYYY-MM-DD date`,{status:400});return text;}

export async function saveFoodSupplier(db:Db,input:{id?:string;name:string;contactPhone:string;status?:"active"|"paused";actorId:string}){
 await ensureFoodSupplyChainTables(db);
 const name=requireText(input.name,"Supplier name"),phone=requireText(input.contactPhone,"Supplier contact phone",8),status=input.status==="paused"?"paused":"active",now=Date.now(),id=String(input.id||uid("FSUP"));
 await db.prepare("INSERT INTO food_suppliers (id,name,contact_phone,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,contact_phone=excluded.contact_phone,status=excluded.status,updated_at=excluded.updated_at").bind(id,name,phone,status,input.actorId,now,now).run();
 return{supplierId:id,name,status};
}

export async function saveFoodKitchen(db:Db,input:{id?:string;name:string;zoneId:string;status?:"active"|"paused";actorId:string}){
 await ensureFoodSupplyChainTables(db);
 const name=requireText(input.name,"Kitchen name"),zoneId=requireText(input.zoneId,"Delivery zone"),status=input.status==="paused"?"paused":"active",now=Date.now(),id=String(input.id||uid("FKIT"));
 await db.prepare("INSERT INTO food_kitchens (id,name,zone_id,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,zone_id=excluded.zone_id,status=excluded.status,updated_at=excluded.updated_at").bind(id,name,zoneId,status,input.actorId,now,now).run();
 return{kitchenId:id,name,zoneId,status};
}

export async function createFoodPurchaseOrder(db:Db,input:{supplierId:string;kitchenId?:string;sku:string;zoneId:string;quantity:number;unitCost:number;expectedAt?:string;idempotencyKey:string;actorId:string}){
 await ensureFoodSupplyChainTables(db);
 const idempotencyKey=requireText(input.idempotencyKey,"Idempotency key",4);
 const prior=await db.prepare("SELECT id,status FROM food_purchase_orders WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
 if(prior)return{purchaseOrderId:String(prior.id),status:String(prior.status),duplicatePrevented:true};
 const supplier=await db.prepare("SELECT id,status FROM food_suppliers WHERE id=?").bind(requireText(input.supplierId,"Supplier")).first<Row>();
 if(!supplier)throw new Response("Supplier not found",{status:404});
 if(String(supplier.status)!=="active")throw new Response("A paused supplier cannot take purchase orders",{status:409});
 const sku=requireText(input.sku,"SKU"),zoneId=requireText(input.zoneId,"Delivery zone");
 const item=await db.prepare("SELECT sku FROM food_catalogue_items WHERE sku=?").bind(sku).first<Row>();
 if(!item)throw new Response("SKU is not in the Food catalogue",{status:404});
 if(input.kitchenId){const kitchen=await db.prepare("SELECT id,status FROM food_kitchens WHERE id=?").bind(input.kitchenId).first<Row>();if(!kitchen)throw new Response("Kitchen not found",{status:404});if(String(kitchen.status)!=="active")throw new Response("A paused kitchen cannot receive stock",{status:409});}
 const quantity=requirePositiveInt(input.quantity,"Order quantity");
 const unitCost=Number(input.unitCost);if(!Number.isFinite(unitCost)||unitCost<=0)throw new Response("Unit cost must be a positive amount",{status:400});
 const expectedAt=input.expectedAt?requireDate(input.expectedAt,"Expected date"):null;
 const now=Date.now(),id=uid("FPO");
 await db.prepare("INSERT INTO food_purchase_orders (id,supplier_id,kitchen_id,sku,zone_id,quantity,unit_cost,status,expected_at,idempotency_key,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'ordered',?,?,?,?,?)").bind(id,input.supplierId,input.kitchenId??null,sku,zoneId,quantity,unitCost,expectedAt,idempotencyKey,input.actorId,now,now).run();
 return{purchaseOrderId:id,status:"ordered",quantity,unitCost,duplicatePrevented:false};
}

/** Receiving is the ONLY way procurement becomes sellable stock: atomically claims the PO
 *  (ordered -> received), creates the dated batch, and raises the zone inventory the customer
 *  quote path reads. A lost race or replay returns the already-received truth, never double stock. */
export async function receiveFoodPurchaseOrder(db:Db,input:{purchaseOrderId:string;preparationDate:string;expiryDate:string;actorId:string}){
 await ensureFoodSupplyChainTables(db);
 const preparationDate=requireDate(input.preparationDate,"Preparation date"),expiryDate=requireDate(input.expiryDate,"Expiry date");
 if(expiryDate<=preparationDate)throw new Response("Expiry must be after the preparation date",{status:400});
 const po=await db.prepare("SELECT * FROM food_purchase_orders WHERE id=?").bind(String(input.purchaseOrderId||"")).first<Row>();
 if(!po)throw new Response("Purchase order not found",{status:404});
 if(String(po.status)==="received"){const batch=await db.prepare("SELECT id FROM food_stock_batches WHERE purchase_order_id=?").bind(po.id).first<Row>();return{purchaseOrderId:String(po.id),batchId:String(batch?.id||""),status:"received",duplicatePrevented:true};}
 if(String(po.status)!=="ordered")throw new Response(`A ${String(po.status)} purchase order cannot be received`,{status:409});
 const now=Date.now();
 const claimed=await db.prepare("UPDATE food_purchase_orders SET status='received',received_at=?,updated_at=? WHERE id=? AND status='ordered'").bind(now,now,po.id).run();
 if(!Number(claimed.meta?.changes||0)){const batch=await db.prepare("SELECT id FROM food_stock_batches WHERE purchase_order_id=?").bind(po.id).first<Row>();return{purchaseOrderId:String(po.id),batchId:String(batch?.id||""),status:"received",duplicatePrevented:true};}
 const batchId=uid("FBAT"),quantity=Number(po.quantity);
 await db.prepare("INSERT INTO food_stock_batches (id,purchase_order_id,supplier_id,kitchen_id,sku,zone_id,quantity_received,quantity_remaining,unit_cost,preparation_date,expiry_date,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'available',?,?)").bind(batchId,po.id,po.supplier_id,po.kitchen_id??null,po.sku,po.zone_id,quantity,quantity,Number(po.unit_cost),preparationDate,expiryDate,now,now).run();
 await db.prepare("INSERT INTO food_inventory_uat (sku,zone_id,available_units,reserved_units,status,updated_at) VALUES (?,?,?,0,'uat_seed',?) ON CONFLICT(sku,zone_id) DO UPDATE SET available_units=available_units+?,updated_at=?").bind(po.sku,po.zone_id,quantity,now,quantity,now).run();
 return{purchaseOrderId:String(po.id),batchId,sku:String(po.sku),zoneId:String(po.zone_id),quantityReceived:quantity,preparationDate,expiryDate,status:"received",duplicatePrevented:false};
}

/** Guarded stock-out: never drives the batch or the zone inventory negative; idempotent per key. */
export async function recordFoodWastage(db:Db,input:{batchId:string;quantity:number;reason:string;idempotencyKey:string;actorId:string;source?:"manual"|"expiry_sweep"}){
 await ensureFoodSupplyChainTables(db);
 const idempotencyKey=requireText(input.idempotencyKey,"Idempotency key",4);
 const prior=await db.prepare("SELECT * FROM food_wastage_events WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
 if(prior)return{wastageId:String(prior.id),batchId:String(prior.batch_id),quantity:Number(prior.quantity),duplicatePrevented:true};
 const reason=requireText(input.reason,"Wastage reason",5),quantity=requirePositiveInt(input.quantity,"Wastage quantity");
 const batch=await db.prepare("SELECT * FROM food_stock_batches WHERE id=?").bind(String(input.batchId||"")).first<Row>();
 if(!batch)throw new Response("Stock batch not found",{status:404});
 const now=Date.now();
 const debited=await db.prepare("UPDATE food_stock_batches SET quantity_remaining=quantity_remaining-?,status=CASE WHEN quantity_remaining-?<=0 THEN 'exhausted' ELSE status END,updated_at=? WHERE id=? AND quantity_remaining>=?").bind(quantity,quantity,now,batch.id,quantity).run();
 if(!Number(debited.meta?.changes||0))throw new Response("Wastage exceeds the batch's remaining quantity",{status:409});
 await db.prepare("UPDATE food_inventory_uat SET available_units=MAX(0,available_units-?),updated_at=? WHERE sku=? AND zone_id=?").bind(quantity,now,batch.sku,batch.zone_id).run();
 const id=uid("FWST");
 await db.prepare("INSERT INTO food_wastage_events (id,batch_id,sku,zone_id,quantity,reason,source,recorded_by,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(id,batch.id,batch.sku,batch.zone_id,quantity,reason,input.source??"manual",input.actorId,idempotencyKey,now).run();
 return{wastageId:id,batchId:String(batch.id),sku:String(batch.sku),quantity,duplicatePrevented:false};
}

/** Expire past-dated batches exactly once: remaining units become auto-wastage (source expiry_sweep). */
export async function sweepExpiredFoodBatches(db:Db,input:{actorId:string;asOfDate?:string}){
 await ensureFoodSupplyChainTables(db);
 const asOf=input.asOfDate?requireDate(input.asOfDate,"As-of date"):today();
 const rows=await db.prepare("SELECT id,quantity_remaining FROM food_stock_batches WHERE status='available' AND expiry_date<? LIMIT 200").bind(asOf).all<Row>();
 let expired=0,unitsWasted=0;
 for(const row of rows.results){
  const now=Date.now();
  const claimed=await db.prepare("UPDATE food_stock_batches SET status='expired',updated_at=? WHERE id=? AND status='available'").bind(now,row.id).run();
  if(!Number(claimed.meta?.changes||0))continue;
  expired++;
  const remaining=Number(row.quantity_remaining||0);
  if(remaining>0){
   const batch=await db.prepare("SELECT sku,zone_id FROM food_stock_batches WHERE id=?").bind(row.id).first<Row>();
   await db.prepare("UPDATE food_inventory_uat SET available_units=MAX(0,available_units-?),updated_at=? WHERE sku=? AND zone_id=?").bind(remaining,now,batch?.sku,batch?.zone_id).run();
   await db.prepare("INSERT OR IGNORE INTO food_wastage_events (id,batch_id,sku,zone_id,quantity,reason,source,recorded_by,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(uid("FWST"),row.id,batch?.sku,batch?.zone_id,remaining,`Expired on ${asOf}`,"expiry_sweep",input.actorId,`expiry:${String(row.id)}`,now).run();
   await db.prepare("UPDATE food_stock_batches SET quantity_remaining=0,updated_at=? WHERE id=?").bind(now,row.id).run();
   unitsWasted+=remaining;
  }
 }
 return{expiredBatches:expired,unitsWasted,asOfDate:asOf};
}

export async function setFoodReorderPolicy(db:Db,input:{sku:string;zoneId:string;minAvailableUnits:number;reorderQuantity:number;actorId:string}){
 await ensureFoodSupplyChainTables(db);
 const sku=requireText(input.sku,"SKU"),zoneId=requireText(input.zoneId,"Delivery zone");
 const minUnits=requirePositiveInt(input.minAvailableUnits,"Minimum available units"),reorderQuantity=requirePositiveInt(input.reorderQuantity,"Reorder quantity");
 await db.prepare("INSERT INTO food_reorder_policies (sku,zone_id,min_available_units,reorder_quantity,updated_by,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(sku,zone_id) DO UPDATE SET min_available_units=excluded.min_available_units,reorder_quantity=excluded.reorder_quantity,updated_by=excluded.updated_by,updated_at=excluded.updated_at").bind(sku,zoneId,minUnits,reorderQuantity,input.actorId,Date.now()).run();
 return{sku,zoneId,minAvailableUnits:minUnits,reorderQuantity};
}

export async function foodSupplyChainSnapshot(db:Db,input:{asOfDate?:string}={}){
 await ensureFoodSupplyChainTables(db);
 const asOf=input.asOfDate?requireDate(input.asOfDate,"As-of date"):today();
 const soon=new Date(new Date(`${asOf}T00:00:00Z`).getTime()+2*86_400_000).toISOString().slice(0,10);
 const[suppliers,kitchens,orders,batches,wastage,policies,inventory]=await Promise.all([
  db.prepare("SELECT * FROM food_suppliers ORDER BY created_at DESC LIMIT 100").all<Row>(),
  db.prepare("SELECT * FROM food_kitchens ORDER BY created_at DESC LIMIT 100").all<Row>(),
  db.prepare("SELECT * FROM food_purchase_orders ORDER BY created_at DESC LIMIT 200").all<Row>(),
  db.prepare("SELECT * FROM food_stock_batches ORDER BY expiry_date LIMIT 200").all<Row>(),
  db.prepare("SELECT * FROM food_wastage_events ORDER BY created_at DESC LIMIT 200").all<Row>(),
  db.prepare("SELECT * FROM food_reorder_policies ORDER BY sku").all<Row>(),
  db.prepare("SELECT sku,zone_id,available_units,reserved_units FROM food_inventory_uat ORDER BY sku").all<Row>(),
 ]);
 const availableBySkuZone=new Map(inventory.results.map(row=>[`${String(row.sku)}:${String(row.zone_id)}`,Math.max(0,Number(row.available_units||0)-Number(row.reserved_units||0))]));
 const reorderSuggestions=policies.results
  .map(policy=>({sku:String(policy.sku),zoneId:String(policy.zone_id),available:availableBySkuZone.get(`${String(policy.sku)}:${String(policy.zone_id)}`)??0,minAvailableUnits:Number(policy.min_available_units),suggestedQuantity:Number(policy.reorder_quantity)}))
  .filter(item=>item.available<item.minAvailableUnits);
 const availableBatches=batches.results.filter(row=>String(row.status)==="available");
 return{
  asOfDate:asOf,
  suppliers:suppliers.results,kitchens:kitchens.results,purchaseOrders:orders.results,batches:batches.results,wastage:wastage.results,reorderPolicies:policies.results,inventory:inventory.results,
  expiry:{
   expiringWithin48h:availableBatches.filter(row=>String(row.expiry_date)>=asOf&&String(row.expiry_date)<soon).map(row=>({batchId:String(row.id),sku:String(row.sku),zoneId:String(row.zone_id),expiryDate:String(row.expiry_date),remaining:Number(row.quantity_remaining)})),
   pastExpiryAwaitingSweep:availableBatches.filter(row=>String(row.expiry_date)<asOf).length,
  },
  reorderSuggestions,
  metrics:{
   openPurchaseOrders:orders.results.filter(row=>String(row.status)==="ordered").length,
   availableBatchUnits:availableBatches.reduce((sum,row)=>sum+Number(row.quantity_remaining||0),0),
   wastedUnits:wastage.results.reduce((sum,row)=>sum+Number(row.quantity||0),0),
   skusBelowReorderLevel:reorderSuggestions.length,
  },
  truth:{source:"canonical Food supply-chain tables",autoPurchase:false,liveMoney:false,productionReady:false},
 };
}
