type Row=Record<string,unknown>;

export async function ensureFoodSubscriptionPetTable(db:D1Database){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS food_subscription_pets (subscription_id TEXT NOT NULL,pet_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_type TEXT NOT NULL,source_order_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(subscription_id,pet_id))"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_food_subscription_pets_customer ON food_subscription_pets(customer_id,pet_id)"),
]);}

export async function bindFoodSubscriptionPetsFromOrder(db:D1Database,input:{subscriptionId:string;sourceOrderId:string;customerId:string}){await ensureFoodSubscriptionPetTable(db);const rows=(await db.prepare("SELECT pet_id,customer_id,pet_type FROM food_order_pets WHERE order_id=? ORDER BY pet_id").bind(input.sourceOrderId).all<Row>()).results;if(!rows.length)throw new Response("Food subscription requires pet-associated source order",{status:409});if(rows.some(row=>String(row.customer_id)!==input.customerId))throw new Response("Food subscription pet ownership does not match source order customer",{status:403});const now=Date.now();await db.batch(rows.map(row=>db.prepare("INSERT OR IGNORE INTO food_subscription_pets (subscription_id,pet_id,customer_id,pet_type,source_order_id,created_at) VALUES (?,?,?,?,?,?)").bind(input.subscriptionId,row.pet_id,input.customerId,row.pet_type,input.sourceOrderId,now)));return rows.map(row=>String(row.pet_id));}

export async function foodSubscriptionPetIds(db:D1Database,subscriptionId:string){await ensureFoodSubscriptionPetTable(db);return(await db.prepare("SELECT pet_id FROM food_subscription_pets WHERE subscription_id=? ORDER BY pet_id").bind(subscriptionId).all<Row>()).results.map(row=>String(row.pet_id));}
