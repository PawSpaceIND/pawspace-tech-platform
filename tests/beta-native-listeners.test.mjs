/* Executed component/queue checks with simulated React effects and Capacitor adapters.
 * No real device, push provider, customer data or external HTTP request is used.
 * These tests exercise the restored code; they are not native-device certification.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const tick = async () => { for (let n=0;n<15;n++) await Promise.resolve(); };
function loadSource(relative, modules, globals={}) {
  const file = path.resolve(relative);
  const result = ts.transpileModule(fs.readFileSync(file,'utf8'), {
    fileName:file, compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022, jsx:ts.JsxEmit.ReactJSX}, reportDiagnostics:true,
  });
  assert.equal((result.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error).length,0);
  const module = {exports:{}};
  const box = {module,exports:module.exports,URL,console:{info(){},warn(){},error(){}},setTimeout,clearTimeout,
    CustomEvent:class {constructor(type,options){this.type=type;this.detail=options?.detail;}},
    require(name){assert.ok(Object.hasOwn(modules,name),`Unmocked external module: ${name}`);return modules[name];},...globals};
  vm.runInNewContext(result.outputText,box,{filename:file,timeout:5000});
  return module.exports;
}
function hooks() {
  const effects=[];
  return {effects,react:{useEffect(fn){effects.push(fn);},useState(value){return[value,()=>{}];}}};
}
const jsx={jsx:()=>null,jsxs:()=>null,Fragment:'fragment'};

test('native restoration: deep-link callback dispatches and listener is removed',async()=>{
  const {effects,react}=hooks();const routes=[],events=[];let callback,removed=0;
  const mod=loadSource('app/components/mobile-deep-link-handler.tsx',{
    react,'next/navigation':{useRouter:()=>({push:p=>routes.push(p)})},
    '@capacitor/core':{Capacitor:{isNativePlatform:()=>true}},
    '@capacitor/app':{App:{async addListener(name,fn){assert.equal(name,'appUrlOpen');callback=fn;return{async remove(){removed++;}};}}},
  },{window:{dispatchEvent:event=>events.push(event)}});
  mod.default();const cleanup=effects[0]();await tick();
  callback({url:'pawspace://payment/callback?razorpay_payment_id=pay_test_native'});
  assert.equal(events[0].type,'pawspace:razorpay-callback');
  assert.equal(routes[0],'/payment/callback?razorpay_payment_id=pay_test_native');
  cleanup();await tick();assert.equal(removed,1);
});

test('native restoration: push registration and notification navigation use mounted listeners',async()=>{
  const {effects,react}=hooks();const callbacks=new Map(),removed=[],routes=[],events=[];let registers=0;
  const mod=loadSource('app/components/mobile-push-listener.tsx',{
    react,'react/jsx-runtime':jsx,'@capacitor/core':{Capacitor:{isNativePlatform:()=>true}},
    '@capacitor/push-notifications':{PushNotifications:{
      async requestPermissions(){return{receive:'granted'};},
      async addListener(name,fn){callbacks.set(name,fn);return{async remove(){removed.push(name);}};},
      async register(){registers++;},
    }},
  },{window:{location:{assign:p=>routes.push(p)},dispatchEvent:event=>events.push(event)},localStorage:{setItem(){}}});
  mod.default();const cleanup=effects[0]();await tick();assert.equal(registers,1);assert.equal(callbacks.size,4);
  callbacks.get('registration')({value:'synthetic-device-token'});
  assert.equal(events[0].type,'pawspace:fcm-token');
  callbacks.get('pushNotificationActionPerformed')({notification:{data:{url:'/partner-app'}}});
  assert.equal(routes[0],'/partner-app');cleanup();await tick();assert.equal(removed.length,4);
});

test('native restoration: reconnect executes the offline flush and cleans its listener',async()=>{
  const {effects,react}=hooks();let onStatus,flushes=0,removed=0;
  const mod=loadSource('app/components/mobile-network-status.tsx',{
    react,'react/jsx-runtime':jsx,'@capacitor/core':{Capacitor:{isNativePlatform:()=>true}},
    '@capacitor/network':{Network:{async addListener(name,fn){assert.equal(name,'networkStatusChange');onStatus=fn;return{async remove(){removed++;}};}}},
    '../../lib/mobile/offline-queue':{async getNetworkStatus(){return{connected:false};},async getOfflineQueue(){return[{id:'saved'}];},async flushOfflineQueue(){flushes++;return{flushed:1,remaining:0};}},
  },{window:{addEventListener(){},removeEventListener(){}}});
  mod.default();const cleanup=effects[0]();await tick();onStatus({connected:true,connectionType:'wifi'});await tick();
  assert.equal(flushes,1);cleanup();await tick();assert.equal(removed,1);
});

test('native restoration: queued GPS is persisted then acknowledged exactly once',async()=>{
  const storage=new Map(),sent=[];
  const mod=loadSource('lib/mobile/offline-queue.ts',{
    '@capacitor/core':{Capacitor:{isNativePlatform:()=>false}},
    '@capacitor/preferences':{Preferences:{}},'@capacitor/network':{Network:{}},
  },{localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    fetch:async(url,options)=>{sent.push([url,JSON.parse(options.body)]);return{ok:true};}});
  await mod.enqueueOfflineTelemetry({type:'gps_coordinate',endpoint:'/api/walking-proof',payload:{bookingId:'synthetic-b',sessionId:'synthetic-s',action:'record_location_sample',idempotencyKey:'native-test-1'}});
  assert.equal((await mod.getOfflineQueue()).length,1);assert.equal(storage.size,1);
  const first=await mod.flushOfflineQueue();assert.equal(first.flushed,1);assert.equal(first.remaining,0);
  assert.equal(sent[0][0],'/api/walking-proof');assert.equal(sent[0][1].idempotencyKey,'native-test-1');
  assert.equal((await mod.flushOfflineQueue()).flushed,0);assert.equal(sent.length,1);
});
