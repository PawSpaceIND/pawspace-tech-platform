import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {issueUatToken,resolveUatStaffActor} from './issue-uat-token.mjs';
export const PIN={sha:'a1c14c7a72b897c1eafd3b33615f9684eee3d251',version:'87b3f06e-5a9d-4e3b-a251-f91677a63bff',d1:'1b879a28-c8a9-40b0-830d-1ce439061a00',origin:'https://pawspace-staging.karthik-fce.workers.dev'};
const assert=(ok,code)=>{if(!ok)throw Error(code)};
export function readResult(p){assert(p?.success===true&&Array.isArray(p.result)&&p.result.length===1,'d1_read_failed');const x=p.result[0];assert(x.success===true&&Array.isArray(x.results)&&x.meta?.rows_written===0&&x.meta?.changed_db===false,'d1_read_metadata_unproven');return x.results;}
export async function run(env=process.env,fetcher=fetch){
 const receipt={kind:'finance_prepaid_terminal_provider_reconciliation',pin:PIN,modelRequests:0,financialMutations:0,normalRouteMaintenancePossible:true,fixtureWritesRequested:false,operations:[],cancellationMutationPerformed:false};
 const save=()=>writeFileSync(env.EVIDENCE_PATH||'atlas-0006-hosted-schema-receipt.json',JSON.stringify(receipt,null,2)+'\n');
 const account=env.CLOUDFLARE_ACCOUNT_ID,token=env.CLOUDFLARE_API_TOKEN;
 async function request(url,init,label){receipt.operations.push({label,state:'read_pending'});save();const op=receipt.operations.at(-1);let response;try{response=await fetcher(url,{...init,redirect:'manual',signal:AbortSignal.timeout(20000)});}catch{op.state='read_failed';throw Error('transport_failed_'+label)}op.httpStatus=response.status;assert(response.ok,'http_refused_'+label);op.state='read_received';save();return response;}
 const cf=async(path,body)=>{const r=await request(`https://api.cloudflare.com/client/v4/accounts/${account}/${path}`,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})},body?'d1_select':'native_read');const p=await r.json();assert(p?.success===true,'native_read_failed');return p;};
 const query=async(sql,params=[])=>{assert(/^SELECT\s/i.test(sql)&&!sql.includes(';'),'select_only');return readResult(await cf(`d1/database/${PIN.d1}/query`,{sql,params}));};
 const db={prepare(sql){let params=[];return{bind(...v){params=v;return this},async first(){return(await query(sql,params))[0]??null}}}};
 const active=async()=>{const p=(await cf('workers/scripts/pawspace-staging/deployments')).result;assert(p?.deployments?.[0]?.versions?.length===1&&p.deployments[0].versions[0].percentage===100&&p.deployments[0].versions[0].version_id===PIN.version,'active_version_unproven');};
 try{
 assert(env.CONFIRM==='read-only-atlas-0006-hosted-schema'&&env.GITHUB_RUN_ATTEMPT==='1'&&/^ops\/atlas-session-/.test(env.GITHUB_REF_NAME||'')&&env.EXPECTED_SHA===env.GITHUB_SHA,'execution_scope_refused');
 assert(/^[a-f0-9]{32}$/.test(account||'')&&token&&env.PAWSPACE_UAT_SIGNING_KEY?.length>=32,'existing_credentials_missing');
 await active();const version=(await cf(`workers/scripts/pawspace-staging/versions/${PIN.version}`)).result,bindings=version?.resources?.bindings;
 assert(Array.isArray(bindings)&&bindings.filter(b=>b.type==='d1').length===1&&bindings.some(b=>b.type==='d1'&&b.name==='DB'&&(b.id??b.database_id)===PIN.d1),'dedicated_d1_unproven');
 const vars=Object.fromEntries(bindings.filter(b=>b.type==='plain_text').map(b=>[b.name,String(b.text??b.value??'')]));
 assert(vars.PAWSPACE_STAGING_BUILD_SHA===PIN.sha&&vars.PAWSPACE_UAT_LOGIN==='on'&&vars.PAWSPACE_COMMUNICATION_ENV==='uat'&&vars.PAWSPACE_PAYMENT_ENV==='sandbox'&&vars.PAWSPACE_PAYMENT_LIVE_APPROVED==='false'&&vars.PAWSPACE_RAZORPAYX_ENV==='sandbox'&&vars.PAWSPACE_RAZORPAYX_LIVE_APPROVED==='false','runtime_flags_unproven');
 receipt.runtimeFlags={serviceWindowEnforcement:vars.PAWSPACE_SERVICE_WINDOW_ENFORCEMENT??null,deploymentEnvironment:vars.PAWSPACE_DEPLOYMENT_ENV??null,visualCompletionEnforce:vars.PAWSPACE_VISUAL_COMPLETION_ENFORCE??null,serviceExecutionClock:vars.PAWSPACE_SERVICE_EXECUTION_CLOCK??null};save();
 const cookie='pawspace_uat='+encodeURIComponent(await issueUatToken({PAWSPACE_UAT_SIGNING_KEY:env.PAWSPACE_UAT_SIGNING_KEY},'founder@pawspace.in',120));
 const actor=await resolveUatStaffActor(db,new Request(PIN.origin+'/api/grooming-payment-sandbox',{headers:{cookie}}),{...vars,PAWSPACE_UAT_SIGNING_KEY:env.PAWSPACE_UAT_SIGNING_KEY});
 assert(actor?.roleCode==='founder'&&actor.permissions.includes('*'),'normal_founder_authority_unproven');receipt.actor={normalUatFounder:true,verifiedActivePrincipal:true,credentialsEmitted:false};save();


 const quoteTables=['grooming_commercial_quotes','grooming_booking_quote_links'];
 receipt.quoteSchema={target:PIN,inspectionOnly:true,objects:await query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name IN (?,?) ORDER BY type,name",quoteTables),tables:{},invalidCounts:{}};save();
 for(const table of quoteTables){
  const exists=receipt.quoteSchema.objects.some(o=>o.type==='table'&&o.name===table);
  if(!exists){receipt.quoteSchema.tables[table]={exists:false};continue;}
  const columns=await query('SELECT * FROM pragma_table_info(?)',[table]);
  const indexes=await query('SELECT * FROM pragma_index_list(?)',[table]);
  receipt.quoteSchema.tables[table]={exists:true,columns,indexes,rowCount:(await query('SELECT COUNT(*) n FROM '+table))[0].n};
  for(const index of indexes)index.columns=await query('SELECT * FROM pragma_index_info(?)',[index.name]);save();
 }
 const link=receipt.quoteSchema.tables.grooming_booking_quote_links,quote=receipt.quoteSchema.tables.grooming_commercial_quotes;
 if(link.exists){receipt.quoteSchema.invalidCounts.nullOrEmptyQuoteId=(await query("SELECT COUNT(*) n FROM grooming_booking_quote_links WHERE quote_id IS NULL OR trim(quote_id)=''"))[0].n;
  if(quote.exists){receipt.quoteSchema.invalidCounts.missingQuote=(await query('SELECT COUNT(*) n FROM grooming_booking_quote_links l LEFT JOIN grooming_commercial_quotes q ON q.id=l.quote_id WHERE l.quote_id IS NOT NULL AND q.id IS NULL'))[0].n;
   receipt.quoteSchema.invalidCounts.quoteNotUsedOrBookingMismatch=(await query("SELECT COUNT(*) n FROM grooming_booking_quote_links l JOIN grooming_commercial_quotes q ON q.id=l.quote_id WHERE q.status<>'used' OR q.used_booking_id IS NULL OR q.used_booking_id<>l.booking_id"))[0].n;
  }
 }
 receipt.quoteSchema.assessment=!link.exists?'target_has_no_existing_quote_link_table':link.columns.some(c=>c.name==='quote_id'&&c.notnull===1)?'quote_id_explicit_not_null_present_check_SQL_for_remaining_guards':'prior_nullable_quote_id_upgrade_risk_applies';save();
 receipt.bindingPresence={mapsServerUat:bindings.some(b=>b.name==='GOOGLE_MAPS_SERVER_API_KEY_UAT'),mapsEnvironment:vars.PAWSPACE_MAPS_ENV??'sandbox(default)',testDiscoveryFixture:vars.PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE??null,rosterAuthority:vars.PAWSPACE_SCHEDULING_ENV??null};save();
 const timeframe={from:Date.parse('2026-10-04T10:38:00Z'),to:Date.parse('2026-10-04T10:41:00Z')};
 const telemetryBody={queryId:'training-address-read-20261004-1038',timeframe,dry:true,view:'events',limit:100,parameters:{filterCombination:'and',filters:[{key:'$metadata.service',operation:'eq',type:'string',value:'pawspace-staging'}],needle:{value:'/api/uat-scheduling',isRegex:false,matchCase:true}}};
 const tr=await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(telemetryBody),signal:AbortSignal.timeout(20000)});
 const tp=await tr.json();receipt.telemetry={httpStatus:tr.status,success:tp.success===true,timeframe,scope:'pawspace-staging /api/uat-scheduling only',responseKeys:Object.keys(tp.result||{}),errorCodes:(tp.errors||[]).map(e=>e.code),events:[]};
 function safeText(v){return String(v??'').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email-redacted]').replace(/\b(?:\+?91)?[6-9][0-9]{9}\b/g,'[phone-redacted]').slice(0,1800)}
 const raw=tp.result?.events?.events??tp.result?.events??[];receipt.telemetry.eventsShape=Array.isArray(raw)?'array':Object.keys(raw||{});
 if(Array.isArray(raw))for(const event of raw){const meta=event['$metadata']||{},worker=event['$workers']||{},request=worker.event?.request||{},response=worker.event?.response||{};let path;try{path=new URL(request.url||meta.trigger).pathname}catch{};
 receipt.telemetry.events.push({timestamp:event.timestamp??event.$timestamp,metadataId:meta.id,requestId:worker.requestId??meta.requestId,service:meta.service,origin:meta.origin,trigger:path,message:safeText(meta.message??event.message),error:safeText(meta.error),statusCode:meta.statusCode??response.status,method:request.method,scriptVersion:worker.scriptVersion?.id,outcome:worker.outcome,availableKeys:Object.keys(event)});}
 save();
 const matches=await query("SELECT c.id,c.city_id FROM canonical_customers c WHERE LOWER(TRIM(c.name)) LIKE 'mahesh%' AND EXISTS (SELECT 1 FROM canonical_pets p WHERE p.customer_id=c.id AND LOWER(TRIM(p.name))='simba') LIMIT 5");
 receipt.customerResolution={matchingCount:matches.length,method:'Mahesh name prefix AND owned pet Simba; not request attribution',requestAttributionProven:false};save();
 if(matches.length===1){const customerId=matches[0].id;receipt.customerResolution.customerId=customerId;
 const addresses=await query('SELECT id,line1,line2,area,city,postal_code,is_default,updated_at FROM customer_addresses WHERE customer_id=? ORDER BY is_default DESC,updated_at DESC,created_at DESC LIMIT 10',[customerId]);
 const geocodes=await query('SELECT address_id,pincode,city_id,zone_id,address_text,latitude,longitude,updated_at FROM customer_service_address_geocodes WHERE customer_id=? LIMIT 20',[customerId]);
 const pins=[...new Set(addresses.map(a=>a.postal_code).filter(Boolean))];receipt.addresses=addresses.map(a=>({id:a.id,area:a.area,city:a.city,pincode:a.postal_code,isDefault:a.is_default,line1Length:String(a.line1||'').length,addressPins:[...new Set((String(a.line1||'')+' '+String(a.line2||'')).match(/\b[1-9][0-9]{5}\b/g)||[])],updatedAt:a.updated_at,hasGeocode:geocodes.some(g=>g.address_id===a.id)}));
 receipt.geocodes=geocodes.map(g=>({addressId:g.address_id,pincode:g.pincode,cityId:g.city_id,zoneId:g.zone_id,addressTextLength:String(g.address_text||'').length,addressPins:[...new Set(String(g.address_text||'').match(/\b[1-9][0-9]{5}\b/g)||[])],finiteCoordinates:Number.isFinite(g.latitude)&&Number.isFinite(g.longitude),updatedAt:g.updated_at}));save();
 if(pins.length){receipt.zoneMappings=await query('SELECT pincode,zone_id,city_id,city,area FROM service_zone_mappings WHERE pincode IN ('+pins.map(()=>'?').join(',')+')',pins);}
 receipt.cityLaunchColumns=(await query("SELECT name FROM pragma_table_info('city_launch_configs')")).map(r=>r.name);
 const cs=receipt.cityLaunchColumns;if(cs.includes('city_code')&&cs.includes('status'))receipt.cityLaunch=await query('SELECT city_code,status FROM city_launch_configs WHERE city_code=?',[matches[0].city_id]);
 }
 await active();receipt.ok=true;receipt.mapsRequests=0;receipt.customerMutations=0;receipt.requestReplay=0;save();console.log('Scoped existing Training telemetry and address evidence read complete');
 }catch(error){receipt.ok=false;receipt.failure=/^[a-zA-Z0-9_]+$/.test(error.message)?error.message:'read_failed_private_details_withheld';save();throw Error(receipt.failure)}
 return receipt;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)run().catch(e=>{console.error(e.message);process.exitCode=1});
