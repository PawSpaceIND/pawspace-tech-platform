import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {rm} from "node:fs/promises";
import {waitForWranglerReady} from "./helpers/wrangler-ready.mjs";

const persistDir=`.financial-workforce-integrity-${process.pid}`;
async function waitForHealth(port,child,readLogs){for(let i=0;i<60;i+=1){if(child.exitCode!==null)throw new Error(`scheduling rules authorization worker exited before health: ${child.exitCode}\n${readLogs()}`);try{const response=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1000)});if(response.ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,500));}throw new Error(`scheduling rules authorization worker did not become ready\n${readLogs()}`);}
function signalWorker(child,signal){if(!Number.isInteger(child.pid)||child.exitCode!==null||child.signalCode!==null)return;if(process.platform==="win32"){child.kill(signal);return;}try{process.kill(-child.pid,signal);}catch(error){if(error?.code!=="ESRCH")throw error;}}
async function stopWorker(child){if(!Number.isInteger(child.pid)||child.exitCode!==null||child.signalCode!==null)return;let exited=false;const exitPromise=new Promise(resolve=>child.once("exit",()=>{exited=true;resolve();}));signalWorker(child,"SIGTERM");await Promise.race([exitPromise,new Promise(resolve=>setTimeout(resolve,2000))]);if(!exited&&child.exitCode===null){signalWorker(child,"SIGKILL");await Promise.race([exitPromise,new Promise(resolve=>setTimeout(resolve,2000))]);}}


for (const profile of ["sandbox", "live", "unset", "production", "app-production"]) {
 test(`financial/workforce integrity executes in native local D1 (${profile})`,{timeout:120000},async()=>{
  const dir=`${persistDir}-${profile}`;await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});let logs="";
  const args=["node_modules/wrangler/bin/wrangler.js","dev","--config","wrangler.financial-workforce-integrity.jsonc","--local","--ip","127.0.0.1","--persist-to",dir,"--port","0","--inspector-port","0"];
  if(profile==="production")args.push("--var","PAWSPACE_DEPLOYMENT_ENV:production");
  else if(profile==="app-production")args.push("--var","APP_ENV:production");
  else if(profile!=="sandbox")args.push("--var",`PAWSPACE_PAYMENT_ENV:${profile==='unset'?'':profile}`);
  const child=spawn(process.execPath,args,{stdio:["ignore","pipe","pipe","ipc"],detached:process.platform!=="win32",env:{...process.env,XDG_CONFIG_HOME:`${process.cwd()}/${dir}/xdg`,WRANGLER_SEND_METRICS:"false"}});
  child.stdout.on("data",chunk=>{logs+=String(chunk);});child.stderr.on("data",chunk=>{logs+=String(chunk);});
  try{const {port}=await waitForWranglerReady(child,()=>logs);await waitForHealth(port,child,()=>logs);const response=await fetch(`http://127.0.0.1:${port}/${profile==='sandbox'?'run':'guard'}`);const result=await response.json();assert.equal(response.status,200,`${JSON.stringify(result)}\n${logs}`);assert.equal(result.ok,true,JSON.stringify(result));if(profile==='sandbox'){assert.equal(result.nativeD1,true);assert.equal(result.passed.length,13);console.log(result.passed.join("\n"));}else assert.equal(result.disabledBeforeWrites,true);
  }finally{await stopWorker(child);await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
 });
}
