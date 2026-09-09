import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const persist=await mkdtemp(join(tmpdir(),'pawspace-integrity-'));
const port=Number(process.env.PAWSPACE_INTEGRITY_PORT||8891);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid local test port');
const worker=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','dev','--local','--config','wrangler.uat-integrity.jsonc','--persist-to',persist,'--ip','127.0.0.1','--port',String(port)],{stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
let logs='';worker.stdout.on('data',chunk=>{logs+=chunk});worker.stderr.on('data',chunk=>{logs+=chunk});
const origin=`http://127.0.0.1:${port}`;
try{
 let ready=false;
 for(let attempt=0;attempt<60;attempt++){
  if(worker.exitCode!==null)throw new Error('Local worker exited before becoming ready');
  try{const response=await fetch(`${origin}/health`,{signal:AbortSignal.timeout(1000)});if(response.ok){ready=true;break}}catch{}
  await delay(500);
 }
 if(!ready)throw new Error('Local worker did not become ready');
 const response=await fetch(`${origin}/run`,{signal:AbortSignal.timeout(60000)}),result=await response.json();
 console.log(JSON.stringify(result));
 if(!response.ok||!result.ok||!result.payoutRollback||!result.distinctCheckers||!result.subscriptionRollback||!result.subscriptionRetry||result.liveMoney!==false)throw new Error('UAT integrity D1 assertions failed');
}catch(error){console.error(logs);throw error}finally{
 if(worker.exitCode===null){
  if(process.platform==='win32')worker.kill('SIGTERM');else try{process.kill(-worker.pid,'SIGTERM')}catch(error){if(error.code!=='ESRCH')throw error}
  await Promise.race([new Promise(resolve=>worker.once('exit',resolve)),delay(5000)]);
  if(worker.exitCode===null){if(process.platform==='win32')worker.kill('SIGKILL');else try{process.kill(-worker.pid,'SIGKILL')}catch(error){if(error.code!=='ESRCH')throw error}}
 }
 await rm(persist,{recursive:true,force:true});
}
