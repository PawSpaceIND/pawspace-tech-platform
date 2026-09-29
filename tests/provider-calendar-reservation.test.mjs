import test from 'node:test';
import assert from 'node:assert/strict';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
import {world,seedActors,asActor} from './helpers/execution-harness.mjs';
import {seedOwnedPet} from './helpers/saved-pet-fixture.mjs';
installWorkersHooks('__CALENDAR_RESERVE_DB__','__CALENDAR_RESERVE_ENV__');
const scheduling=await import('../app/api/uat-scheduling/route.ts');
const controls=await import('../app/api/provider-capacity-control/route.ts');
const capacity=await import('../lib/provider-capacity-governance.ts');
const FOUNDER='calendar-ops@example.test',CUSTOMER='CALENDAR-C',PET='CALENDAR-PET';
const DAY=new Date(Date.now()+5*86400000).toISOString().slice(0,10);
const NEXT=new Date(Date.parse(DAY)+86400000).toISOString().slice(0,10);
async function setup(t){
 const w=world('__CALENDAR_RESERVE_DB__','__CALENDAR_RESERVE_ENV__',{PAWSPACE_PAYMENT_ENV:'sandbox',PAWSPACE_SCHEDULING_ENV:'uat',PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE:'on'});
 t.after(()=>w.sqlite.close());await seedActors(w.sqlite,w.db,[{id:'CALENDAR-OPS',email:FOUNDER,role:'founder'}]);
 await capacity.seedProviderCapacityDefaults(w.db);await seedOwnedPet(w.db,CUSTOMER,PET);
 t.mock.method(globalThis,'fetch',()=>assert.fail('Calendar tests must not contact external services'));
 return w;
}
async function publish(providerId,date,windows,zoneId='blr-east'){
 const response=await controls.POST(asActor(FOUNDER,'/api/provider-capacity-control',{method:'POST',body:JSON.stringify({action:'set_availability',providerId,cityId:'blr',zoneId,date,windows})}));
 assert.equal(response.status,201,await response.clone().text());
}
async function reserve(serviceCode,providerId,extra={}){
 const response=await scheduling.POST(asActor(FOUNDER,'/api/uat-scheduling',{method:'POST',body:JSON.stringify({action:'reserve',clientRequestId:'CALENDAR-'+serviceCode,customerId:CUSTOMER,petIds:[PET],serviceCode,providerSelection:'specific',preferredProviderId:providerId,cityId:'blr',zoneId:'blr-east',scheduledStart:`${DAY}T10:00:00+05:30`,scheduledEnd:`${NEXT}T10:00:00+05:30`,customRules:[{code:'PIN-AUDIT-PROVIDER',field:'providerId',operator:'eq',value:providerId}],...extra})}));
 return{status:response.status,body:await response.json()};
}
for(const[service,providerId]of [['boarding','host_maya_rohan'],['pet_sitting','sit_sana']])for(const blocked of [true,false]){
 test(`Real reserve ${service}: authored ${blocked?'Blocked':'Open'} day wins over synthetic UAT defaults`,async t=>{
  const w=await setup(t);await publish(providerId,DAY,['09:00-19:00']);await publish(providerId,NEXT,blocked?[]:['09:00-19:00']);
  const result=await reserve(service,providerId,service==='pet_sitting'?{careMode:'overnight'}:{});
  assert.equal(result.status,blocked?409:200,JSON.stringify(result.body));
  if(blocked){
   assert.equal(result.body.error,service==='pet_sitting'?'SELECTED_SITTER_UNAVAILABLE':'SELECTED_PROVIDER_UNAVAILABLE');
   assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE status!='cancelled'").get().n,0);
   assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM provider_assignment_offers").get().n,0);
  }else{
   assert.equal(result.body.data.provider.id,providerId);
   assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE status!='cancelled'").get().n,1);
   assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM provider_assignment_offers').get().n,1);
  }
 });
}
