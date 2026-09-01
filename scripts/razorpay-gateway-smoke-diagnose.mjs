import { writeFileSync } from "node:fs";
const dbId=String(process.env.STAGING_D1_ID||"").trim(),cfAccount=String(process.env.CLOUDFLARE_ACCOUNT_ID||"").trim(),cfToken=String(process.env.CLOUDFLARE_API_TOKEN||"").trim();
const bookingId="CERT-GATEWAY-SMOKE-20260901";
async function d1(sql,params=[]){const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfAccount)}/d1/database/${encodeURIComponent(dbId)}/query`,{method:"POST",headers:{authorization:`Bearer ${cfToken}`,"content-type":"application/json"},body:JSON.stringify({sql,params}),signal:AbortSignal.timeout(30000)});const b=await r.json();if(!r.ok||b?.success!==true||b?.result?.[0]?.success!==true)throw new Error(b?.errors?.[0]?.message||b?.result?.[0]?.error||`D1 ${r.status}`);return b.result[0].results||[];}
const queries={
 booking:["SELECT id,customer_id,status,total_amount,currency FROM canonical_bookings WHERE id=?",[bookingId]],
 payment:["SELECT id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json FROM booking_payments WHERE booking_id=?",[bookingId]],
 intents:["SELECT id,booking_id,payment_id,environment,idempotency_key,amount_paise,currency,state,order_request_state,gateway_order_id,gateway_payment_id,version,created_at,updated_at FROM payment_intents WHERE booking_id=? ORDER BY created_at",[bookingId]],
 outbox:["SELECT id,aggregate_type,aggregate_id,event_type,dedupe_key,status,attempts,last_error,lease_owner,lease_expires_at,response_json,request_json,created_at,updated_at FROM financial_outbox WHERE aggregate_id IN (SELECT id FROM payment_intents WHERE booking_id=?) ORDER BY created_at",[bookingId]],
 links:["SELECT * FROM payment_gateway_links WHERE booking_id=?",[bookingId]],
 recon:["SELECT * FROM payment_reconciliation_records WHERE booking_id=?",[bookingId]],
 intentSchema:["PRAGMA table_info(payment_intents)",[]],
 outboxSchema:["PRAGMA table_info(financial_outbox)",[]]
};
const evidence={};for(const [k,[sql,p]] of Object.entries(queries)){try{evidence[k]=await d1(sql,p)}catch(e){evidence[k]={error:e instanceof Error?e.message:String(e)}}}
writeFileSync("gateway-smoke-diagnostics.json",JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
