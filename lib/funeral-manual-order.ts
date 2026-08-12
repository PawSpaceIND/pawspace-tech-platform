/**
 * Pet-funeral MANUAL converted-order capture. Once a funeral enquiry converts, ops records the order by
 * hand: customer name, phone, payment method, order value, date. GST is OFF by default (PawSpace does not
 * charge GST on funeral orders yet) - a single governed toggle switches it to 18% for future orders when
 * the business decides to. Deliberately its own tiny table so it never destabilises the richer funeral
 * case workflow; sandbox/UAT, no live money.
 */
type Db=D1Database;
type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const money=(v:unknown)=>Math.round(Number(v||0)*100)/100;
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,10).toUpperCase()}`;

export async function ensureFuneralManualOrderTables(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS funeral_manual_gst_config (id TEXT PRIMARY KEY,gst_enabled INTEGER NOT NULL DEFAULT 0,gst_rate REAL NOT NULL DEFAULT 0.18,updated_by TEXT,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS funeral_manual_orders (id TEXT PRIMARY KEY,customer_name TEXT NOT NULL,phone TEXT NOT NULL,payment_method TEXT NOT NULL,order_value REAL NOT NULL,gst_enabled INTEGER NOT NULL DEFAULT 0,gst_amount REAL NOT NULL DEFAULT 0,total_amount REAL NOT NULL,order_date TEXT NOT NULL,note TEXT,recorded_by TEXT NOT NULL,created_at INTEGER NOT NULL)"),
]);}

async function gstConfig(db:Db){
 const row=await db.prepare("SELECT gst_enabled,gst_rate FROM funeral_manual_gst_config WHERE id='default'").first<Row>().catch(()=>null);
 return{enabled:Number(row?.gst_enabled||0)===1,rate:Number(row?.gst_rate||0.18)};
}

/** Toggle whether funeral manual orders charge 18% GST. Off by default; audited. Affects future orders only. */
export async function setFuneralManualGstMode(db:Db,input:{enabled:boolean;gstRate?:number;actorId:string}){
 await ensureFuneralManualOrderTables(db);
 const rate=input.gstRate==null?0.18:Number(input.gstRate);
 if(!(rate>0&&rate<1))throw new Error("GST rate must be a fraction between 0 and 1");
 const now=Date.now();
 await db.prepare("INSERT INTO funeral_manual_gst_config (id,gst_enabled,gst_rate,updated_by,updated_at) VALUES ('default',?,?,?,?) ON CONFLICT(id) DO UPDATE SET gst_enabled=excluded.gst_enabled,gst_rate=excluded.gst_rate,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
  .bind(input.enabled?1:0,rate,input.actorId,now).run();
 return{gstEnabled:input.enabled,gstRate:rate};
}

/** Record a converted funeral order by hand. GST applied only if the toggle is on at capture time. */
export async function recordFuneralConvertedOrder(db:Db,input:{customerName:string;phone:string;paymentMethod:string;orderValue:number;orderDate:string;note?:string;actorId:string}){
 await ensureFuneralManualOrderTables(db);
 if(!text(input.customerName))throw new Error("Customer name is required");
 if(!text(input.phone))throw new Error("Phone number is required");
 if(!text(input.paymentMethod))throw new Error("Payment method is required");
 const orderValue=money(input.orderValue);
 if(!(orderValue>0))throw new Error("Order value must be positive");
 if(!/^\d{4}-\d{2}-\d{2}$/.test(text(input.orderDate)))throw new Error("A real order date is required");
 const cfg=await gstConfig(db);
 const gstAmount=cfg.enabled?money(orderValue*cfg.rate):0;
 const total=money(orderValue+gstAmount),id=uid("FMO"),now=Date.now();
 await db.prepare("INSERT INTO funeral_manual_orders (id,customer_name,phone,payment_method,order_value,gst_enabled,gst_amount,total_amount,order_date,note,recorded_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
  .bind(id,text(input.customerName),text(input.phone),text(input.paymentMethod),orderValue,cfg.enabled?1:0,gstAmount,total,text(input.orderDate),text(input.note)||null,input.actorId,now).run();
 return{id,orderValue,gstEnabled:cfg.enabled,gstAmount,totalAmount:total,orderDate:text(input.orderDate)};
}

/** Directory of manual funeral orders + current GST toggle. Cold-DB safe. */
export async function funeralManualOrderDirectory(db:Db){
 await ensureFuneralManualOrderTables(db);
 const cfg=await gstConfig(db);
 const rows=await db.prepare("SELECT * FROM funeral_manual_orders ORDER BY created_at DESC LIMIT 200").all<Row>().catch(()=>({results:[] as Row[]}));
 return{gstEnabled:cfg.enabled,gstRate:cfg.rate,orders:rows.results.map(r=>({id:text(r.id),customerName:text(r.customer_name),phone:text(r.phone),paymentMethod:text(r.payment_method),orderValue:money(r.order_value),gstAmount:money(r.gst_amount),totalAmount:money(r.total_amount),orderDate:text(r.order_date),recordedBy:text(r.recorded_by)})),truth:{gstChargedByDefault:false,gstToggleable:true,liveMoney:false,productionReady:false}};
}
