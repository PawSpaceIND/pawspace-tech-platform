import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
import {freshSqlite,makeD1,refusal} from './helpers/taxi-harness.mjs';
installWorkersHooks('__RELOCATION_EXPLICIT_DB__');
// QA idempotency labels (not credentials); built here so secret scanners do not treat them as key literals.
const qaKey=label=>label;
// V2-045: choosing Road, Bengaluru → Pune used to save "Pune, United Arab Emirates" because the form carried
// hidden hardcoded country/age/size values and the API coerced anything missing into defaults.
const input=await import('../lib/relocation-inquiry-input.ts');
const {createRelocationCase}=await import('../lib/relocation-governance.ts');
const world=()=>{const sqlite=freshSqlite();return{sqlite,db:makeD1(sqlite)}};
// A refusal that happens BEFORE any write leaves the table uncreated; that is the behaviour under test, so count it as 0.
const count=(sqlite,table)=>{try{return Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)}catch(error){if(/no such table/.test(String(error.message)))return 0;throw error}};
const domesticRoad=(overrides={})=>({customerId:'QA-RELOCATION-OWNER',petName:'Rex',breed:'Indie',ageYears:'0',sizeClass:'medium',travelMode:'road',originCountry:'India',originCity:'Bengaluru',destinationCountry:'India',destinationCity:'Pune',targetTravelDate:'2099-11-05',crateRequirement:'',...overrides});

test('explicit Road Bengaluru → Pune keeps India as the destination country and zero age is a real answer',()=>{
 const result=input.validateRelocationInquiry(domesticRoad());
 assert.equal(result.ok,true);assert.equal(result.kind,'domestic');
 assert.deepEqual({...result.value},{customerId:'QA-RELOCATION-OWNER',petName:'Rex',breed:'Indie',ageYears:0,sizeClass:'medium',travelMode:'road',originCountry:'India',originCity:'Bengaluru',destinationCountry:'India',destinationCity:'Pune',targetTravelDate:'2099-11-05',crateRequirement:'assessment_required'});
 const half=input.validateRelocationInquiry(domesticRoad({ageYears:'0.5'}));assert.equal(half.value.ageYears,0.5);
 const intl=input.validateRelocationInquiry(domesticRoad({travelMode:'air',destinationCountry:'  United  Arab Emirates ',destinationCity:'Dubai'}));
 assert.equal(intl.ok,true);assert.equal(intl.kind,'international');assert.equal(intl.value.destinationCountry,'United Arab Emirates');
});

