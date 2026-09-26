// Load React's CommonJS runtime before installing Node 22 module hooks.
import 'react';
import 'react/jsx-runtime';
import test from 'node:test';
import assert from 'node:assert/strict';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__MAPS_POSTAL_DB__','__MAPS_POSTAL_ENV__');
globalThis.__MAPS_POSTAL_ENV__={PAWSPACE_MAPS_ENV:'sandbox',GOOGLE_MAPS_SERVER_API_KEY_UAT:'test-key'};
const {resolvePlaceToAddress,reverseGeocode}=await import('../lib/address-autocomplete.ts');
const point={latitude:12.978,longitude:77.64};
function stub(t,handler){const old=globalThis.fetch;globalThis.fetch=handler;t.after(()=>globalThis.fetch=old);}
test('place with no PIN in display label uses structured postal component without a second lookup',async t=>{
 let calls=0;
 stub(t,async(url,init)=>{calls++;assert.match(init.headers['X-Goog-FieldMask'],/addressComponents/);return Response.json({formattedAddress:'Indiranagar, Bengaluru, India',location:point,addressComponents:[{types:['postal_code'],longText:'560038'}]});});
 const result=await resolvePlaceToAddress({placeId:'demo-place'});
 assert.equal(result.pincode,'560038');assert.equal(result.address,'Indiranagar, Bengaluru, India');assert.equal(calls,1);
});
test('area without postal components reverse-geocodes its verified coordinates',async t=>{
 const calls=[];
 stub(t,async url=>{const u=new URL(url);calls.push(u);if(u.hostname==='places.googleapis.com')return Response.json({formattedAddress:'100 Feet Road, Bengaluru',location:point});assert.equal(u.searchParams.get('latlng'),'12.978,77.64');return Response.json({status:'OK',results:[{formatted_address:'Indiranagar, Bengaluru',address_components:[{types:['postal_code'],long_name:'560038'}]}]});});
 const result=await resolvePlaceToAddress({placeId:'demo-road'});
 assert.equal(result.pincode,'560038');assert.equal(result.latitude,point.latitude);assert.equal(calls.length,2);
});
test('failed reverse lookup never invents a postal code or changes the selected place',async t=>{
 const hosts=[];
 stub(t,async url=>{const host=new URL(url).hostname;hosts.push(host);return host==='places.googleapis.com'?Response.json({formattedAddress:'Unknown road',location:point}):Response.json({status:'ZERO_RESULTS',results:[]});});
 const result=await resolvePlaceToAddress({placeId:'demo-road'});
 assert.equal(hosts.length,2);assert.notEqual(hosts[1],'places.googleapis.com');
 assert.equal(result.pincode,undefined);assert.equal(result.address,'Unknown road');
});
test('GPS reverse lookup returns structured postal code even when display label omits it',async t=>{
 stub(t,async()=>Response.json({status:'OK',results:[{formatted_address:'Indiranagar, Bengaluru',address_components:[{types:['postal_code'],long_name:'560038'}]}]}));
 assert.equal((await reverseGeocode(point)).pincode,'560038');
});
test('legacy Taxi entry renders the Google-backed ride flow and preserves source booking',async()=>{
 const {default:TaxiPage}=await import('../app/taxi/page.tsx');
 const {default:RideExperience}=await import('../app/v2/taxi/boarding-taxi-experience.tsx');
 const page=await TaxiPage({searchParams:Promise.resolve({sourceBookingId:' BOARD-DEMO '})});
 assert.equal(page.type,RideExperience);assert.equal(page.props.routeScope,'legacy');assert.equal(page.props.sourceBookingId,'BOARD-DEMO');
});
