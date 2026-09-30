// Operational staging overlay for one explicitly authorized, non-rerunnable attended job.
// No dial operation and no application policy override. The workflow always restores the pause.
import {pathToFileURL} from 'node:url';
import {authorizedLaunchTester} from './voice-sales-launch-preflight.mjs';
export async function openAttendedVoiceWindow(env=process.env,request=fetch,options={}){
 if(env.PILOT_ACTION!=='attended-specialist-uat'||String(env.GITHUB_RUN_ATTEMPT)!=='1'||env.SPECIALIST_USE_CASE!=='grooming_sales')throw Error('One first-attempt attended Grooming job required');
 authorizedLaunchTester(env);
 if(!/^[a-f0-9]{40}$/.test(String(env.EXPECTED_SHA||''))||!env.SPECIALIST_CUSTOMER_ID)throw Error('Exact certified staging and canonical tester required');
 const account=String(env.CLOUDFLARE_ACCOUNT_ID||''),token=String(env.CLOUDFLARE_API_TOKEN||'');
 if(!/^[a-f0-9]{32}$/i.test(account)||!token||!env.STAGING_D1_ID||env.STAGING_D1_ID===env.PRODUCTION_D1_ID)throw Error('Isolated staging prerequisites required');
 const path=`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/pawspace-staging/settings`;
 async function api(init={}){const r=await request(path,{...init,headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(30000)}),b=await r.json();if(!r.ok||b.success!==true)throw Error('Attended settings operation refused');return b.result;}
 const metadataResponse=await request(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${encodeURIComponent(env.STAGING_D1_ID)}`,{headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(30000)});
 const metadata=await metadataResponse.json();
 if(!metadataResponse.ok||metadata.success!==true||metadata.result?.name!=='pawspace-staging'||metadata.result?.uuid!==env.STAGING_D1_ID)throw Error('Canonical isolated staging database not verified');
 const before=await api();
 const values=Object.fromEntries(before.bindings.filter(x=>x.type==='plain_text').map(x=>[x.name,x.text??x.value]));
 if(values.PAWSPACE_DEPLOYMENT_ENV!=='staging'||values.PAWSPACE_PAYMENT_ENV!=='sandbox'||values.PAWSPACE_VOICE_PHONE_TESTS_PAUSED!=='true'||values.PAWSPACE_VOICE_ENV!=='disabled'||!before.bindings.some(x=>x.type==='d1'&&x.name==='DB'&&x.id===env.STAGING_D1_ID))throw Error('Paused isolated ElevenLabs staging required');
 const origin='https://pawspace-staging.karthik-fce.workers.dev';
 const login=await request(origin+'/api/staging-login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email:'founder@pawspace.in',code:env.PAWSPACE_UAT_ACCESS_CODE}),redirect:'manual',signal:AbortSignal.timeout(20000)});
 const cookie=(login.headers.get('set-cookie')||'').split(';',1)[0];
 if(!login.ok||!cookie.startsWith('pawspace_uat='))throw Error('Attended runtime authentication refused');
 const readiness=await request(origin+'/api/voice-outbound',{headers:{cookie},signal:AbortSignal.timeout(30000)}),runtime=await readiness.json();
 if(!readiness.ok||runtime.data?.transport?.provider!=='elevenlabs_exotel'||runtime.data?.gate?.mode!=='disabled'||runtime.data?.gate?.enabled!==false)throw Error('Paused isolated ElevenLabs staging required');
 const changes={PAWSPACE_VOICE_PHONE_TESTS_PAUSED:'false',PAWSPACE_VOICE_ENV:'uat',PAWSPACE_VOICE_UAT_APPROVED:'true',PAWSPACE_VOICE_UAT_AI_SELF_TEST_APPROVED:'true',PAWSPACE_VOICE_SALES_OUTBOUND_APPROVED:'true',PAWSPACE_VOICE_NATIVE_UAT_APPROVED:'false',PAWSPACE_VOICE_UAT_AUTORUN:'false'};
 const bindings=before.bindings.filter(x=>!(x.name in changes)).map(x=>({name:x.name,type:'inherit',version_id:'latest'}));
 bindings.push(...Object.entries(changes).map(([name,text])=>({name,type:'plain_text',text})));
 const annotations=Object.fromEntries(Object.entries(before.annotations||{}).filter(([key])=>['workers/message','workers/tag'].includes(key)));
 const form=new FormData();form.set('settings',new Blob([JSON.stringify({bindings,annotations})],{type:'application/json'}));
 await api({method:'PATCH',body:form});
 const after=await api(),afterVars=Object.fromEntries(after.bindings.filter(x=>x.type==='plain_text').map(x=>[x.name,x.text??x.value]));
 if(!Object.entries(changes).every(([name,value])=>afterVars[name]===value)||!after.bindings.some(x=>x.type==='d1'&&x.name==='DB'&&x.id===env.STAGING_D1_ID)||before.bindings.some(x=>!after.bindings.some(y=>y.name===x.name)))throw Error('Attended settings readback failed; restore phone pause');
 // Worker settings readback can precede propagation to live requests. Never dial on metadata alone.
 const delay=options.delay||((ms)=>new Promise(resolve=>setTimeout(resolve,ms)));
 let effective=false;
 for(let attempt=0;attempt<5;attempt++){
  const r=await request(origin+'/api/voice-outbound',{headers:{cookie},signal:AbortSignal.timeout(5000)}),b=await r.json();
  const a=await request(origin+'/api/voice-outbound?scope=ai_self_test',{headers:{cookie},signal:AbortSignal.timeout(5000)}),ab=await a.json();
  if(!r.ok||!a.ok)throw Error('Effective attended approval read refused');
  const gate=b.data?.gate,ai=ab.data;
  effective=b.data?.transport?.provider==='elevenlabs_exotel'&&gate?.mode==='uat'&&gate?.enabled===true&&gate?.uatApproved===true&&gate?.salesOutboundApproved===true&&gate?.allowlistSize===1&&ai?.mode==='uat'&&ai?.approved===true&&ai?.singleRecipient===true;
  if(effective)break;
  if(attempt<4)await delay(2000);
 }
 if(!effective)throw Error('Attended approvals have not reached the live runtime; do not dial');
 console.log('ATTENDED_VOICE_WINDOW='+JSON.stringify({verified:true,mode:'uat',provider:'elevenlabs',nativeApproved:false,autorun:false,dialed:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await openAttendedVoiceWindow();
