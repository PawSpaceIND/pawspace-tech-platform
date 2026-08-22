type Row=Record<string,unknown>;

async function ensureBoundPaymentKey(db:D1Database){
 const columns=await db.prepare("PRAGMA table_info(sitting_quote_payment_attestations)").all<Row>();
 if(columns.results.some((column)=>String(column.name)==="bound_payment_key"))return;
 try{
  await db.prepare("ALTER TABLE sitting_quote_payment_attestations ADD COLUMN bound_payment_key TEXT").run();
 }catch(error){
  const recheck=await db.prepare("PRAGMA table_info(sitting_quote_payment_attestations)").all<Row>();
  if(!recheck.results.some((column)=>String(column.name)==="bound_payment_key"))throw error;
 }
}

export async function ensureSittingPaymentTables(db:D1Database){
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS sitting_quote_payment_attestations (quote_id TEXT PRIMARY KEY,status TEXT NOT NULL,amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',environment TEXT NOT NULL DEFAULT 'sandbox',reference TEXT NOT NULL,bound_payment_key TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 ]);
 await ensureBoundPaymentKey(db);
}

export async function captureSittingQuoteSandbox(db:D1Database,input:{quoteId:string;amount:number;paymentKey:string}){
 await ensureSittingPaymentTables(db);
 const paymentKey=String(input.paymentKey||"").trim();
 if(!paymentKey)throw new Response("MISSING_CAPTURE_KEY",{status:400});
 const quote=await db.prepare("SELECT id,total_amount,amount_due_now,status,expires_at FROM sitting_commercial_quotes WHERE id=?").bind(input.quoteId).first<Row>();
 if(!quote)throw new Response("Sitting quote not found",{status:404});
 if(String(quote.status)!=="open")throw new Response("Only an open Sitting quote can be sandbox-captured",{status:409});
 if(Number(quote.expires_at)<Date.now())throw new Response("Sitting quote expired before sandbox capture",{status:409});
 if(Number(quote.amount_due_now)!==Number(input.amount))throw new Response("Sandbox capture amount must match the Sitting quote amount due now (50% for split payment)",{status:409});

 const now=Date.now(),candidateReference=`SIT-UAT-PAY-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
 await db.prepare("INSERT OR IGNORE INTO sitting_quote_payment_attestations (quote_id,status,amount,currency,environment,reference,bound_payment_key,created_at,updated_at) VALUES (?,'captured',?,'INR','sandbox',?,?,?,?)").bind(input.quoteId,input.amount,candidateReference,paymentKey,now,now).run();
 // Legacy captured rows pre-date bound_payment_key. Exactly one first retry may claim such a row.
 await db.prepare("UPDATE sitting_quote_payment_attestations SET bound_payment_key=?,updated_at=? WHERE quote_id=? AND bound_payment_key IS NULL").bind(paymentKey,now,input.quoteId).run();
 const captured=await db.prepare("SELECT * FROM sitting_quote_payment_attestations WHERE quote_id=?").bind(input.quoteId).first<Row>();
 if(!captured||String(captured.status)!=="captured")throw new Response("Sitting sandbox payment attestation was not persisted",{status:500});
 if(String(captured.bound_payment_key)!==paymentKey)throw new Response("PAYMENT_CAPTURE_REPLAY",{status:403});
 if(Number(captured.amount)!==Number(input.amount))throw new Response("PAYMENT_CAPTURE_REPLAY",{status:403});
 return{quoteId:input.quoteId,status:"captured" as const,amount:Number(captured.amount),currency:String(captured.currency),environment:"sandbox" as const,reference:String(captured.reference),duplicatePrevented:String(captured.reference)!==candidateReference};
}

export async function requireSittingQuoteSandboxCapture(db:D1Database,input:{quoteId:string;amount:number}){
 await ensureSittingPaymentTables(db);
 const row=await db.prepare("SELECT * FROM sitting_quote_payment_attestations WHERE quote_id=?").bind(input.quoteId).first<Row>();
 if(!row||String(row.status)!=="captured")throw new Response("Sitting quote requires server-confirmed sandbox capture before booking",{status:409});
 if(String(row.environment)!=="sandbox")throw new Response("Sitting Gate 1 only accepts sandbox payment attestation",{status:409});
 if(Number(row.amount)!==Number(input.amount))throw new Response("Sitting sandbox capture does not match the governed quote amount",{status:409});
 return{status:"captured" as const,reference:String(row.reference),environment:"sandbox" as const};
}
