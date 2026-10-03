import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const EXPECTED_DATABASE='1b879a28-c8a9-40b0-830d-1ce439061a00';
const MIGRATION_SHA='cf1dd681559e47976a10e3818b4a205505e92958e217e3989af68abde4bf416e';
const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const canonical=value=>value.split(/('(?:''|[^'])*')/).map((part,index)=>index%2?part:part.replace(/\bIF\s+NOT\s+EXISTS\b/gi,'').replace(/\s+/g,'').replace(/;$/,'').toUpperCase()).join('');
const NORMAL_SQL='SELECT id,provider,model_ref,channel,intent,reserved_tokens,reserved_cost_micros,actual_tokens,actual_cost_micros,status,failure_class,created_at,updated_at FROM ai_provider_runtime_requests ORDER BY id LIMIT 10001';
const LEDGER_SQL='SELECT id,job_id,rate_version,thread_id,input_upper,output_upper,reserved_micros,status,actual_upper_micros,created_at FROM atlas_text_test_requests ORDER BY id LIMIT 10001';
const SCHEMA_SQL="SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name IN ('atlas_text_test_requests','atlas_text_test_job') ORDER BY name";
export async function applyLedger({env,sql,transport=fetch,evidencePath}){
 const receipt={kind:'fixed_existing_staging_additive_ledger',observedAt:new Date().toISOString(),expectedServingSha:env.EXPECTED_SHA,sourceCommit:env.GITHUB_SHA,worker:'pawspace-staging',migrationSha256:digest(sql),mutationRequests:0,providerRequests:0,allocationsCreated:0,credentialsEmitted:false,historicalAtlasChargesKnown:false,paidAuthority:'expired',uncertainMutation:false};
 const save=()=>{receipt.phase=phase;writeFileSync(evidencePath,JSON.stringify(receipt,null,2)+'\n');};
 let phase='validate';
 try{
  if(env.CONFIRM!=='atlas-additive-ledger'||!/^ops\/atlas-ledger-additive-/.test(env.GITHUB_REF_NAME??'')||env.STAGING_D1_ID!==EXPECTED_DATABASE||!/^c18b15caea9551505398746dc9335a962f17e8ae$/.test(env.EXPECTED_SHA??'')||!/^([a-f0-9]{32})$/.test(env.CLOUDFLARE_ACCOUNT_ID??'')||!env.CLOUDFLARE_API_TOKEN||receipt.migrationSha256!==MIGRATION_SHA)throw Error('fixed_target_or_source_refused');
  const statements=sql.split('\n').filter(line=>!line.startsWith('--')).join('\n').split(';').map(s=>s.trim()).filter(Boolean);
  if(statements.length!==2||!statements[0].startsWith('CREATE TABLE IF NOT EXISTS atlas_text_test_requests (')||!statements[1].startsWith('CREATE INDEX IF NOT EXISTS atlas_text_test_job ON atlas_text_test_requests(job_id,status)'))throw Error('migration_shape_refused');
  const query=async(statement,mutation=false)=>{
   if(mutation){receipt.mutationRequests++;receipt.uncertainMutation=true;save();}
   let response;
   try{response=await transport(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.STAGING_D1_ID}/query`,{method:'POST',headers:{authorization:`Bearer ${env.CLOUDFLARE_API_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({sql:statement,params:[]}),redirect:'error',signal:AbortSignal.timeout(20000)});}catch{if(mutation)receipt.uncertainMutation=true;throw Error(mutation?'migration_result_unknown_no_retry':'read_transport_failed_no_retry');}
   if(!response.ok){if(mutation)receipt.uncertainMutation=true;throw Error(`d1_http_${response.status}_no_retry`);}
   let payload;try{payload=await response.json();}catch{if(mutation)receipt.uncertainMutation=true;throw Error('d1_response_unreadable_no_retry');}
   if(payload.success!==true||!Array.isArray(payload.result)||payload.result.length!==1||payload.result[0].success!==true){if(mutation)receipt.uncertainMutation=true;throw Error('d1_result_unqualified_no_retry');}
   const block=payload.result[0];if(!Array.isArray(block.results)){if(mutation)receipt.uncertainMutation=true;throw Error('d1_results_unqualified_no_retry');}
   if(!mutation&&(block.meta?.changed_db!==false||block.meta?.rows_written!==0))throw Error('read_write_metadata_unproven');
   if(mutation){receipt.uncertainMutation=false;save();}
   return block.results;
  };
  const validate=rows=>{for(const r of rows){const expected=r.name==='atlas_text_test_requests'?statements[0]:r.name==='atlas_text_test_job'?statements[1]:null;if(!expected||r.type!==(r.name==='atlas_text_test_job'?'index':'table')||r.tbl_name!=='atlas_text_test_requests'||typeof r.sql!=='string'||canonical(r.sql)!==canonical(expected))throw Error('existing_schema_incompatible_no_repair');}if(new Set(rows.map(r=>r.name)).size!==rows.length)throw Error('duplicate_schema');};
  phase='schema_before';const beforeSchema=await query(SCHEMA_SQL);validate(beforeSchema);
  phase='accounting_before';const before=await query(NORMAL_SQL);if(before.length>10000)throw Error('accounting_snapshot_bound_exceeded');
  const hasLedger=beforeSchema.some(r=>r.name==='atlas_text_test_requests');const priorLedger=hasLedger?await query(LEDGER_SQL):null;if(priorLedger?.length>10000)throw Error('ledger_snapshot_bound_exceeded');
  receipt.normalBefore={rows:before.length,digest:digest(before),reservedTokens:before.reduce((n,r)=>n+Number(r.reserved_tokens),0),reservedCostMicros:before.reduce((n,r)=>n+Number(r.reserved_cost_micros),0)};
  receipt.ledgerBefore=priorLedger===null?{present:false,historyUnknown:true}:{present:true,rows:priorLedger.length,digest:digest(priorLedger)};
  save();
  for(let i=0;i<statements.length;i++){phase=`create_${i+1}`;await query(statements[i],true);receipt.lastConfirmedMutation=i+1;save();}
  phase='verify_schema';const afterSchema=await query(SCHEMA_SQL);validate(afterSchema);if(afterSchema.length!==2)throw Error('post_schema_incomplete');
  phase='accounting_after';const after=await query(NORMAL_SQL),afterLedger=await query(LEDGER_SQL);if(after.length>10000||afterLedger.length>10000)throw Error('accounting_snapshot_bound_exceeded');
  receipt.normalAfter={rows:after.length,digest:digest(after),reservedTokens:after.reduce((n,r)=>n+Number(r.reserved_tokens),0),reservedCostMicros:after.reduce((n,r)=>n+Number(r.reserved_cost_micros),0)};
  receipt.ledgerAfter={present:true,rows:afterLedger.length,digest:digest(afterLedger)};
  receipt.normalHistoryUnchanged=receipt.normalBefore.digest===receipt.normalAfter.digest;
  receipt.existingAtlasHistoryUnchanged=priorLedger===null?afterLedger.length===0:digest(priorLedger)===digest(afterLedger);
  if(!receipt.normalHistoryUnchanged||!receipt.existingAtlasHistoryUnchanged)throw Error('concurrent_accounting_change_requires_reconciliation_no_repair');
  receipt.schemaCompatible=true;receipt.ok=true;phase='complete';save();return receipt;
 }catch(error){receipt.ok=false;receipt.phase=phase;receipt.failure=String(error.message);save();throw Error(receipt.failure);}
}
if(process.argv[1]?.endsWith('apply-ledger-hosted.mjs')){
 try{await applyLedger({env:process.env,sql:readFileSync(new URL('./atlas-text-test-additive.sql',import.meta.url),'utf8'),evidencePath:process.env.EVIDENCE_PATH||'atlas-additive-ledger.json'});console.log('Fixed staging additive schema and retained accounting verified.');}catch(error){console.error(error.message);process.exitCode=1;}
}
