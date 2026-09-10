import fs from 'node:fs';
const origin=process.env.ORIGIN;
const bookingId='PS-UAT-MTV9TAXL-D586';
const providerId='groom_arun';
const expectedOrder='order_TaGn7hheH3NbJT';
const out='golden-service-evidence';fs.mkdirSync(out,{recursive:true});
const report={testOnly:true,productionChanged:false,bookingId,providerId,expectedOrder,steps:[]};
let cookie='';
const save=()=>fs.writeFileSync(`${out}/lifecycle.json`,JSON.stringify(report,null,2)+'\n');
const step=(name,detail={})=>{report.steps.push({name,ok:true,...detail});save();console.log('PASS',name,JSON.stringify(detail));};
async function call(path,{method='GET',body}={}){
 const headers={origin,'cache-control':'no-cache'};if(body!==undefined)headers['content-type']='application/json';if(cookie)headers.cookie=cookie;
 const response=await fetch(origin+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
 const raw=await response.text();let data;try{data=raw?JSON.parse(raw):{}}catch{data={raw:raw.slice(0,2000)}}
 if(!response.ok)throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(data)}`);
 return{response,data};
}
async function lifecycle(){return (await call(`/api/grooming-lifecycle?bookingId=${encodeURIComponent(bookingId)}`)).data.data;}
async function mutate(action,extra={}){return (await call('/api/grooming-lifecycle',{method:'POST',body:{bookingId,action,...extra}})).data;}
async function ensureStatus(from,to,action){const before=await lifecycle();const current=before.booking.status;if(current==='completed'){step(`Lifecycle already completed; ${action} not repeated`);return before;}if(current===to){step(`Lifecycle ${to} already reached`);return before;}if(current!==from)throw new Error(`Expected ${from} before ${action}, found ${current}`);await mutate(action);const after=await lifecycle();if(after.booking.status!==to)throw new Error(`${action} did not reach ${to}`);step(`Lifecycle ${from} -> ${to}`);return after;}
try{
 const login=await call('/api/staging-login',{method:'POST',body:{code:process.env.PAWSPACE_UAT_ACCESS_CODE,email:'founder@pawspace.in'}});
 const setCookie=login.response.headers.get('set-cookie')||'';cookie=setCookie.split(';')[0];if(!cookie.startsWith('pawspace_uat='))throw new Error('UAT staff cookie not issued');step('Founder UAT staff session');
 let state=await lifecycle();
 if(state.booking.id!==bookingId||state.booking.providerId!==providerId)throw new Error('Same-record booking/provider identity changed');
 if(state.booking.paymentStatus!=='captured')throw new Error(`Payment is not captured: ${state.booking.paymentStatus}`);
 step('Same booking/provider/payment identity verified',{status:state.booking.status,paymentStatus:state.booking.paymentStatus});
 const alreadyCompleted=state.booking.status==='completed';
 if(!alreadyCompleted){
   await call('/api/location-recovery',{method:'POST',body:{action:'save_policy',id:'PUNC-GOLDEN-GROOMING-43BA4002',serviceCode:'grooming',cityId:'blr',trackingEnabled:true,etaFreshnessSeconds:900,allowedAccuracyMeters:25,graceMinutes:0,customerAlertMinutes:15,opsEscalationMinutes:30,reassignmentMinutes:60,rawGpsRetentionDays:7,approvalState:'approved',effectiveFrom:'2026-08-01',evidenceRequirements:['trusted_gps','arrival_geofence']}});
   await call('/api/location-recovery',{method:'POST',body:{action:'set_controls',gpsIngestionEnabled:true,mapAdapterEnabled:false,mapEnvironment:'sandbox'}});
   step('UAT punctuality policy and sandbox GPS controls ready');
   await ensureStatus('confirmed','assigned','accept');
   await ensureStatus('assigned','on_the_way','on_the_way');
   const route=await call(`/api/grooming-route?bookingId=${encodeURIComponent(bookingId)}&providerId=${encodeURIComponent(providerId)}`);
   const point=route.data.data?.destinationCoordinates;if(!point||!Number.isFinite(Number(point.lat))||!Number.isFinite(Number(point.lng)))throw new Error('Governed doorstep coordinates unavailable');
   const gps=await call('/api/grooming-route',{method:'POST',body:{bookingId,providerId,latitude:Number(point.lat),longitude:Number(point.lng),accuracyMeters:5,capturedAt:Date.now(),idempotencyKey:`golden-arrival:${bookingId}`}});
   if(gps.data.data?.telemetryAccepted!==true)throw new Error('Trusted Grooming GPS was not accepted');
   step('Trusted server-bound GPS accepted at governed doorstep',{accuracyMeters:5});
   await ensureStatus('on_the_way','arrived','arrived');
   await ensureStatus('arrived','in_service','start_service');
   state=await lifecycle();
   if(!state.proof?.beforePhotoRef||!state.proof?.afterPhotoRef||!(state.proof?.checklist?.length)){
     const proof=await mutate('add_proof',{beforePhotoRef:`uat://proof/${bookingId}/before`,afterPhotoRef:`uat://proof/${bookingId}/after`,checklist:['Bath completed','Coat dried','Nails checked'],completionNotes:'Golden-path UAT proof only; no production media.'});
     if(!proof.data?.proof?.beforePhotoRef||!proof.data?.proof?.afterPhotoRef)throw new Error('UAT Grooming proof was not persisted');
     step('UAT Grooming before/after proof and checklist recorded');
   }else step('UAT Grooming proof already present');
   state=await lifecycle();
   if(state.booking.status==='in_service'){
     const completed=await mutate('complete');
     if(completed.finance?.ledgerStatus!=='balanced'||completed.finance?.taxStatus!=='resolved'||completed.finance?.payoutStatus!=='accrued')throw new Error(`Completion finance not resolved: ${JSON.stringify(completed.finance)}`);
     report.completionFinance=completed.finance;step('Canonical Grooming completion finance resolved',{ledgerStatus:completed.finance.ledgerStatus,taxStatus:completed.finance.taxStatus,payoutStatus:completed.finance.payoutStatus});
   }else if(state.booking.status!=='completed')throw new Error(`Unexpected final pre-completion state ${state.booking.status}`);
 }else step('Booking already completed; service-side mutations not repeated');
 const final=await lifecycle();
 if(final.booking.status!=='completed'||final.booking.workOrderStatus!=='completed'||final.booking.paymentStatus!=='captured')throw new Error('Final booking/work-order/payment state mismatch');
 if(final.invoice?.status!=='issued'||final.taxReadiness?.taxRuleStatus!=='resolved'||final.payoutReadiness?.status!=='accrued')throw new Error(`Final invoice/tax/payout projection incomplete: ${JSON.stringify(final)}`);
 report.finalLifecycle=final;step('Same booking completed with invoice, GST readiness and provider accrual',{invoice:final.invoice.invoiceNumber,payoutAmount:final.payoutReadiness.payoutAmount});
 report.outcome='SAME_RECORD_SERVICE_COMPLETION_PASS';save();
}catch(error){report.failure=error instanceof Error?error.message:String(error);report.outcome='FAILED';save();console.error(error);process.exitCode=1;}
