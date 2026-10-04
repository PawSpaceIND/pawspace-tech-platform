import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {issueUatToken,resolveUatStaffActor} from './issue-uat-token.mjs';
export const PIN={sha:'c18b15caea9551505398746dc9335a962f17e8ae',version:'f3205b4b-ca77-487a-b5fc-830fd84f9424',d1:'1b879a28-c8a9-40b0-830d-1ce439061a00',origin:'https://pawspace-staging.karthik-fce.workers.dev'};
const assert=(ok,code)=>{if(!ok)throw Error(code)};
export function readResult(p){assert(p?.success===true&&Array.isArray(p.result)&&p.result.length===1,'d1_read_failed');const x=p.result[0];assert(x.success===true&&Array.isArray(x.results)&&x.meta?.rows_written===0&&x.meta?.changed_db===false,'d1_read_metadata_unproven');return x.results;}
export async function run(env=process.env,fetcher=fetch){
 const receipt={kind:'finance_booking_shape_and_binding_isolation_read',pin:PIN,modelRequests:0,mutations:0,operations:[],cancellationMutationPerformed:false};
 const save=()=>writeFileSync(env.EVIDENCE_PATH||'finance-booking-read-receipt.json',JSON.stringify(receipt,null,2)+'\n');
 const account=env.CLOUDFLARE_ACCOUNT_ID,token=env.CLOUDFLARE_API_TOKEN;
 async function request(url,init,label){receipt.operations.push({label,state:'read_pending'});save();const op=receipt.operations.at(-1);let response;try{response=await fetcher(url,{...init,redirect:'manual',signal:AbortSignal.timeout(20000)});}catch{op.state='read_failed';throw Error('transport_failed_'+label)}op.httpStatus=response.status;assert(response.ok,'http_refused_'+label);op.state='read_received';save();return response;}
 const cf=async(path,body)=>{const r=await request(`https://api.cloudflare.com/client/v4/accounts/${account}/${path}`,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})},body?'d1_select':'native_read');const p=await r.json();assert(p?.success===true,'native_read_failed');return p;};
 const query=async(sql,params=[])=>{assert(/^SELECT\s/i.test(sql)&&!sql.includes(';'),'select_only');return readResult(await cf(`d1/database/${PIN.d1}/query`,{sql,params}));};
 const db={prepare(sql){let params=[];return{bind(...v){params=v;return this},async first(){return(await query(sql,params))[0]??null}}}};
 const active=async()=>{const p=(await cf('workers/scripts/pawspace-staging/deployments')).result;assert(p?.deployments?.[0]?.versions?.length===1&&p.deployments[0].versions[0].percentage===100&&p.deployments[0].versions[0].version_id===PIN.version,'active_version_unproven');};
 try{
 assert(env.CONFIRM==='read-only-finance-booking-unpaid-isolation'&&env.GITHUB_RUN_ATTEMPT==='1'&&/^ops\/atlas-session-/.test(env.GITHUB_REF_NAME||'')&&env.EXPECTED_SHA===env.GITHUB_SHA,'execution_scope_refused');
 assert(/^[a-f0-9]{32}$/.test(account||'')&&token&&env.PAWSPACE_UAT_SIGNING_KEY?.length>=32,'existing_credentials_missing');
 await active();const version=(await cf(`workers/scripts/pawspace-staging/versions/${PIN.version}`)).result,bindings=version?.resources?.bindings;
 assert(Array.isArray(bindings)&&bindings.filter(b=>b.type==='d1').length===1&&bindings.some(b=>b.type==='d1'&&b.name==='DB'&&(b.id??b.database_id)===PIN.d1),'dedicated_d1_unproven');
 const vars=Object.fromEntries(bindings.filter(b=>b.type==='plain_text').map(b=>[b.name,String(b.text??b.value??'')]));
 assert(vars.PAWSPACE_STAGING_BUILD_SHA===PIN.sha&&vars.PAWSPACE_UAT_LOGIN==='on'&&vars.PAWSPACE_COMMUNICATION_ENV==='uat'&&vars.PAWSPACE_PAYMENT_ENV==='sandbox'&&vars.PAWSPACE_PAYMENT_LIVE_APPROVED==='false'&&vars.PAWSPACE_RAZORPAYX_ENV==='sandbox'&&vars.PAWSPACE_RAZORPAYX_LIVE_APPROVED==='false','runtime_flags_unproven');
 const required={app_users:['id','email','name','role_code','status'],role_definitions:['code','permissions_json'],identity_bindings:['identity_source','principal_type','principal_key','subject_type','subject_id','status','verification_state','expires_at','updated_at'],provider_identity_links:['email','provider_id','status']};
 for(const [table,cols] of Object.entries(required)){const names=await query('SELECT name FROM pragma_table_info(?)',[table]);assert(cols.every(c=>names.some(r=>r.name===c)),'schema_unproven_'+table)}
 const exitCols=await query("SELECT name FROM pragma_table_info('employee_exit_cases')");assert(exitCols.length===0||['id','identity_email','user_id','status','access_ends_at'].every(c=>exitCols.some(r=>r.name===c)),'exit_schema_unproven');receipt.schemaQualified=true;
 // Execute existing actual compiled resolveUatStaffActor; every DB operation passes SELECT-only transport.
 const ashaEmail='asha.groomer1@tkpetcare.in',ashaCookie='pawspace_uat='+encodeURIComponent(await issueUatToken({PAWSPACE_UAT_SIGNING_KEY:env.PAWSPACE_UAT_SIGNING_KEY},ashaEmail,120));
 const actor=await resolveUatStaffActor(db,new Request(PIN.origin+'/api/grooming-payment-sandbox',{headers:{cookie:ashaCookie}}),{...vars,PAWSPACE_UAT_SIGNING_KEY:env.PAWSPACE_UAT_SIGNING_KEY});
 assert(actor?.roleCode==='service_provider'&&actor.identitySource==='workspace'&&actor.principalType==='email'&&actor.principalKey===ashaEmail&&actor.permissions.includes('bookings.view')&&!actor.permissions.some(x=>['*','payments.manage','providers.manage','bookings.manage','grooming.manage'].includes(x)),'actor_privilege_or_principal_unproven');
 const canonical=await query("SELECT (subject_id=?) owned FROM identity_bindings WHERE identity_source=? AND principal_type=? AND principal_key=? AND subject_type='provider' AND status='active' AND verification_state='verified' AND (expires_at IS NULL OR expires_at>?) ORDER BY updated_at DESC LIMIT 1",['uatcap_groom_ft',actor.identitySource,actor.principalType,actor.principalKey,Date.now()]);
 let owned;if(canonical.length){owned=canonical[0].owned===1}else{const legacy=await query("SELECT (provider_id=? AND status='active') owned FROM provider_identity_links WHERE email=?",['uatcap_groom_ft',actor.email]);owned=legacy.length===1&&legacy[0].owned===1}assert(owned,'provider_ownership_unproven');
 receipt.actor={active:true,role:'service_provider',identitySource:'workspace',principalType:'email',intendedPrincipalVerified:true,bookingsView:true,noMoneyOrManagementPrivileges:true,providerOwned:true,bindingSource:canonical.length?'canonical':'legacy',platformSessionCookiesAbsent:true};save();
 const cookie='pawspace_uat='+encodeURIComponent(await issueUatToken({PAWSPACE_UAT_SIGNING_KEY:env.PAWSPACE_UAT_SIGNING_KEY},'founder@pawspace.in',120));
 const fixture=await(await request(PIN.origin+'/__staging/fixture-isolation?scope=grooming_strict&expectedSha='+PIN.sha,{method:'GET',headers:{cookie}},'fixed_fixture_get')).json();
 const keys=['paymentSandbox','payoutsSandbox','communicationsUat','voiceNotLive','customerLiveOtpDisabled','productionOtpDisabled','schedulerUat','customerFixtureProven','customerOtpTargetUnambiguous','specificGroomerFixtureProven','groomerOtpTargetUnambiguous','genericExcluded','metaExcluded','voiceExcluded'];
 assert(fixture.ok===true&&fixture.scope==='grooming_strict'&&fixture.version?.id===PIN.version&&fixture.version?.buildSha===PIN.sha&&keys.every(k=>fixture.checks?.[k]===true),'cancellation_recipient_isolation_unproven');
 receipt.isolation={checks:Object.fromEntries(keys.map(k=>[k,true])),sameVersion:true,cus0000AndSelectedGroomerOnly:true,staffFallbackRecipientsCovered:false,alternateProviderTablesCovered:false,assignmentLock:false};
 const bookingSchema={canonical_bookings:['id','customer_id','provider_id','service_code','status','total_amount','currency'],booking_payments:['id','booking_id','customer_id','mode','status','amount','amount_due_now','currency'],provider_work_orders:['booking_id','provider_id','service_code','status']};
 for(const [table,cols] of Object.entries(bookingSchema)){const names=await query('SELECT name FROM pragma_table_info(?)',[table]);assert(cols.every(c=>names.some(r=>r.name===c)),'schema_unproven_'+table)}
 const bookingId='PS-UAT-MUTDQ1TH-9B15';
 const rows=await query(`SELECT
 (SELECT COUNT(*)=1 FROM canonical_bookings WHERE id=?) singleBooking,
 (SELECT COUNT(*)=1 FROM booking_payments WHERE booking_id=?) singlePayment,
 (SELECT COUNT(*)=1 FROM provider_work_orders WHERE booking_id=?) singleWorkOrder,
 EXISTS(SELECT 1 FROM canonical_bookings WHERE id=? AND customer_id='CUS0000' AND provider_id='uatcap_groom_ft' AND service_code='grooming' AND total_amount=1349 AND currency='INR') exactBookingTuple,
 EXISTS(SELECT 1 FROM canonical_bookings WHERE id=? AND status='confirmed') bookingConfirmed,
 EXISTS(SELECT 1 FROM provider_work_orders WHERE booking_id=? AND provider_id='uatcap_groom_ft' AND service_code='grooming' AND status IN ('confirmed','assigned')) workUnstartedAndBound,
 EXISTS(SELECT 1 FROM booking_payments WHERE booking_id=? AND customer_id='CUS0000' AND amount=1349 AND amount_due_now=0 AND currency='INR') exactPaymentTuple,
 EXISTS(SELECT 1 FROM booking_payments WHERE booking_id=? AND mode='pay_after') unsupportedPayAfterMode,
 EXISTS(SELECT 1 FROM booking_payments WHERE booking_id=? AND status='pending') paymentPending`,Array(9).fill(bookingId));
 const expectedKeys=['singleBooking','singlePayment','singleWorkOrder','exactBookingTuple','bookingConfirmed','workUnstartedAndBound','exactPaymentTuple','unsupportedPayAfterMode','paymentPending'];
 assert(rows.length===1&&expectedKeys.every(k=>rows[0][k]===0||rows[0][k]===1),'booking_boolean_shape_unproven');
 receipt.booking={bookingId,schemaQualified:true,checks:Object.fromEntries(expectedKeys.map(k=>[k,rows[0][k]===1])),financialAbsenceCertified:false,pendingStatusOnlyNotProofOfNoGatewayCapture:true};save();
 assert(expectedKeys.every(k=>rows[0][k]===1),'booking_state_or_tuple_refused');
 await active();receipt.ok=true;receipt.qualifiedScope='Exact booking/payment/work-order pending unsupported-mode tuple; ASHA principal/binding and fixed recipient exclusion snapshot';receipt.remainingGates=['full booking/payment/proof/credit/completion/payout absence','cancellation policy/consent preview','matching isolation certificate and staff/referral side-effect coverage','normal policy and consent plus unresolved financial side-state checks'];save();console.log('Finance binding and fixed-recipient isolation read qualified; no cancellation was performed; financial absence is not certified.');
 }catch(error){receipt.ok=false;receipt.failure=/^[a-zA-Z0-9_]+$/.test(error.message)?error.message:'read_failed_private_details_withheld';save();throw Error(receipt.failure)}
 return receipt;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)run().catch(e=>{console.error(e.message);process.exitCode=1});
