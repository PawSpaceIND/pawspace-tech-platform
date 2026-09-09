import test from 'node:test';
import assert from 'node:assert/strict';
import {getDeviceLocation} from '../lib/device-location-client.ts';
test('check-in requests a fresh bounded device fix and returns its actual coordinates',async()=>{
 const result=await getDeviceLocation({getCurrentPosition(success,_failure,options){assert.equal(options.maximumAge,0);assert.equal(options.timeout,15000);success({coords:{latitude:12.97,longitude:77.64}});}});assert.deepEqual(result,{latitude:12.97,longitude:77.64});
});
test('permission denial and timeout never fabricate a device location',async()=>{
 for(const[code,message]of[[1,/Allow location access/],[3,/timed out/],[2,/unavailable/]])await assert.rejects(getDeviceLocation({getCurrentPosition(_success,failure){failure({code});}}),message);
});
test('invalid device coordinates cannot proceed to check-in',async()=>{
 for(const[latitude,longitude]of[[NaN,77],[91,77],[12,181]])await assert.rejects(getDeviceLocation({getCurrentPosition(success){success({coords:{latitude,longitude}});}}),/invalid location/);
});
