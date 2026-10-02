import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const SAFE_CODES=new Set(['invalid_api_key','missing_permissions','insufficient_permissions','needs_authorization','authentication_error','invalid_authorization','unauthorized','permission_denied','quota_exceeded']);
async function classify(response){
 const reader=response.body?.getReader();if(!reader)return 'missing_metadata_body';let bytes=0;const chunks=[];
 try{for(;;){const x=await reader.read();if(x.done)break;bytes+=x.value.byteLength;if(bytes>8192){void reader.cancel().catch(()=>{});return 'metadata_body_exceeded';}chunks.push(x.value);}const b=JSON.parse(Buffer.concat(chunks).toString());const code=b?.detail?.status??b?.error?.code??b?.code;return SAFE_CODES.has(code)?code:response.ok?'authenticated_metadata_read':'unclassified_provider_denial';}catch{return 'unclassified_provider_denial';}finally{reader.releaseLock();}
}
export async function diagnoseComponentCredential(env=process.env,fetcher=fetch){
 const region=String(env.ELEVENLABS_API_BASE||'https://api.elevenlabs.io').replace(/\/$/,'');
 if(!['https://api.elevenlabs.io','https://api.in.residency.elevenlabs.io'].includes(region))throw Error('diagnostic_region_unapproved');
 const report={metadataOnly:true,providerGenerationRequests:0,budgetLedgerWrites:0,origin:region,keyBindingPresent:Boolean(env.ELEVENLABS_API_KEY),keyBindingName:'ELEVENLABS_API_KEY',reads:[]};
 if(!report.keyBindingPresent)return report;
 // Same existing key/origin only. No credential or region fallback and no generation endpoints.
 for(const path of ['/v1/voices','/v1/user']){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{const r=await fetcher(region+path,{method:'GET',headers:{'xi-api-key':env.ELEVENLABS_API_KEY},redirect:'error',signal:controller.signal});report.reads.push({path,httpStatus:r.status,classification:await classify(r)});}catch{report.reads.push({path,httpStatus:null,classification:'metadata_transport_failed'});}finally{clearTimeout(timer);}
 }
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const report=await diagnoseComponentCredential();
 try{const {remoteComponentLedger}=await import('./run-component-audio.mjs');report.ledgerIdentity=(await remoteComponentLedger(process.env)).identityReceipt;}catch(e){report.ledgerIdentityGate=/^component_[a-zA-Z0-9_:]+$/.test(String(e?.message))?e.message:'component_identity_metadata_refused';}
 await mkdir('artifacts/component-credential-diagnostic',{recursive:true});await writeFile('artifacts/component-credential-diagnostic/report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
