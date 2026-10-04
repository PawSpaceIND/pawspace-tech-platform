import {writeFileSync} from 'node:fs';
import {sameSavedAddress} from '../../../lib/saved-address-identity.ts';
import {serviceAddressText} from '../../../lib/service-address-text.ts';
const env=process.env,version='b57e2ead-d931-4000-9a71-1dc40a9d238b',database='1b879a28-c8a9-40b0-830d-1ce439061a00';
const receipt={kind:'read_only_finance_preview_diagnosis',operations:[],databaseWrites:0,modelRequests:0,originRequests:0};
const save=()=>writeFileSync('finance-network-receipt.json',JSON.stringify(receipt,null,2)+'\n');
const check=(value,code)=>{if(!value)throw Error(code);};
const base=`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
async function api(path,body){
 const op={method:body?'POST_SELECT':'GET',state:'read_pending'};receipt.operations.push(op);save();
 const response=await fetch(base+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(20000)});
 const payload=await response.json().catch(()=>null);op.httpStatus=response.status;op.success=payload?.success===true;save();check(response.ok&&payload?.success===true,'read_refused');op.state='confirmed';save();return payload.result;
}
try{
 check(env.CONFIRM==='read-only-finance-preview-diagnosis'&&env.EXPECTED_SHA===env.GITHUB_SHA&&env.GITHUB_RUN_ATTEMPT==='1'&&/^ops\/finance-network-read-/.test(env.GITHUB_REF_NAME??''),'scope_refused');
 check(/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID??'')&&env.CLOUDFLARE_API_TOKEN,'existing_connection_missing');
 const script='/workers/scripts/pawspace-staging';
 const active=(await api(script+'/deployments'))?.deployments?.[0];check(active?.versions?.length===1&&active.versions[0].percentage===100&&active.versions[0].version_id===version,'normal_version_changed');
 const resource=await api(script+'/versions/'+version),bindings=resource.resources?.bindings;check(Array.isArray(bindings),'bindings_unproven');
 check(bindings.filter(x=>x.type==='d1').length===1&&bindings.some(x=>x.type==='d1'&&x.name==='DB'&&(x.id??x.database_id)===database),'dedicated_db_refused');
 const vars=Object.fromEntries(bindings.filter(x=>x.type==='plain_text').map(x=>[x.name,String(x.text??x.value??'')]));
 check(vars.PAWSPACE_STAGING_BUILD_SHA==='aec758b029c190e0df526925f35714f60c866d8b'&&vars.PAWSPACE_PAYMENT_ENV==='sandbox'&&vars.FORBID_PRODUCTION==='true','sandbox_revision_refused');
 check(!bindings.some(x=>['secret_text','secret_key'].includes(x.type)&&x.name==='PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE'),'fixture_flag_secret_unreadable');
 const truthy=v=>['1','true','on','yes'].includes(String(v??'').trim().toLowerCase());
 receipt.PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE=truthy(vars.PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE);
 receipt.serviceDiscoveryFixtureEnabled=receipt.PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE&&vars.PAWSPACE_PAYMENT_ENV.toLowerCase()==='sandbox'&&(String(vars.NODE_ENV??'').toLowerCase()==='test'||String(vars.PAWSPACE_SCHEDULING_ENV??'').toLowerCase()==='uat');
 const sql='SELECT a.line1,a.line2,a.area,a.city,a.postal_code,g.address_text,g.latitude,g.longitude,g.city_id AS geocode_city,g.zone_id AS geocode_zone,m.city_id AS resolved_city_id,m.zone_id AS resolved_zone_id,m.city AS resolved_city,m.area AS resolved_area,c.status AS launch_status,c.pincodes AS advertised_pincodes FROM customer_addresses a LEFT JOIN customer_service_address_geocodes g ON g.address_id=a.id AND g.customer_id=a.customer_id AND g.pincode=a.postal_code LEFT JOIN service_zone_mappings m ON m.pincode=a.postal_code LEFT JOIN city_launch_configs c ON c.city_code=m.city_id WHERE a.customer_id=? AND a.postal_code=? AND a.id=? ORDER BY a.is_default DESC,a.updated_at DESC,a.created_at DESC LIMIT 20';
 const queried=await api('/d1/database/'+database+'/query',{sql,params:['CUS0000','560068','ADDR-e6424a16199683132f2aec7b7d9be89fc231ac7057d545ef3d13c3912c219967']});check(queried?.length===1&&queried[0].success&&Array.isArray(queried[0].results)&&queried[0].meta.rows_written===0&&queried[0].meta.changed_db===false,'read_only_select_unproven');
 const rows=queried[0].results;receipt.ownedAddressCountWithinBound=rows.length;
 receipt.liveBengaluruAdvertises560068=rows.some(row=>row.resolved_city_id==='blr'&&row.launch_status==='Live'&&String(row.advertised_pincodes??'').split(/[,;\s]+/).includes('560068'));
 receipt.launchConfigurationPresent=rows.some(row=>typeof row.launch_status==='string');
 receipt.exactOwnedGeocodeRow=rows.some(row=>row.geocode_city==='blr'&&row.geocode_zone==='blr-south'&&typeof row.address_text==='string');
 receipt.cachedOwnedGeocode=rows.some(row=>{
  if(row.resolved_city_id!=='blr'||row.resolved_zone_id!=='blr-south'||row.geocode_city!==row.resolved_city_id||row.geocode_zone!==row.resolved_zone_id||typeof row.latitude!=='number'||typeof row.longitude!=='number'||!Number.isFinite(row.latitude)||!Number.isFinite(row.longitude)||row.latitude<-90||row.latitude>90||row.longitude<-180||row.longitude>180||typeof row.address_text!=='string')return false;
  const address=serviceAddressText({line1:row.line1,line2:row.line2,area:row.area,city:row.city,postalCode:'560068',country:'India'});
  return sameSavedAddress({line1:row.address_text,area:row.resolved_area,city:row.resolved_city,postalCode:'560068'},{line1:address,area:row.resolved_area,city:row.resolved_city,postalCode:'560068'});
 });
 receipt.servingVersion=version;receipt.servingSha=vars.PAWSPACE_STAGING_BUILD_SHA;receipt.target={customerId:'CUS0000',pincode:'560068',city:'blr',zone:'blr-south'};receipt.ok=true;receipt.completedAt=new Date().toISOString();save();
}catch(error){receipt.ok=false;receipt.failure=['scope_refused','existing_connection_missing','read_refused','normal_version_changed','bindings_unproven','dedicated_db_refused','sandbox_revision_refused','fixture_flag_secret_unreadable','read_only_select_unproven'].includes(error.message)?error.message:'read_transport_or_source_failed';save();process.exitCode=1;}
