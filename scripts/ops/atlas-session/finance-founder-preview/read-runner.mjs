import {writeFileSync,readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {issueUatToken,resolveUatStaffActor} from './issue-uat-token.mjs';
export const PIN={sha:'c18b15caea9551505398746dc9335a962f17e8ae',version:'f3205b4b-ca77-487a-b5fc-830fd84f9424',d1:'1b879a28-c8a9-40b0-830d-1ce439061a00',origin:'https://pawspace-staging.karthik-fce.workers.dev'};
const assert=(ok,code)=>{if(!ok)throw Error(code)};
export function readResult(p){assert(p?.success===true&&Array.isArray(p.result)&&p.result.length===1,'d1_read_failed');const x=p.result[0];assert(x.success===true&&Array.isArray(x.results)&&x.meta?.rows_written===0&&x.meta?.changed_db===false,'d1_read_metadata_unproven');return x.results;}
export async function run(env=process.env,fetcher=fetch){
 const receipt={kind:'finance_founder_normal_authenticated_preview',pin:PIN,modelRequests:0,reservationActions:0,bookingCreates:0,financialActions:0,normalRouteHousekeepingPossible:true,operations:[],cancellationPerformed:false};
 const save=()=>writeFileSync(env.EVIDENCE_PATH||'finance-founder-preview-receipt.json',JSON.stringify(receipt,null,2)+'\n');
 const account=env.CLOUDFLARE_ACCOUNT_ID,token=env.CLOUDFLARE_API_TOKEN;
 async function request(url,init,label){receipt.operations.push({label,state:'read_pending'});save();const op=receipt.operations.at(-1);let response;try{response=await fetcher(url,{...init,redirect:'manual',signal:AbortSignal.timeout(20000)});}catch{op.state='read_failed';throw Error('transport_failed_'+label)}op.httpStatus=response.status;assert(response.ok,'http_refused_'+label);op.state='read_received';save();return response;}
 const cf=async(path,body)=>{const r=await request(`https://api.cloudflare.com/client/v4/accounts/${account}/${path}`,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})},body?'d1_select':'native_read');const p=await r.json();assert(p?.success===true,'native_read_failed');return p;};
 const query=async(sql,params=[])=>{assert(/^SELECT\s/i.test(sql)&&!sql.includes(';'),'select_only');return readResult(await cf(`d1/database/${PIN.d1}/query`,{sql,params}));};
 const db={prepare(sql){let params=[];return{bind(...v){params=v;return this},async first(){return(await query(sql,params))[0]??null}}}};
 const active=async()=>{const p=(await cf('workers/scripts/pawspace-staging/deployments')).result;assert(p?.deployments?.[0]?.versions?.length===1&&p.deployments[0].versions[0].percentage===100&&p.deployments[0].versions[0].version_id===PIN.version,'active_version_unproven');};
 try{
 assert(env.CONFIRM==='normal-founder-finance-preview-only'&&env.GITHUB_RUN_ATTEMPT==='1'&&/^ops\/atlas-session-/.test(env.GITHUB_REF_NAME||'')&&env.EXPECTED_SHA===env.GITHUB_SHA,'execution_scope_refused');
 assert(/^[a-f0-9]{32}$/.test(account||'')&&token&&env.PAWSPACE_UAT_SIGNING_KEY?.length>=32,'existing_credentials_missing');
 await active();const version=(await cf(`workers/scripts/pawspace-staging/versions/${PIN.version}`)).result,bindings=version?.resources?.bindings;
 assert(Array.isArray(bindings)&&bindings.filter(b=>b.type==='d1').length===1&&bindings.some(b=>b.type==='d1'&&b.name==='DB'&&(b.id??b.database_id)===PIN.d1),'dedicated_d1_unproven');
 const vars=Object.fromEntries(bindings.filter(b=>b.type==='plain_text').map(b=>[b.name,String(b.text??b.value??'')]));
 assert(vars.PAWSPACE_STAGING_BUILD_SHA===PIN.sha&&vars.PAWSPACE_UAT_LOGIN==='on'&&vars.PAWSPACE_COMMUNICATION_ENV==='uat'&&vars.PAWSPACE_PAYMENT_ENV==='sandbox'&&vars.PAWSPACE_PAYMENT_LIVE_APPROVED==='false'&&vars.PAWSPACE_RAZORPAYX_ENV==='sandbox'&&vars.PAWSPACE_RAZORPAYX_LIVE_APPROVED==='false','runtime_flags_unproven');
 const required={app_users:['id','email','name','role_code','status'],role_definitions:['code','permissions_json'],canonical_pets:['id','customer_id']};
 for(const [table,cols] of Object.entries(required)){const names=await query('SELECT name FROM pragma_table_info(?)',[table]);assert(cols.every(c=>names.some(r=>r.name===c)),'schema_unproven_'+table)}
 const exitCols=await query("SELECT name FROM pragma_table_info('employee_exit_cases')");assert(exitCols.length===0||['id','identity_email','user_id','status','access_ends_at'].every(c=>exitCols.some(r=>r.name===c)),'exit_schema_unproven');receipt.schemaQualified=true;
 // Existing actual resolver verifies existing Founder UAT cookie and active directory role.
 const founderCookie='pawspace_uat='+encodeURIComponent(await issueUatToken({PAWSPACE_UAT_SIGNING_KEY:env.PAWSPACE_UAT_SIGNING_KEY},'founder@pawspace.in',600));
 const actor=await resolveUatStaffActor(db,new Request(PIN.origin+'/api/uat-scheduling',{headers:{cookie:founderCookie}}),{...vars,PAWSPACE_UAT_SIGNING_KEY:env.PAWSPACE_UAT_SIGNING_KEY});
 assert(actor?.roleCode==='founder'&&actor.identitySource==='workspace'&&actor.principalType==='email'&&actor.principalKey==='founder@pawspace.in'&&actor.permissions.includes('*'),'normal_founder_actor_unproven');
 const pet=await query("SELECT (customer_id='CUS0000') owned FROM canonical_pets WHERE id=?",['PET-CUS0000-CUS0000P0']);assert(pet.length===1&&pet[0].owned===1,'cus0000_pet_ownership_unproven');
 receipt.actor={active:true,role:'founder',normalStaffUatResolver:true,onBehalfOfCustomerAllowedByNormalGuards:true,cus0000SavedPetOwned:true,platformSessionCookiesAbsent:true};save();
 const cookie='pawspace_uat='+encodeURIComponent(await issueUatToken({PAWSPACE_UAT_SIGNING_KEY:env.PAWSPACE_UAT_SIGNING_KEY},'founder@pawspace.in',120));
 const fixture=await(await request(PIN.origin+'/__staging/fixture-isolation?scope=grooming_strict&expectedSha='+PIN.sha,{method:'GET',headers:{cookie}},'fixed_fixture_get')).json();
 const keys=['paymentSandbox','payoutsSandbox','communicationsUat','voiceNotLive','customerLiveOtpDisabled','productionOtpDisabled','schedulerUat','customerFixtureProven','customerOtpTargetUnambiguous','specificGroomerFixtureProven','groomerOtpTargetUnambiguous','genericExcluded','metaExcluded','voiceExcluded'];
 assert(fixture.ok===true&&fixture.scope==='grooming_strict'&&fixture.version?.id===PIN.version&&fixture.version?.buildSha===PIN.sha&&keys.every(k=>fixture.checks?.[k]===true),'cancellation_recipient_isolation_unproven');
 receipt.isolation={checks:Object.fromEntries(keys.map(k=>[k,true])),sameVersion:true,cus0000AndSelectedGroomerOnly:true,staffFallbackRecipientsCovered:false,alternateProviderTablesCovered:false,assignmentLock:false};
 await active();
 const previewBytes=readFileSync(new URL('./preview-request.json',import.meta.url));assert(createHash('sha256').update(previewBytes).digest('hex')==='e07c302a44c72703097394d2b3a8bf7b169ee1cf56823aa3dc954fdc5046c364','exact_preview_bytes_refused');
 const preview=JSON.parse(previewBytes.toString('utf8'));
 assert(preview.action==='preview'&&preview.clientRequestId==='FINANCE-TEST-OPS-GROOMING-01-HOSTED-FT-20261011-03'&&preview.customerId==='CUS0000'&&JSON.stringify(preview.petIds)==='["PET-CUS0000-CUS0000P0"]'&&preview.serviceCode==='grooming'&&preview.cityId==='blr'&&preview.zoneId==='blr-south'&&preview.saveAddress===false&&preview.providerSelection==='specific'&&preview.preferredProviderId==='uatcap_groom_ft'&&preview.scheduledStart==='2026-10-11T06:30:00Z'&&preview.scheduledEnd==='2026-10-11T08:30:00Z','fixed_preview_request_refused');
 const quoteInput={packageCode:'dog-bath',scheduledStart:preview.scheduledStart,cityId:'blr',zoneId:'blr-south',quantity:1};
 const post=async(path,body,label)=>{receipt.operations.push({label,state:'pending_before_single_request'});save();const response=await request(PIN.origin+path,{method:'POST',headers:{cookie:founderCookie,'content-type':'application/json'},body:JSON.stringify(body)},label);return response.json()};
 const quote=(await post('/api/pricing-quote',quoteInput,'normal_price_quote')).data;
 assert(quote?.packageCode==='dog-bath'&&quote.finalPrice===1349&&quote.taxInclusive===true&&quote.couponDiscount===0,'fresh_1349_quote_unproven');receipt.quote={finalPriceInr:1349,taxInclusive:true,couponDiscountInr:0};save();
 const result=(await post('/api/uat-scheduling',preview,'single_normal_authenticated_preview')).data;
 assert(result?.availabilityChecked===true&&result.reserved===false&&result.cityId==='blr'&&result.zoneId==='blr-south'&&result.scheduledStart===preview.scheduledStart&&result.scheduledEnd===preview.scheduledEnd&&Array.isArray(result.providers),'preview_contract_refused');
 receipt.preview={availabilityChecked:true,reserved:false,targetProviderAvailable:result.providers.some(p=>p.id==='uatcap_groom_ft'&&p.model==='full_time'),exactWindow:true,exactCustomerPetRequest:true};save();
 assert(receipt.preview.targetProviderAvailable,'selected_groomer_unavailable');await active();receipt.ok=true;receipt.qualifiedScope='Normal Founder authenticated fixed customer/pet preview and fresh governed1349 price; no reservation/canonical booking or payment request';receipt.next='Use normal reserve with exact accepted request and fresh current terms, then canonical pay_after_service. Old malformed booking untouched.';save();console.log('Normal Founder fixed Grooming preview and1349 price qualified; reserved=false.');
 }catch(error){receipt.ok=false;receipt.failure=/^[a-zA-Z0-9_]+$/.test(error.message)?error.message:'read_failed_private_details_withheld';save();throw Error(receipt.failure)}
 return receipt;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)run().catch(e=>{console.error(e.message);process.exitCode=1});
