import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
import {d1} from "./helpers/execution-harness.mjs";
installWorkersHooks("__STAY_ADDRESS_DB__","__STAY_ADDRESS_ENV__");
globalThis.__STAY_ADDRESS_ENV__={PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE:"on",PAWSPACE_PAYMENT_ENV:"sandbox",PAWSPACE_SCHEDULING_ENV:"uat"};
const {resolveGovernedServiceAddress}=await import("../lib/service-discovery-address.ts");
const {savedStayAddressText}=await import("../lib/stay-saved-address.ts");
const {serviceAddressText}=await import("../lib/service-address-text.ts");
const fields={area:"Indiranagar",city:"Bengaluru",postalCode:"560038"};

test("stay formatter does not grow complete or historically repeated locality fields",()=>{
 const expected="QA Road, Indiranagar, Bengaluru, 560038";
 for(const line1 of ["QA Road",expected,"QA Road, Indiranagar, Bengaluru, Indiranagar, Bengaluru, 560038, Indiranagar, Bengaluru, 560038"]){
  const result=savedStayAddressText({...fields,line1});
  assert.equal(result,expected);
  assert.equal(savedStayAddressText({...fields,line1:result}),expected);
 }
});

test("address normalization preserves street/unit text, Maps state/PIN and country",()=>{
 assert.equal(serviceAddressText({...fields,line1:"42, 42, Indiranagar Road",line2:"Tower A, Unit 42"}),"42, 42, Indiranagar Road, Tower A, Unit 42, Indiranagar, Bengaluru, 560038");
 const maps="42 Road, Indiranagar, Bengaluru, Karnataka 560038, India";
 assert.equal(serviceAddressText({...fields,line1:maps,country:"India"}),maps);
 assert.equal(serviceAddressText({...fields,line1:"42 Road, indiranagar, BENGALURU"}),"42 Road, indiranagar, BENGALURU, 560038");
});

test("four actual save-format-discovery cycles retain one address and one geocode",async t=>{
 const sqlite=new DatabaseSync(":memory:");t.after(()=>sqlite.close());const db=d1(sqlite);
 let address="QA ONLY 100 Feet Road, Indiranagar, Bengaluru",id;
 for(let cycle=0;cycle<4;cycle++){
  const result=await resolveGovernedServiceAddress(db,{customerId:"QA-ADDRESS",serviceCode:"pet_sitting",serviceAddress:address,servicePincode:"560038"});
  if(id)assert.equal(result.addressId,id);else id=result.addressId;
  const row=sqlite.prepare("SELECT * FROM customer_addresses WHERE customer_id='QA-ADDRESS' AND is_default=1").get();
  address=savedStayAddressText({...row,postalCode:row.postal_code});
  assert.equal(address,"QA ONLY 100 Feet Road, Indiranagar, Bengaluru, 560038");
  assert.equal(sqlite.prepare("SELECT count(*) n FROM customer_addresses").get().n,1);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM customer_service_address_geocodes").get().n,1);
  assert.equal(result.address,"QA ONLY 100 Feet Road, Indiranagar, Bengaluru, 560038, India");
 }
});

test("normalization neither merges customers nor erases distinct units",async t=>{
 const sqlite=new DatabaseSync(":memory:");t.after(()=>sqlite.close());const db=d1(sqlite);
 const ids=[];
 for(const [customerId,unit] of [["C1","Unit 1"],["C1","Unit 2"],["C2","Unit 1"]]){
  const result=await resolveGovernedServiceAddress(db,{customerId,serviceCode:"boarding",serviceAddress:`42 QA Road, ${unit}`,servicePincode:"560038"});ids.push(result.addressId);
 }
 assert.equal(new Set(ids).size,3);
 assert.equal(sqlite.prepare("SELECT count(*) n FROM customer_addresses").get().n,3);
 assert.equal(sqlite.prepare("SELECT count(*) n FROM customer_addresses WHERE is_default=1").get().n,2);
});
