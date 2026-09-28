// Dedicated staging repair: never creates/deletes phone imports and never dials.
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
export function indiaNumber(value){
 let digits=String(value||'').replace(/\D/g,'');
 if(digits.length===12&&digits.startsWith('91'))digits=digits.slice(2);
 else if(digits.length===11&&digits.startsWith('0'))digits=digits.slice(1);
 if(!/^\d{10}$/.test(digits))throw Error('Invalid Indian virtual number');
 return '+91'+digits;
}
export function selectVoiceRepairConfig(exophones,imports){
 const owned=exophones.filter(p=>p.capabilities?.voice&&String(p.region).toUpperCase()==='KA'&&String(p.phone_number).replace(/\D/g,'').endsWith('1196')&&String(p.voice_url).endsWith('/start_voice/1347515'));
 if(owned.length!==1)throw Error('Dedicated staging ExoPhone is missing or ambiguous');
 const caller=indiaNumber(owned[0].phone_number);
 const matching=imports.filter(p=>p.provider==='exotel'&&indiaNumber(p.phone_number)===caller);
 if(matching.length!==1)throw Error('Exact staging ElevenLabs import is missing or ambiguous');
 const id=String(matching[0].phone_number_id||'');
 if(!/^phnum_[a-zA-Z0-9]+$/.test(id))throw Error('Invalid imported phone identity');
 return {ELEVENLABS_AGENT_PHONE_NUMBER_ID:id,EXOTEL_CALLER_ID:caller,EXOTEL_VOICE_APP_ID:'1347515'};
}
export async function repairStagingVoice(env=process.env,request=fetch){
 const action=env.VOICE_REPAIR_ACTION;
 if(!['prepare-staging-voice-config','sync-staging-voice-config'].includes(action))throw Error('Explicit staging repair action required');
 const host=env.EXOTEL_SUBDOMAIN||'api.exotel.com';
 if(!['api.exotel.com','api.in.exotel.com'].includes(host))throw Error('Invalid Exotel host');
 const read=async(url,headers,init={})=>{const r=await request(url,{headers,...init,signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('Voice configuration request refused: '+r.status);return r.json();};
 const ex=await read('https://'+host+'/v2_beta/Accounts/'+encodeURIComponent(env.EXOTEL_SID)+'/IncomingPhoneNumbers',{authorization:'Basic '+Buffer.from(env.EXOTEL_API_KEY+':'+env.EXOTEL_API_TOKEN).toString('base64')});
 const headers={'xi-api-key':env.ELEVENLABS_API_KEY};
 const el=await read('https://api.elevenlabs.io/v1/convai/phone-numbers',headers);
 const selected=selectVoiceRepairConfig(ex.incoming_phone_numbers||[],Array.isArray(el)?el:el.phone_numbers||[]);
 const detail=await read('https://api.elevenlabs.io/v1/convai/phone-numbers/'+encodeURIComponent(selected.ELEVENLABS_AGENT_PHONE_NUMBER_ID),headers);
 if(indiaNumber(detail.phone_number)!==selected.EXOTEL_CALLER_ID)throw Error('Import identity changed during repair');
 // Only non-credential routing configuration enters this short-lived repository artifact.
 if(action==='prepare-staging-voice-config'){
  await writeFile('voice-repair-config.json',JSON.stringify(selected),{mode:0o600});
  console.log('VOICE_CONFIG_PREPARED='+JSON.stringify({callerLast4:'1196',appId:'1347515',phoneIdentityVerified:true,dialed:false}));return selected;
 }
 for(const [name,value]of Object.entries(selected))if(env[name]!==value)throw Error('Persist the exact staging environment configuration first: '+name);
 const cf='https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);
 const ch={authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,'content-type':'application/json'};
 const api=async(path,init={})=>{const b=await read(cf+path,ch,init);if(!b.success)throw Error('Cloudflare rejected staging configuration change');return b.result;};
 const deployments=await api('/workers/scripts/pawspace-staging/deployments');
 const versions=deployments.deployments?.[0]?.versions;
 if(versions?.length!==1||versions[0].percentage!==100)throw Error('Single active staging revision required');
 const version=await api('/workers/scripts/pawspace-staging/versions/'+versions[0].version_id);
 const bindings=version.resources?.bindings||[];
 const vars=Object.fromEntries(bindings.filter(b=>b.type==='plain_text').map(b=>[b.name,b.text??b.value]));
 if(vars.PAWSPACE_DEPLOYMENT_ENV!=='staging'||vars.PAWSPACE_PAYMENT_ENV!=='sandbox'||vars.PAWSPACE_PAYMENT_LIVE_APPROVED==='true'||!bindings.some(b=>b.type==='d1'&&(b.id??b.database_id)===env.STAGING_D1_ID))throw Error('Staging database/payment isolation not verified');
 const patch=Object.fromEntries(Object.entries(selected).map(([name,text])=>[name,{name,text,type:'secret_text'}]));
 await api('/workers/scripts/pawspace-staging/secrets-bulk',{method:'PATCH',body:JSON.stringify(patch)});
 console.log('VOICE_CONFIG_SYNCED='+JSON.stringify({worker:'pawspace-staging',callerLast4:'1196',appId:'1347515',keys:Object.keys(selected),dialed:false,productionChanged:false}));
 return selected;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await repairStagingVoice();
