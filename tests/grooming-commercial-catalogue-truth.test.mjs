import assert from"node:assert/strict";
import test from"node:test";
import{readFile}from"node:fs/promises";

const source=async path=>readFile(new URL("../"+path,import.meta.url),"utf8");

test("Grooming commercial catalogue matches approved package and two-pet creative truth",async()=>{
  const[governance,commercial]=await Promise.all([source("lib/grooming-governance.ts"),source("lib/grooming-commercial-catalogue.ts")]);
  for(const [code,single,multiUnit,twoPet] of [
    ["dog-bath",1349,1149,2298],
    ["dog-basic",1899,1649,3298],
    ["dog-makeover",2399,2149,4298],
    ["cat-routine",1149,999,1998],
    ["cat-basic",1899,1649,3298],
    ["cat-makeover",2399,2149,4298],
  ]){
    assert.match(governance,new RegExp(`code:\\"${code}\\"[\\s\\S]{0,160}singlePrice:${single},multiPetPrice:${multiUnit}`));
    assert.match(commercial,new RegExp(`code:\\"${code}\\"[\\s\\S]{0,180}price:${single},twoPetPrice:${twoPet}`));
    assert.equal(multiUnit*2,twoPet);
  }
  assert.match(governance,/code:"dog-trim"[\s\S]{0,160}singlePrice:1599/);
  assert.match(governance,/code:"cat-trim"[\s\S]{0,160}singlePrice:1599/);
  assert.match(commercial,/Only Haircut[\s\S]{0,120}price:1599[\s\S]{0,120}"Nail Clipping","Ear Cleaning"/);
});

test("Puppy and kitten creative packages remain governed at 999 and 1399 with service scope",async()=>{
  const[governance,commercial]=await Promise.all([source("lib/grooming-governance.ts"),source("lib/grooming-commercial-catalogue.ts")]);
  assert.match(governance,/code:"young-basic"[\s\S]{0,180}singlePrice:999/);
  assert.match(governance,/code:"young-makeover"[\s\S]{0,180}singlePrice:1399/);
  assert.match(commercial,/code:"young-basic"[\s\S]{0,500}"Minor Trim on the face & paws"[\s\S]{0,120}excluded:\["Hair Styling","Full Body Trimming"\]/);
  assert.match(commercial,/code:"young-makeover"[\s\S]{0,520}"Hair Styling","Full Body Trimming"/);
});

test("Grooming add-ons are recorded exactly without silently changing base booking totals",async()=>{
  const[governance,commercial]=await Promise.all([source("lib/grooming-governance.ts"),source("lib/grooming-commercial-catalogue.ts")]);
  assert.match(commercial,/code:"tick-flea-treatment",name:"Tick & Flea Treatment",price:499/);
  assert.match(commercial,/code:"full-body-oil-massage",name:"Full Body Oil Massage",price:299/);
  assert.match(commercial,/eligiblePetTypes:\["dog","cat"\],active:true/);
  assert.doesNotMatch(governance,/tick-flea-treatment|full-body-oil-massage/);
});

test("Creative discount prices are captured but fail closed until operator activation",async()=>{
  const commercial=await source("lib/grooming-commercial-catalogue.ts");
  for(const [packageCode,regularPrice,offerPrice] of [
    ["dog-bath",1349,1299],
    ["dog-basic",1899,1699],
    ["dog-makeover",2399,2199],
    ["cat-routine",1149,1049],
    ["cat-basic",1899,1699],
    ["cat-makeover",2399,2199],
  ])assert.match(commercial,new RegExp(`packageCode:\\"${packageCode}\\",regularPrice:${regularPrice},offerPrice:${offerPrice},activeByDefault:false,activation:\\"operator_controlled\\"`));
  assert.match(commercial,/campaign dates, eligibility,/);
  assert.match(commercial,/Pricing Control must explicitly activate an offer/);
});

test("Semiannual and annual subscription truth is internally coherent",async()=>{
  const[governance,commercial]=await Promise.all([source("lib/grooming-governance.ts"),source("lib/grooming-commercial-catalogue.ts")]);
  assert.match(commercial,/semiannual:\{planCode:"sub-6",sessions:6,price:6594,perSession:1099,validityValue:6/);
  assert.match(commercial,/annual:\{planCode:"sub-12",sessions:12,price:11988,perSession:999,validityValue:12/);
  assert.equal(6594/6,1099);
  assert.equal(11988/12,999);
  assert.match(governance,/planCode:"sub-6",name:"6 sessions · Semiannual",price:6594,sessions:6,validityValue:6/);
  assert.match(governance,/planCode:"sub-12",name:"12 sessions · Annual",price:11988,sessions:12,validityValue:12/);
});
