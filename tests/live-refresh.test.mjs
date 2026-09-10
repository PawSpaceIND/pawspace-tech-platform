import test from 'node:test';
import assert from 'node:assert/strict';
import {startLiveRefresh} from '../lib/live-refresh.ts';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('refreshes never overlap and resume after a completed request',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0,finish;
 const sync=startLiveRefresh(()=>{calls++;return new Promise(resolve=>{finish=resolve;});},{onError:()=>assert.fail('unexpected failure')});t.after(()=>sync.stop());
 await flush();sync.refresh();sync.refresh();assert.equal(calls,1);
 finish();await flush();t.mock.timers.tick(3000);await flush();assert.equal(calls,2);finish();
});
test('a failed read retries automatically and a stopped view cannot restart',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0,errors=0;
 const sync=startLiveRefresh(async()=>{calls++;if(calls===1)throw new Error('read outage');},{onError:()=>{errors++;}});
 await flush();assert.equal(errors,1);t.mock.timers.tick(3000);await flush();assert.equal(calls,2);
 sync.stop();t.mock.timers.tick(10000);sync.refresh();await flush();assert.equal(calls,2);
});
test('a stalled network read is aborted and retried without overlapping requests',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0,errors=0,aborts=0;
 const sync=startLiveRefresh(signal=>{calls++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborts++;reject(signal.reason);},{once:true}));},{timeoutMs:100,onError:()=>{errors++;}});t.after(()=>sync.stop());
 await flush();t.mock.timers.tick(100);await flush();assert.equal(aborts,1);assert.equal(errors,1);
 t.mock.timers.tick(3000);await flush();assert.equal(calls,2);
 sync.stop();await flush();assert.equal(aborts,2);assert.equal(errors,1,'unmounted view must not receive the abort error');
});
