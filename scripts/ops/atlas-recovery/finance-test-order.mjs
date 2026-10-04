import {writeFileSync} from 'node:fs';

const env=process.env;
const origin='https://pawspace-staging.karthik-fce.workers.dev';
const bookingId='PS-UAT-MUTDQ1TH-9B15';
const version='b57e2ead-d931-4000-9a71-1dc40a9d238b';
const databaseId='1b879a28-c8a9-40b0-830d-1ce439061a00';
const receipt={kind:'authorized_razorpay_test_order_start',bookingId,amountInr:1349,origin,steps:[],realFunds:false,capturePerformed:false,payoutDispatched:false};
const save=()=>writeFileSync('finance-order-receipt.json',JSON.stringify(receipt,null,2)+'\n');
const requireTrue=(test,code)=>{if(!test)throw Error(code);};
async function cloud(path,body){
 const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}${path}`,{method:body?'POST':'GET',headers:{authorization:`Bearer ${env.CLOUDFLARE_API_TOKEN}`,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(20000)});
 const data=await response.json().catch(()=>null);requireTrue(response.ok&&data?.success===true,'certification_read_refused');return data.result;
}
async function normal(path,body,cookie){
 const response=await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json',origin,...(cookie?{cookie}:{})},body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(20000)});
 const data=await response.json().catch(()=>({}));receipt.steps.push({path,action:body.action,status:response.status,error:data.error??null});save();return{response,data};
}
try{
 requireTrue(env.CONFIRM==='create-one-approved-razorpay-test-order'&&env.EXPECTED_SHA===env.GITHUB_SHA&&env.GITHUB_RUN_ATTEMPT==='1'&&/^ops\/finance-test-order-/.test(env.GITHUB_REF_NAME??''),'scope_refused');
 requireTrue(/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID??'')&&env.CLOUDFLARE_API_TOKEN&&env.PAWSPACE_UAT_ACCESS_CODE,'existing_connection_missing');
 const active=(await cloud('/workers/scripts/pawspace-staging/deployments'))?.deployments?.[0];requireTrue(active?.versions?.length===1&&active.versions[0].percentage===100&&active.versions[0].version_id===version,'serving_version_changed');
 const resource=await cloud('/workers/scripts/pawspace-staging/versions/'+version),bindings=resource.resources?.bindings;requireTrue(Array.isArray(bindings),'bindings_unproven');
 requireTrue(bindings.filter(x=>x.type==='d1').length===1&&bindings.some(x=>x.type==='d1'&&x.name==='DB'&&(x.id??x.database_id)===databaseId),'database_mismatch');
 const vars=Object.fromEntries(bindings.filter(x=>x.type==='plain_text').map(x=>[x.name,String(x.text??x.value??'')]));
 requireTrue(vars.PAWSPACE_STAGING_BUILD_SHA==='aec758b029c190e0df526925f35714f60c866d8b'&&vars.PAWSPACE_PAYMENT_ENV==='sandbox'&&vars.PAWSPACE_PAYMENT_LIVE_APPROVED==='false'&&vars.FORBID_PRODUCTION==='true'&&vars.PAWSPACE_RAZORPAYX_LIVE_APPROVED==='false','sandbox_gate_refused');
 const sql='SELECT b.id,b.customer_id,b.provider_id,b.total_amount,b.status,p.amount,p.currency,p.status payment_status,p.mode FROM canonical_bookings b JOIN booking_payments p ON p.booking_id=b.id WHERE b.id=? AND b.customer_id=? AND b.provider_id=? LIMIT 1';
 const q=await cloud('/d1/database/'+databaseId+'/query',{sql,params:[bookingId,'CUS0000','uatcap_groom_ft']});
 requireTrue(q?.length===1&&q[0].success&&q[0].meta.rows_written===0&&q[0].meta.changed_db===false&&q[0].results?.length===1,'booking_read_refused');
 const booking=q[0].results[0];requireTrue(Number(booking.total_amount)===1349&&Number(booking.amount)===1349&&booking.currency==='INR'&&booking.status==='confirmed'&&booking.payment_status==='pending','booking_amount_or_state_mismatch');
 receipt.bookingRead={customerId:booking.customer_id,providerId:booking.provider_id,amount:Number(booking.amount),paymentMode:booking.mode,status:booking.status};save();
 const login=await normal('/api/staging-login',{email:'anjali.finance33@tkpetcare.in',code:env.PAWSPACE_UAT_ACCESS_CODE});requireTrue(login.response.status===200&&login.data.role==='finance','finance_login_refused');
 const cookie=login.response.headers.get('set-cookie')?.split(';')[0];requireTrue(cookie,'finance_session_missing');
 const order=await normal('/api/grooming-payment-sandbox',{action:'create_order',bookingId},cookie);
 requireTrue([200,201].includes(order.response.status),'razorpay_test_order_refused');
 const value=order.data.data??{};requireTrue(value.environment==='sandbox'&&String(value.gatewayOrderId??'').startsWith('order_')&&(value.amountSubunits===undefined||Number(value.amountSubunits)===134900),'gateway_order_receipt_invalid');
 receipt.gateway={orderId:String(value.gatewayOrderId),amountSubunits:value.amountSubunits??null,status:value.gatewayStatus??null,duplicatePrevented:value.duplicatePrevented===true};receipt.passed=true;save();
}catch(error){receipt.passed=false;receipt.firstFailedStep=receipt.steps.at(-1)?.action??'preflight';receipt.error=String(error?.message??error).slice(0,180);save();process.exitCode=1;}
