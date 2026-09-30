// Explicit user-requested operational stop. Staging phone gates only; never dials.
const env=process.env;
if(env.PAUSE_PHONE_CALLS!=='user-requested-stop')throw Error('Explicit phone stop required');
const account=String(env.CLOUDFLARE_ACCOUNT_ID||''),token=String(env.CLOUDFLARE_API_TOKEN||'');
if(!/^[a-f0-9]{32}$/i.test(account)||!token||!env.STAGING_D1_ID||env.STAGING_D1_ID===env.PRODUCTION_D1_ID)throw Error('Isolated staging prerequisites required');
const base='https://api.cloudflare.com/client/v4/accounts/'+account;
async function api(path,init={}){const r=await fetch(base+path,{...init,headers:{authorization:'Bearer '+token,...init.headers},redirect:'error',signal:AbortSignal.timeout(30000)}),b=await r.json();if(!r.ok||b.success!==true)throw Error('Staging phone stop refused ('+r.status+')');return b.result;}
const path='/workers/scripts/pawspace-staging/settings',before=await api(path);
const vars=Object.fromEntries(before.bindings.filter(x=>x.type==='plain_text').map(x=>[x.name,x.text??x.value]));
if(vars.PAWSPACE_DEPLOYMENT_ENV!=='staging'||vars.PAWSPACE_PAYMENT_ENV!=='sandbox'||!before.bindings.some(x=>x.type==='d1'&&x.name==='DB'&&x.id===env.STAGING_D1_ID))throw Error('Live staging isolation not proven');
const changes={PAWSPACE_VOICE_PHONE_TESTS_PAUSED:'true',PAWSPACE_VOICE_ENV:'disabled',PAWSPACE_VOICE_UAT_APPROVED:'false',PAWSPACE_VOICE_NATIVE_UAT_APPROVED:'false',PAWSPACE_VOICE_UAT_AI_SELF_TEST_APPROVED:'false',PAWSPACE_VOICE_UAT_AUTORUN:'false',PAWSPACE_VOICE_SALES_OUTBOUND_APPROVED:'false'};
// Inherit every unaffected binding, including secrets, without reading or rewriting its value.
const bindings=before.bindings.filter(x=>!(x.name in changes)).map(x=>({name:x.name,type:'inherit',version_id:'latest'}));
bindings.push(...Object.entries(changes).map(([name,text])=>({name,type:'plain_text',text})));
const annotations=Object.fromEntries(Object.entries(before.annotations||{}).filter(([key])=>['workers/message','workers/tag'].includes(key)));
const form=new FormData();form.set('settings',new Blob([JSON.stringify({bindings,annotations})],{type:'application/json'}));
await api(path,{method:'PATCH',body:form});
const after=await api(path),afterVars=Object.fromEntries(after.bindings.filter(x=>x.type==='plain_text').map(x=>[x.name,x.text??x.value]));
if(!Object.entries(changes).every(([name,value])=>afterVars[name]===value)||!after.bindings.some(x=>x.type==='d1'&&x.name==='DB'&&x.id===env.STAGING_D1_ID)||before.bindings.some(x=>!after.bindings.some(y=>y.name===x.name)))throw Error('Phone stop readback failed');
console.log('STAGING_PHONE_CALLS_PAUSED='+JSON.stringify({verified:true,phoneTestsPaused:true,voiceMode:afterVars.PAWSPACE_VOICE_ENV,uatApproved:false,nativeApproved:false,selfTestApproved:false,autorun:false,outboundSalesApproved:false,unaffectedBindingNamesPreserved:true,dialed:false}));
