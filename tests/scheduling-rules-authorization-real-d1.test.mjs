import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {rm} from "node:fs/promises";
import {createServer} from "node:net";
import {EventEmitter, once} from "node:events";
import {waitForWranglerReady} from "./helpers/wrangler-ready.mjs";

const persistDir=`.scheduling-rules-authorization-${process.pid}`;
async function waitForHealth(port,child,readLogs){for(let i=0;i<60;i+=1){if(child.exitCode!==null)throw new Error(`scheduling rules authorization worker exited before health: ${child.exitCode}\n${readLogs()}`);try{const response=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1000)});if(response.ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,500));}throw new Error(`scheduling rules authorization worker did not become ready\n${readLogs()}`);}
function signalWorker(child,signal){if(!Number.isInteger(child.pid)||child.exitCode!==null||child.signalCode!==null)return;if(process.platform==="win32"){child.kill(signal);return;}try{process.kill(-child.pid,signal);}catch(error){if(error?.code!=="ESRCH")throw error;}}
async function stopWorker(child){if(!Number.isInteger(child.pid)||child.exitCode!==null||child.signalCode!==null)return;let exited=false;const exitPromise=new Promise(resolve=>child.once("exit",()=>{exited=true;resolve();}));signalWorker(child,"SIGTERM");await Promise.race([exitPromise,new Promise(resolve=>setTimeout(resolve,2000))]);if(!exited&&child.exitCode===null){signalWorker(child,"SIGKILL");await Promise.race([exitPromise,new Promise(resolve=>setTimeout(resolve,2000))]);}}

test("scheduling rule reads require view, writes require manage, and denied operations preserve D1",{timeout:120000},async()=>{
 await rm(persistDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});let logs="";
 const child=spawn(process.execPath,["node_modules/wrangler/bin/wrangler.js","dev","--config","wrangler.scheduling-rules-authorization.jsonc","--local","--ip","127.0.0.1","--persist-to",persistDir,"--port","0","--inspector-port","0"],{stdio:["ignore","pipe","pipe","ipc"],detached:process.platform!=="win32",env:{...process.env,XDG_CONFIG_HOME:`${process.cwd()}/${persistDir}/xdg`,WRANGLER_SEND_METRICS:"false"}});
 child.stdout.on("data",chunk=>{logs+=String(chunk);});child.stderr.on("data",chunk=>{logs+=String(chunk);});
 try{const {port}=await waitForWranglerReady(child,()=>logs);await waitForHealth(port,child,()=>logs);const response=await fetch(`http://127.0.0.1:${port}/run`);const result=await response.json();assert.equal(response.status,200,`authorization worker failed: ${JSON.stringify(result)}\n${logs}`);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.readPermission,"scheduling.view");assert.equal(result.writePermission,"scheduling.manage");assert.equal(result.anonymousReadDenied,true);assert.equal(result.providerReadAllowed,true);assert.equal(result.customerReadDenied,true);assert.equal(result.managerReadAllowed,true);assert.equal(result.anonymousWritesDeniedAndUnchanged,true);assert.equal(result.providerWritesDeniedAndUnchanged,true);assert.equal(result.customerWritesDeniedAndUnchanged,true);assert.equal(result.managerWritesAllowed,true);assert.equal(result.creatorAttributedToActor,true);assert.equal(result.malformedConditionsDeniedAndUnchanged,true);assert.equal(result.nonBooleanActiveDeniedAndUnchanged,true);}finally{await stopWorker(child);await rm(persistDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

function fakeChild() { return Object.assign(new EventEmitter(), {exitCode:null, signalCode:null}); }
function assertListenersReleased(child) {
 for (const event of ['message','exit','error']) assert.equal(child.listenerCount(event),0,event);
}
test('Wrangler readiness uses only its owned IPC announcement and releases listeners',async()=>{
 const child=fakeChild(),ready=waitForWranglerReady(child,()=>'',1000);
 child.emit('message','not a readiness event');
 child.emit('message',{event:'OTHER',ip:'127.0.0.1',port:4444});
 child.emit('message',JSON.stringify({event:'DEV_SERVER_READY',ip:'127.0.0.1',port:44011}));
 assert.deepEqual(await ready,{ip:'127.0.0.1',port:44011});assertListenersReleased(child);
});
test('Wrangler readiness refuses unbound, remote and malformed addresses',async()=>{
 for(const address of [{ip:'0.0.0.0',port:44011},{ip:'example.invalid',port:44011},{ip:'127.0.0.1',port:0},{ip:'127.0.0.1',port:80},{ip:'127.0.0.1',port:65536},{ip:'127.0.0.1',port:'44011'}]) {
  const child=fakeChild(),ready=waitForWranglerReady(child,()=>'',1000);
  child.emit('message',{event:'DEV_SERVER_READY',...address});
  await assert.rejects(ready,/bound loopback port/);assertListenersReleased(child);
 }
});
test('Wrangler startup errors, early exit and timeout fail rather than accepting another service',async()=>{
 for(const event of ['error','exit','signal','alreadyExited','timeout']) {
  const child=fakeChild();if(event==='alreadyExited')child.exitCode=1;
  const ready=waitForWranglerReady(child,()=> 'startup diagnostics',event==='timeout'?10:1000);
  if(event==='error')child.emit('error',new Error('spawn refused'));
  if(event==='exit')child.emit('exit',1,null);
  if(event==='signal')child.emit('exit',null,'SIGTERM');
  await assert.rejects(ready,event==='error'?/spawn refused/:/startup diagnostics/);
  assertListenersReleased(child);
 }
});

test('concurrent authorization workers bind distinct OS-owned ports while another listener stays active',{timeout:120000},async()=>{
 const blocker=createServer(socket=>socket.end('HTTP/1.1 503 Busy\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
 blocker.listen(0,'127.0.0.1');await once(blocker,'listening');
 const heldPort=blocker.address().port,children=[],dirs=[];
 try {
  const addresses=await Promise.all([0,1].map(async index=>{
   const dir=`${persistDir}-parallel-${index}`;dirs.push(dir);
   await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});let logs='';
   const child=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','dev','--config','wrangler.scheduling-rules-authorization.jsonc','--local','--ip','127.0.0.1','--persist-to',dir,'--port','0','--inspector-port','0'],{
    stdio:['ignore','pipe','pipe','ipc'],detached:process.platform!=='win32',
    env:{...process.env,XDG_CONFIG_HOME:`${process.cwd()}/${dir}/xdg`,WRANGLER_SEND_METRICS:'false'},
   });
   children.push(child);child.stdout.on('data',chunk=>{logs+=chunk;});child.stderr.on('data',chunk=>{logs+=chunk;});
   const address=await waitForWranglerReady(child,()=>logs);
   await waitForHealth(address.port,child,()=>logs);return address;
  }));
  assert.equal(new Set([heldPort,...addresses.map(address=>address.port)]).size,3);
  for(const {port} of addresses){const response=await fetch(`http://127.0.0.1:${port}/run`,{signal:AbortSignal.timeout(30000)});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.ok,true,JSON.stringify(result));}
  assert.equal(blocker.listening,true,'the unrelated listener must never be killed or reused');
 } finally {
  await Promise.all(children.map(stopWorker));
  await new Promise((resolve,reject)=>blocker.close(error=>error?reject(error):resolve()));
  await Promise.all(dirs.map(dir=>rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})));
 }
});
