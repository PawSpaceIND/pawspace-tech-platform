import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {rm} from "node:fs/promises";

const port=8796;
const persistDir=`.scheduling-rules-authorization-${process.pid}`;
async function waitForHealth(){for(let i=0;i<60;i+=1){try{const response=await fetch(`http://127.0.0.1:${port}/health`);if(response.ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,500));}throw new Error("scheduling rules authorization worker did not become ready");}

test("scheduling rules enforce read/manage permissions and preserve D1 on denied mutations",{timeout:120000},async()=>{
 await rm(persistDir,{recursive:true,force:true});let logs="";
 const child=spawn(process.platform==="win32"?"npx.cmd":"npx",["wrangler","dev","--config","wrangler.scheduling-rules-authorization.jsonc","--persist-to",persistDir,"--port",String(port)],{stdio:["ignore","pipe","pipe"]});
 child.stdout.on("data",chunk=>{logs+=String(chunk);});child.stderr.on("data",chunk=>{logs+=String(chunk);});
 try{await waitForHealth();const response=await fetch(`http://127.0.0.1:${port}/run`);const result=await response.json();assert.equal(response.status,200,`authorization worker failed: ${JSON.stringify(result)}\n${logs}`);assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(result.permissions,{read:"scheduling.view",write:"scheduling.manage"});assert.equal(result.anonymousPersistenceUnchanged,true);assert.equal(result.providerReadAllowed,true);assert.equal(result.providerWritesDeniedAndUnchanged,true);assert.equal(result.customerReadDenied,true);assert.equal(result.customerWritesDeniedAndUnchanged,true);assert.equal(result.managerAllMethodsAllowed,true);}finally{child.kill("SIGTERM");await new Promise(resolve=>{const timer=setTimeout(resolve,2000);child.once("exit",()=>{clearTimeout(timer);resolve();});});if(!child.killed)child.kill("SIGKILL");await rm(persistDir,{recursive:true,force:true});}
});
