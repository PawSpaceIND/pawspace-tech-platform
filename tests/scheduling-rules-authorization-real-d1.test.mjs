import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {rm} from "node:fs/promises";
import {createServer} from "node:net";

const persistDir=`.scheduling-rules-authorization-${process.pid}`;
async function freePort(){return new Promise((resolve,reject)=>{const server=createServer();server.once("error",reject);server.listen(0,"127.0.0.1",()=>{const address=server.address();if(!address||typeof address==="string"){server.close();reject(new Error("unable to allocate local port"));return;}const port=address.port;server.close(error=>error?reject(error):resolve(port));});});}
async function waitForHealth(port,child,readLogs){for(let i=0;i<60;i+=1){if(child.exitCode!==null)throw new Error(`scheduling rules authorization worker exited before health: ${child.exitCode}\n${readLogs()}`);try{const response=await fetch(`http://127.0.0.1:${port}/health`);if(response.ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,500));}throw new Error(`scheduling rules authorization worker did not become ready\n${readLogs()}`);}
function signalWorker(child,signal){if(child.exitCode!==null)return;if(process.platform==="win32"){child.kill(signal);return;}try{process.kill(-child.pid,signal);}catch(error){if(error?.code!=="ESRCH")throw error;}}
async function stopWorker(child){if(child.exitCode!==null)return;let exited=false;const exitPromise=new Promise(resolve=>child.once("exit",()=>{exited=true;resolve();}));signalWorker(child,"SIGTERM");await Promise.race([exitPromise,new Promise(resolve=>setTimeout(resolve,2000))]);if(!exited&&child.exitCode===null){signalWorker(child,"SIGKILL");await Promise.race([exitPromise,new Promise(resolve=>setTimeout(resolve,2000))]);}}

test("scheduling rule reads require view, writes require manage, and denied operations preserve D1",{timeout:120000},async()=>{
 await rm(persistDir,{recursive:true,force:true});const port=await freePort();let logs="";
 const child=spawn(process.platform==="win32"?"npx.cmd":"npx",["wrangler","dev","--config","wrangler.scheduling-rules-authorization.jsonc","--persist-to",persistDir,"--port",String(port)],{stdio:["ignore","pipe","pipe"],detached:process.platform!=="win32",env:{...process.env,XDG_CONFIG_HOME:`${process.cwd()}/${persistDir}/xdg`,WRANGLER_SEND_METRICS:"false"}});
 child.stdout.on("data",chunk=>{logs+=String(chunk);});child.stderr.on("data",chunk=>{logs+=String(chunk);});
 try{await waitForHealth(port,child,()=>logs);const response=await fetch(`http://127.0.0.1:${port}/run`);const result=await response.json();assert.equal(response.status,200,`authorization worker failed: ${JSON.stringify(result)}\n${logs}`);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.readPermission,"scheduling.view");assert.equal(result.writePermission,"scheduling.manage");assert.equal(result.anonymousReadDenied,true);assert.equal(result.providerReadAllowed,true);assert.equal(result.customerReadDenied,true);assert.equal(result.managerReadAllowed,true);assert.equal(result.anonymousWritesDeniedAndUnchanged,true);assert.equal(result.providerWritesDeniedAndUnchanged,true);assert.equal(result.customerWritesDeniedAndUnchanged,true);assert.equal(result.managerWritesAllowed,true);assert.equal(result.creatorAttributedToActor,true);assert.equal(result.malformedConditionsDeniedAndUnchanged,true);assert.equal(result.nonBooleanActiveDeniedAndUnchanged,true);}finally{await stopWorker(child);await rm(persistDir,{recursive:true,force:true});}
});
