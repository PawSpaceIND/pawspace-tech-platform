type Row=Record<string,unknown>;

export async function ensureSittingPaymentTables(db:D1Database){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS sitting_quote_payment_attestations (quote_id TEXT PRIMARY KEY,status TEXT NOT NULL,amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',environment TEXT NOT NULL DEFAULT 'sandbox',reference TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
]);}

export async function captureSittingQuoteSandbox(db:D1Database,input:{quoteId:string;amount:number}){
 await ensureSittingPaymentTables(db);
 const quote=await db.prepare("SELECT id,total_amount,status,expires_at FROM sitting_commercial_quotes WHERE id=?").bind(input.quoteId).first<Row>();
 if(!quote)throw new Response("Sitting quote not found",{status:404});
 if(String(quote.status)!=="open")throw new Response("Only an open Sitting quote can be sandbox-captured",{status:409});
 if(Number(quote.expires_at)<Date.now())throw new Response("Sitting quote expired before sandbox capture",{status:409});
 if(Number(quote.total_amount)!==Number(input.amount))throw new Response("Sandbox capture amount must match the Sitting quote",{status:409});
 const existing=await db.prepare("SELECT * FROM sitting_quote_payment_attestations WHERE quote_id=?").bind(input.quoteId).first<Row>();
 if(existing&&String(existing.status)==="captured")return{quoteId:input.quoteId,status:"captured" as const,amount:Number(existing.amount),currency:String(existing.currency),environment:"sandbox" as const,reference:String(existing.reference),duplicatePrevented:true};
 const now=Date.now(),reference=`SIT-UAT-PAY-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
 await db.prepare("INSERT INTO sitting_quote_payment_attestations (quote_id,status,amount,currency,environment,reference,created_at,updated_at) VALUES (?,'captured',?,'INR','sandbox',?,?,?) ON CONFLICT(quote_id) DO UPDATE SET status='captured',amount=excluded.amount,currency='INR',environment='sandbox',reference=excluded.reference,updated_at=excluded.updated_at").bind(input.quoteId,input.amount,reference,now,now).run();
 return{quoteId:input.quoteId,status:"captured" as const,amount:input.amount,currency:"INR",environment:"sandbox" as const,reference,duplicatePrevented:false};
}

export async function requireSittingQuoteSandboxCapture(db:D1Database,input:{quoteId:string;amount:number}){
 await ensureSittingPaymentTables(db);
 const row=await db.prepare("SELECT * FROM sitting_quote_payment_attestations WHERE quote_id=?").bind(input.quoteId).first<Row>();
 if(!row||String(row.status)!=="captured")throw new Response("Sitting quote requires server-confirmed sandbox capture before booking",{status:409});
 if(String(row.environment)!=="sandbox")throw new Response("Sitting Gate 1 only accepts sandbox payment attestation",{status:409});
 if(Number(row.amount)!==Number(input.amount))throw new Response("Sitting sandbox capture does not match the governed quote amount",{status:409});
 return{status:"captured" as const,reference:String(row.reference),environment:"sandbox" as const};
}