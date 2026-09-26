import test from 'node:test';
import assert from 'node:assert/strict';
import {setupJourney} from './helpers/grooming-journey-harness.mjs';
import {buildOccurrences,scheduleRules} from '../backend/src/scheduling.ts';

const start='2026-10-10T04:30:00.000Z',end='2026-10-10T05:30:00.000Z';
const request={cityId:'blr',zoneId:'blr-east',serviceCode:'dog_training',petIds:['DOG'],scheduledStart:start,scheduledEnd:end};
test('audit T01: published 16-session Training fits the scheduler without relaxing other services',()=>{
 const calendar=buildOccurrences({...request,occurrences:16,cadenceDays:6});
 assert.equal(calendar.length,16);assert.equal(scheduleRules.dog_walking.maxOccurrences,12);assert.equal(scheduleRules.grooming.maxOccurrences,1);
});
test('audit G-F01: dedicated V2 callback accepts its scoped status and failure returns',async t=>{
 const ctx=await setupJourney();t.after(ctx.close);
 const route=await import('../app/api/v2/grooming-checkout-return/route.ts');
 for(const method of ['GET','POST']){
  const url='https://audit.invalid/api/v2/grooming-checkout-return?bookingId=AUDIT-LOCAL&scope=v2';
  const req=new Request(url,method==='GET'?{}:{method,headers:{'content-type':'application/x-www-form-urlencoded'},body:'error%5Bcode%5D=BAD_REQUEST_ERROR'});
  const response=await route[method](req);assert.equal(response.status,303);
  const target=new URL(response.headers.get('location'));assert.equal(target.origin,'https://audit.invalid');assert.equal(target.pathname,'/v2/grooming');
 }
});
test('audit G-F02: looking up the same saved doorstep does not create another default address',async t=>{
 const ctx=await setupJourney();t.after(ctx.close);const {db,sqlite}=ctx;
 sqlite.exec("CREATE TABLE IF NOT EXISTS customer_addresses(id TEXT PRIMARY KEY,customer_id TEXT,label TEXT,line1 TEXT,line2 TEXT,area TEXT,city TEXT,postal_code TEXT,is_default INTEGER,created_at INTEGER,updated_at INTEGER)");
 sqlite.prepare("INSERT INTO customer_addresses VALUES ('AUDIT-HOME','AUDIT-C','Home','21 Indiranagar Main Road, Bengaluru',NULL,'Indiranagar','Bengaluru','560038',1,1,1)").run();
 const {resolveGovernedServiceAddress}=await import('../lib/service-discovery-address.ts');const result=await resolveGovernedServiceAddress(db,{customerId:'AUDIT-C',serviceCode:'grooming',serviceAddress:'21 Indiranagar Main Road, Bengaluru',servicePincode:'560038'});
 assert.equal(result.addressId,'AUDIT-HOME');assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM customer_addresses WHERE customer_id='AUDIT-C'").get().n,1);assert.equal(sqlite.prepare("SELECT is_default FROM customer_addresses WHERE id='AUDIT-HOME'").get().is_default,1);
});

