const END=Date.parse('2026-10-04T03:30:00Z'),START=Date.parse('2026-10-04T02:21:19Z');
const fail=()=>{throw new Error('FINANCE_TEST_OUTBOUND_DENIED')};
export function installGenerationGuard(target=globalThis,now=()=>Date.now()){
 const native=target.fetch.bind(target);
 const guarded=async(input,init)=>{
  if(now()<START||now()>=END||typeof input!=='string'||!init)fail();
  const method=init.method,bodyString=init.body,headerInput=init.headers,signalInput=init.signal;
  if(method!=='POST'||typeof bodyString!=='string')fail();
  const u=new URL(input);if(input!=='https://api.openai.com/v1/responses'||u.search||u.hash||u.username||u.password||u.port)fail();
  if(new TextEncoder().encode(bodyString).length>20000)fail();
  let p;try{p=JSON.parse(bodyString)}catch{fail()}
  if(!p||Array.isArray(p)||Object.keys(p).sort().join(',')!=='input,instructions,max_output_tokens,model,prompt_cache_options,service_tier,store,truncation')fail();
  if(p.model!=='gpt-5.6-terra'||typeof p.instructions!=='string'||typeof p.input!=='string'||!Number.isSafeInteger(p.max_output_tokens)||p.max_output_tokens<1||p.max_output_tokens>1200||p.store!==false||p.service_tier!=='default'||p.truncation!=='disabled'||!p.prompt_cache_options||Object.keys(p.prompt_cache_options).join(',')!=='mode'||p.prompt_cache_options.mode!=='explicit')fail();
  const headers=new Headers(headerInput);if(headers.get('content-type')!=='application/json'||!/^Bearer [^\s]+$/.test(headers.get('authorization')??''))fail();
  if([...headers.keys()].some(k=>!['authorization','content-type'].includes(k)))fail();
  const remaining=END-now();if(remaining<=0)fail();
  const deadline=new AbortController();
  const timer=setTimeout(()=>deadline.abort(new Error('FINANCE_TEST_OUTBOUND_TIMEOUT')),Math.min(30000,remaining));
  const signal=AbortSignal.any([deadline.signal,...(signalInput?[signalInput]:[])]);
  let rejectAbort;const aborted=new Promise((_,reject)=>{rejectAbort=reject});
  const onAbort=()=>rejectAbort(signal.reason??new Error('FINANCE_TEST_OUTBOUND_TIMEOUT'));
  signal.addEventListener('abort',onAbort,{once:true});
  let reader;
  try{
   if(signal.aborted)throw signal.reason;
   const response=await Promise.race([native(input,{method:'POST',body:bodyString,headers,credentials:'omit',redirect:'manual',signal}),aborted]);
   if(response.status>=300&&response.status<400)fail();
   reader=response.body?.getReader();let bytes=0;const chunks=[];
   if(reader)while(true){
    if(signal.aborted)throw signal.reason;
    const {done,value}=await Promise.race([reader.read(),aborted]);if(done)break;
    bytes+=value.byteLength;if(bytes>262144)fail();chunks.push(value);
   }
   const body=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength}
   return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
  }catch(error){
   // Cancellation may itself stall; refusal must never await it.
   if(reader)void reader.cancel(error).catch(()=>{});
   throw error;
  }finally{clearTimeout(timer);signal.removeEventListener('abort',onAbort)}
 };
 Object.defineProperty(target,'fetch',{value:guarded,writable:false,configurable:false});
 Object.defineProperty(target,'WebSocket',{value:class{constructor(){fail()}},writable:false,configurable:false});
 return guarded;
}