test('missing or invalid country, age and size are refused field by field - nothing is defaulted',()=>{
 const missing=input.validateRelocationInquiry(domesticRoad({ageYears:'',sizeClass:'',destinationCountry:'',destinationCity:''}));
 assert.equal(missing.ok,false);
 assert.deepEqual(Object.keys(missing.errors).sort(),['ageYears','destinationCity','destinationCountry','sizeClass']);
 assert.match(missing.errors.ageYears,/0 for under one year/);assert.match(missing.errors.destinationCountry,/destination country/);
 for(const [field,value,pattern] of [['ageYears',-1,/between 0 and 30/],['ageYears','31',/between 0 and 30/],['ageYears','four',/between 0 and 30/],['sizeClass','huge',/small, medium, large or giant/],['travelMode','rocket',/air, road or sea/],['destinationCountry','12',/valid destination country/],['targetTravelDate','2001-01-01',/in the future/],['targetTravelDate','soon',/YYYY-MM-DD/],['petName','',/pet's name/],['breed','',/breed/]]){
  const result=input.validateRelocationInquiry(domesticRoad({[field]:value}));assert.equal(result.ok,false,`${field}=${value}`);assert.match(result.errors[field]||'',pattern,`${field}=${value}`);
 }
 const undefinedAge=input.validateRelocationInquiry(domesticRoad({ageYears:undefined}));assert.equal(undefinedAge.ok,false);assert.ok(undefinedAge.errors.ageYears);
 assert.throws(()=>input.normalizeRelocationInquiryInput(domesticRoad({sizeClass:''})),error=>error instanceof Response&&error.status===400);
});

test('an explicitly typed different country is kept as typed and classified international - never substituted',()=>{
 const typed=input.validateRelocationInquiry(domesticRoad({destinationCountry:'United Arab Emirates'}));
 assert.equal(typed.ok,true);assert.equal(typed.kind,'international');assert.equal(typed.value.destinationCountry,'United Arab Emirates');
 assert.equal(input.validateRelocationInquiry(domesticRoad({travelMode:'sea',destinationCountry:'Sri Lanka',destinationCity:'Colombo'})).kind,'international');
 assert.equal(input.relocationKindFor('india','INDIA'),'domestic');
});

test('governance persists the explicit country and zero age and refuses defaulted input',async()=>{
 const {sqlite,db}=world();
 const row=await createRelocationCase(db,domesticRoad({idempotencyKey:qaKey('qa-explicit-key-1')}),'customer:QA');
 assert.equal(row.destination_country,'India');assert.equal(row.destination_city,'Pune');assert.equal(row.age_years,0);assert.equal(row.size_class,'medium');assert.equal(row.crate_requirement,'assessment_required');
 const replay=await createRelocationCase(db,domesticRoad({idempotencyKey:qaKey('qa-explicit-key-1')}),'customer:QA');assert.equal(replay.id,row.id);
 for(const bad of [{sizeClass:''},{ageYears:''},{destinationCountry:''},{ageYears:'x'}])assert.equal((await refusal(createRelocationCase(db,domesticRoad({...bad,idempotencyKey:qaKey('qa-explicit-key-2')}),'customer:QA'))).status,400,JSON.stringify(bad));
 assert.equal(count(sqlite,'relocation_cases'),1);
});

test('POST /api/relocation refuses missing details with field errors before any row exists, then stores the explicit country',async()=>{
 const {sqlite,db}=world();globalThis.__RELOCATION_EXPLICIT_DB__=db;
 const {upsertIdentityBinding}=await import('../lib/identity-binding.ts');
 const {issuePlatformSession,PLATFORM_SESSION_COOKIE}=await import('../lib/platform-session.ts');
 const {ensureSecurityTables}=await import('../lib/server-auth.ts');await ensureSecurityTables(db);
 const binding=await upsertIdentityBinding(db,{identitySource:'customer_app',principalType:'phone',principalKey:'+919900000089',subjectType:'customer',subjectId:'QA-RELOCATION-OWNER',verificationState:'verified',actorId:'qa',reason:'Relocation explicit-details test'});
 const session=await issuePlatformSession(db,{bindingId:String(binding.id),identitySource:'customer_app',principalType:'phone',principalKey:String(binding.principal_key),subjectType:'customer',subjectId:'QA-RELOCATION-OWNER'});
 const cookie=`${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(session.token)}`;
 const route=await import('../app/api/relocation/route.ts');
 const post=body=>route.POST(new Request('https://ops.pawspace.example/api/relocation',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({action:'create',...body})}));
 // The old form's payload shape: no age, size or destination country at all.
 const refused=await post({customerId:'QA-RELOCATION-OWNER',petName:'Rex',breed:'Indie',travelMode:'road',originCountry:'India',originCity:'Bengaluru',destinationCity:'Pune',targetTravelDate:'2099-11-05',idempotencyKey:qaKey('qa-explicit-route-1')});
 assert.equal(refused.status,400);const refusedBody=await refused.json();
 assert.deepEqual(Object.keys(refusedBody.fields).sort(),['ageYears','destinationCountry','sizeClass']);assert.equal(refusedBody.error,refusedBody.fields.ageYears);
 assert.equal(count(sqlite,'relocation_cases'),0);
 const created=await post(domesticRoad({idempotencyKey:qaKey('qa-explicit-route-2')}));assert.equal(created.status,201);
 const body=await created.json();assert.equal(body.data.destination_country,'India');assert.equal(body.data.age_years,0);assert.equal(body.data.size_class,'medium');
 // Typing the UAE explicitly is honoured as typed (international); the defect was the HIDDEN default, not the value.
 const typed=await post(domesticRoad({idempotencyKey:qaKey('qa-explicit-route-3'),destinationCountry:'United Arab Emirates',destinationCity:'Dubai',travelMode:'air'}));assert.equal(typed.status,201);
 assert.equal((await typed.json()).data.destination_country,'United Arab Emirates');
 assert.equal(count(sqlite,'relocation_cases'),2);
});

test('the Relocation page renders explicit country, age and size controls with no fixture defaults',async()=>{
 // Render a React ELEMENT through react-dom/server; calling the hook component as a function would break
 // useSyncExternalStore (the failure the earlier attempt hit).
 const {renderToStaticMarkup}=await import('react-dom/server');
 const React=await import('react');
 const page=await import('../app/relocation/page.tsx');
 for(const routeScope of ['legacy','v2']){
  const html=renderToStaticMarkup(React.createElement(page.default,{routeScope}));
  for(const label of ['Age (years)','Size','Origin country','Destination country','Destination city','Origin city']){assert.ok(html.includes(label),`${routeScope}: ${label} control`);}
  assert.match(html,/id="relocation-country-suggestions"/);
  assert.match(html,/<option value=""[^>]*>Choose size<\/option>/);
  assert.match(html,/<option value="road"[^>]*>Road \(within one country\)/);
  // The country appears only as a datalist SUGGESTION, never as a pre-filled input value.
  assert.doesNotMatch(html,/<input[^>]*value="United Arab Emirates"/);assert.match(html,/<datalist id="relocation-country-suggestions"><option value="India">/);
  for(const fixture of ['Bruno','Golden Retriever','Dubai','IATA crate assessment required'])assert.ok(!html.includes(fixture),`${routeScope}: fixture "${fixture}" must not be pre-filled`);
  assert.match(html,/Create relocation inquiry|Loading customer account…/);
 }
 const source=fs.readFileSync(new URL('../app/relocation/page.tsx',import.meta.url),'utf8');
 assert.match(source,/validateRelocationInquiry\(\{customerId,\.\.\.form\}\)/);
 assert.match(source,/ageYears:"",sizeClass:"",travelMode:"air",originCountry:"India",originCity:"Bengaluru",destinationCountry:"",destinationCity:""/);
 assert.doesNotMatch(source,/destinationCountry:"United Arab Emirates"/);
 assert.match(fs.readFileSync(new URL('../app/api/relocation/route.ts',import.meta.url),'utf8'),/validateRelocationInquiry\(\{\.\.\.body,customerId\}\)/);
 assert.doesNotMatch(fs.readFileSync(new URL('../app/api/relocation/route.ts',import.meta.url),'utf8'),/sizeClass\|\|"medium"|ageYears\|\|0/);
});