import {trainingCalendarWindows,assertTrainingCalendarValidity} from '../lib/training-calendar-policy.ts';
import {trainingQuoteKey} from '../lib/training-booking-guards.ts';
const pro={sessions:16,validityDays:93,minutesPerSession:60};
test('audit T02: weekly Pro would exceed validity, but an explicit six-day cadence fits',()=>{
 assert.throws(()=>trainingCalendarWindows(start,pro,7),/no more than 6 days/);
 const windows=trainingCalendarWindows(start,pro,6);assert.equal(windows.length,16);assert.doesNotThrow(()=>assertTrainingCalendarValidity(start,pro,windows));
 assert.equal(Date.parse(windows[15].start)-Date.parse(start),90*86400000);
});
test('audit T02: forged, overlapping and shortened reserved calendars fail closed',()=>{
 const windows=trainingCalendarWindows(start,pro,6);
 for(const bad of [windows.slice(1),windows.map((w,i)=>i===15?{...w,end:'2027-03-01T00:00:00Z'}:w),windows.map((w,i)=>i===1?windows[0]:w),windows.map((w,i)=>i===1?{...w,end:w.start}:w)])assert.throws(()=>assertTrainingCalendarValidity(start,pro,bad));
});
test('cadence changes invalidate the displayed quote and trainer preview',()=>{
 const base={scheduledStart:start,packageCode:'training-16-pro',paymentMode:'split',petIds:['DOG']};
 assert.notEqual(trainingQuoteKey({...base,cadenceDays:7}),trainingQuoteKey({...base,cadenceDays:6}));
});
test('integer bounds reject malformed recurrence counts and cadences',()=>{
 for(const occurrences of [NaN,Infinity,1.5,17])assert.throws(()=>buildOccurrences({...request,occurrences,cadenceDays:6}));
 for(const cadenceDays of [NaN,Infinity,0,1.5])assert.throws(()=>trainingCalendarWindows(start,pro,cadenceDays));
});
test('ordinary weekly courses and multi-dog session lengths are unchanged',()=>{
 for(const [sessions,validityDays] of [[1,7],[2,31],[4,31],[8,62],[12,93]]){
  for(const pets of [1,2,3,4]){const terms={sessions,validityDays,minutesPerSession:60*pets};const windows=trainingCalendarWindows(start,terms);assert.equal(windows.length,sessions);assert.equal(Date.parse(windows[0].end)-Date.parse(start),pets*3600000);assert.doesNotThrow(()=>assertTrainingCalendarValidity(start,terms,windows));}
 }
});

