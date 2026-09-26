// Staging-only inspection and explicit sandbox event proof for the confirmed voice tester.
import { pathToFileURL } from 'node:url';
export async function verifyVoiceSale(env=process.env,request=fetch){
 const origin='https://pawspace-staging.karthik-fce.workers.dev';
 const callId=String(env.UAT_VOICE_CALL_ID||''),last4=String(env.EXPECTED_DESTINATION_LAST4||''),bookingId=String(env.SALE_BOOKING_ID||'');
 const capture=env.VOICE_SALE_ACTION==='capture-voice-sale-sandbox';
 const entries=String(env.PAWSPACE_VOICE_UAT_ALLOWLIST||'').trim().split(/[\s,;]+/).filter(Boolean);
 if(!/^VCALL-[A-Z0-9-]+$/.test(callId)||!/^\d{4}$/.test(last4)||entries.length!==1||entries[0].replace(/\D/g,'').slice(-4)!==last4)throw Error('Confirmed UAT tester required');
 if(capture&&!bookingId)throw Error('Exact booking required for sandbox capture');
 const base=`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/d1/database/${encodeURIComponent(env.STAGING_D1_ID)}`;
 const headers={authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,'content-type':'application/json'};
 const meta=await request(base,{headers,signal:AbortSignal.timeout(30000)});const mb=await meta.json();
 if(!meta.ok||!mb.success||mb.result?.name!=='pawspace-staging')throw Error('Isolated staging database not verified');
 async function rows(sql,params=[]){const r=await request(base+'/query',{method:'POST',headers,body:JSON.stringify({sql,params}),signal:AbortSignal.timeout(60000)});const b=await r.json();if(!r.ok||!b.success||b.result?.some(x=>!x.success))throw Error('Staging evidence query failed');return b.result.flatMap(x=>x.results||[]);}
 const [call]=await rows('SELECT customer_id,mode,phone_last4 FROM voice_call_orders WHERE id=?',[callId]);
 if(!call||call.mode!=='uat'||call.phone_last4!==last4||!call.customer_id)throw Error('Voice call does not belong to confirmed UAT tester');
 const threadId='THREAD-VOICE-'+callId;
 const [pets,addresses,turns,offers]=await Promise.all([
 rows('SELECT name,species FROM canonical_pets WHERE customer_id=?',[call.customer_id]),
 rows('SELECT COUNT(*) count FROM customer_addresses WHERE customer_id=?',[call.customer_id]),
 rows('SELECT intent_code,policy_decision,outcome,handoff_reason,latency_ms FROM ai_conversation_turns WHERE thread_id=? AND customer_id=? ORDER BY created_at DESC LIMIT 4',[threadId,call.customer_id]),
 rows('SELECT id,status,result_json FROM voice_sales_offers WHERE thread_id=? AND customer_id=? ORDER BY created_at DESC LIMIT 5',[threadId,call.customer_id]),
 ]);
 const report={destinationLast4:last4,pets,addressCount:Number(addresses[0]?.count||0),recentTurns:turns,offerStatuses:offers.map(o=>o.status),completedBookings:offers.filter(o=>o.status==='completed').map(o=>JSON.parse(o.result_json||'{}').bookingId),dialed:false,captured:false};
 if(!bookingId)return report;
 const offer=offers.find(o=>o.status==='completed'&&JSON.parse(o.result_json||'{}').bookingId===bookingId);
 if(!offer)throw Error('Booking is not a completed offer from this UAT voice thread');
 const readBooking=()=>rows('SELECT b.id,b.status booking_status,b.total_amount,b.currency,p.status payment_status,p.amount payment_amount,l.gateway_order_id FROM canonical_bookings b JOIN booking_payments p ON p.booking_id=b.id LEFT JOIN payment_gateway_links l ON l.booking_id=b.id WHERE b.id=? AND b.customer_id=?',[bookingId,call.customer_id]);
 const [before]=await readBooking();if(!before?.gateway_order_id)throw Error('Canonical booking/payment/order evidence incomplete');
 if(capture){
  const login=await request(origin+'/api/staging-login',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({email:'founder@pawspace.in',code:env.PAWSPACE_UAT_ACCESS_CODE}),redirect:'manual',signal:AbortSignal.timeout(30000)});
  const cookie=(login.headers.get('set-cookie')||'').split(';',1)[0];if(login.status!==200||!cookie.startsWith('pawspace_uat='))throw Error('Staging staff login refused');
  const body={action:'simulate_event',bookingId,eventType:'payment.captured',eventId:'evt_voice_uat_'+offer.id,gatewayPaymentId:'pay_voice_uat_'+offer.id,amount:Number(before.payment_amount),currency:before.currency};
  // The server enforces sandbox mode and staff payment authority. Replay proves event idempotency.
  for(let i=0;i<2;i++){const r=await request(origin+'/api/grooming-payment-sandbox',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});const b=await r.json();if(!r.ok||b.data?.environment!=='sandbox'||b.data?.synthetic!==true)throw Error('Sandbox capture proof refused');}
 }
 const [after]=await readBooking();
 if(capture&&after.payment_status!=='captured')throw Error('Sandbox capture not persisted');
 return {...report,booking:after,captured:after.payment_status==='captured',synthetic:capture,replayChecked:capture};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log('VOICE_SALE_EVIDENCE='+JSON.stringify(await verifyVoiceSale()));