// Review follow-ups (CodeAnt on #1088): source contracts for UI-only state; the behaviour is a one-token change each.
{
 const {readFileSync}=await import('node:fs');
 const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
 test('review: a recorded zero Training progress score is loaded as zero, not replaced by the default',()=>{
  const trainer=read('app/trainer/page.tsx');
  for(const key of ['focus','recall','impulse','parent'])assert.match(trainer,new RegExp(`${key}:Number\\(progress\\.${key}\\?\\?7\\)`),key);
  assert.doesNotMatch(trainer,/Number\(progress\.[a-z]+\|\|7\)/);
 });
 test('review: legacy /training keeps its own booking/payment page instead of jumping into V2',()=>{
  const training=read('app/training/page.tsx');
  assert.match(training,/const bookingRecordHref=\(bookingId:string\)=>routeScope==="v2"\?`\/v2\/booking\?bookingId=\$\{encodeURIComponent\(bookingId\)\}`:`\/mobile-app\/booking-confirmation\?bookingId=\$\{encodeURIComponent\(bookingId\)\}`/);
  assert.equal((training.match(/\/v2\/booking\?bookingId=/g)||[]).length,1,'the V2 booking link is built only by bookingRecordHref');
 });
 test('review: an assisted booking never shows or submits a CRM record loaded for a previous customer query',()=>{
  const assisted=read('app/assisted-booking/page.tsx');
  assert.match(assisted,/requestedCustomerId\?\(effectiveCrmCustomer\?\.id===requestedCustomerId\?effectiveCrmCustomer:null\)/);
  assert.match(assisted,/setRequestedCustomerId\(requested\);setCrmCustomer\(null\);/);
 });
 // QA regression (trainer-complete): the server half of this wire is executed in tests/training-session-lifecycle.test.mjs.
 test('review: the trainer pre-check is saved after start and stays confirmable until completion',()=>{
  const trainer=read('app/trainer/page.tsx');
  assert.match(trainer,/action:"start"\}\);try\{await trainingSessionAction\(\{sessionId:selected\.id,action:"save_report",\.\.\.attendanceOnly\}/,'the pre-check is persisted right after a successful start');
  assert.match(trainer,/const attendanceOnly:Record<string,unknown>=\{report:\{attendance:report\.attendance\}\}/,'only attendance is saved at start, so no default scores are recorded');
  assert.match(trainer,/onClick=\{\(\)=>void startSession\(\)\}>Start session</);
  assert.match(trainer,/<span>ATTENDANCE & SAFETY<\/span>.*\{attendanceControls\}<\/section><div className=\{styles\.actions\}><button disabled=\{busy\} onClick=\{\(\)=>void act\("save_report",\{report\}\)\}>Save report/,'the in-session report keeps the confirmations editable');
  assert.match(trainer,/!selected\.ownerHandover\|\|!attendanceReady\} onClick=\{\(\)=>void act\("complete",\{report\}\)\}/,'completion waits for a genuine confirmation');
  assert.match(trainer,/const attendanceReady=safeArea&&\(attendanceMode!=="parent"\|\|parentConfirmed\);/);
  assert.match(trainer,/<strong>\{trainerName\|\|providerId\}<\/strong>/,'the header shows the trainer name, falling back to the provider id');
 });
 // Staging E2E 36243387701: /trainer held "Loading trainer workspace…" until the selected session's photos had
 // loaded too (identity, sessions, media: three sequential requests), past the run's waits. The data side is
 // executed in tests/trainer-workspace-d1-scale.test.mjs; this pins the page's order and its stale-response guard.
 test('trainer: the workspace opens once sessions are listed, and only the newest photo read writes',()=>{
  const trainer=read('app/trainer/page.tsx');
  const start=trainer.indexOf('useEffect(()=>{let active=true;'),effect=trainer.slice(start,trainer.indexOf('[requestedBookingId,requestedSessionId]);',start));
  assert.ok(start>=0&&effect.length>0,'the workspace load effect');
  const listed=effect.indexOf('await loadTrainerSessions(identity.subjectId)'),opened=effect.indexOf('setLoading(false);void providerDisplayName('),photos=effect.indexOf('if(first)await showEvidence(first.id);');
  assert.ok(listed>=0&&opened>listed&&photos>opened,'loading ends after the sessions list and before the photos and display name are requested');
  assert.doesNotMatch(effect,/loadTrainingEvidence|finally\{setLoading\(false\)/,'the loading state no longer waits for the photo read');
  assert.match(effect,/if\(!active\)return;setProviderId\(identity\.subjectId\);/,'a superseded load (new bookingId/sessionId) cannot replace the newer selection');
  assert.match(effect,/\.then\(name=>\{if\(active\)setTrainerName\(name\|\|""\);\}\)/);
  assert.match(effect,/catch\(problem\)\{if\(active\)\{setError\(problem instanceof Error\?problem\.message:"Unable to authenticate trainer"\);setLoading\(false\);\}\}/,'a failed load still leaves the loading state');
  assert.match(trainer,/const newestRequest=\(counter:\{current:number\}\)=>\{const request=\+\+counter\.current;return\(\)=>request===counter\.current;\};/);
  // Every photo read takes a turn first, and every write of its result checks that the turn is still current.
  const reads=trainer.match(/await loadTrainingEvidence\(/g)||[],turns=trainer.match(/const current=newestRequest\(evidenceRequest\);/g)||[];
  assert.equal(reads.length,4);assert.equal(turns.length,3,'showEvidence, refreshEvidence and addEvidence (whose two reads share one turn)');
  assert.equal((trainer.match(/setEvidence\(result\.assets\)/g)||[]).length,(trainer.match(/if\(current\(\)\)\{?setEvidence\(result\.assets\)/g)||[]).length,'no unguarded evidence write');
  assert.match(trainer,/async function selectSession\(session:TrainerSession\)\{setSelectedId\(session\.id\);applyEditor\(editorFrom\(session\)\);await showEvidence\(session\.id\);\}/);
 });
}
