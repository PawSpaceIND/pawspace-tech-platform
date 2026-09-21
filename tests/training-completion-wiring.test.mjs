import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {freshWorld,seedBooking,TRAINER,OTHER_TRAINER,DOORSTEP,REPORT,routeCall,sessionCookie,ORIGIN} from "./helpers/training-lifecycle-harness.mjs";
const client=await import("../lib/training-session-client.ts");
const {materializeTrainingBooking}=await import("../lib/training-programme.ts");
const sessionsRoute=await import("../app/api/training-sessions/route.ts");
const media=await import("../app/api/training-session-media/route.ts");
const upload=await import("../app/api/service-media/upload/route.ts");
const React=await import("react"),{renderToStaticMarkup}=await import("react-dom/server");
const {TrainingEvidenceControls,TrainingOwnerHandover}=await import("../app/trainer/session-proof.tsx");
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lqkAAAAASUVORK5CYII=','base64');
async function world(options={}){
 const w=freshWorld(options);seedBooking(w,{id:"WIRE",group:"WIRE-G",packageCode:"trainer-meet-greet",packageName:"Trainer Meet & Greet",sessions:1,total:500,dueNow:500});
 const {sessions}=await materializeTrainingBooking(w.db,{bookingId:"WIRE",actorId:"qa"});
 return {...w,session:sessions[0],cookie:await sessionCookie(w.db,"provider",TRAINER)};
}
async function withClient(w,fn){
 const original=globalThis.fetch,nav=Object.getOwnPropertyDescriptor(globalThis,"navigator"),calls=[];
 Object.defineProperty(globalThis,"navigator",{configurable:true,value:{geolocation:{getCurrentPosition:success=>success({coords:DOORSTEP})}}});
 globalThis.fetch=async(path,init={})=>{
  const method=init.method??"GET",url=new URL(path,ORIGIN);calls.push({path:url.pathname,method,body:init.body});
  const routes={"/api/training-sessions":sessionsRoute,"/api/training-session-media":media,"/api/service-media/upload":upload};
  const handler=routes[url.pathname]?.[method];assert.ok(handler,"Unexpected client route "+url.pathname);
  return handler(new Request(url,{...init,headers:{...init.headers,cookie:w.cookie,origin:ORIGIN}}));
 };
 try{return await fn(calls);}finally{globalThis.fetch=original;if(nav)Object.defineProperty(globalThis,"navigator",nav);else delete globalThis.navigator;}
}
async function review(w,id){return routeCall(media.PATCH,"PATCH","/api/training-session-media",{preview:true,body:{id,action:"record_review",decision:"approved",reason:"Independent local UAT photo review"}});}

test("real Training client -> routes -> SQLite completes only after location, owner handover and released before/after bytes",async()=>{
 const w=await world();await withClient(w,async calls=>{
  for(const action of ["accept","on_the_way","arrive","start"])await client.trainingSessionAction({sessionId:w.session.id,action});
  const arrived=JSON.parse(calls.find(c=>c.path==='/api/training-sessions'&&JSON.parse(c.body).action==='arrive').body);assert.equal(arrived.latitude,DOORSTEP.latitude);assert.equal(arrived.longitude,DOORSTEP.longitude);
  const file=new File([png],"qa.png",{type:"image/png"});
  const before=await client.prepareTrainingEvidence({sessionId:w.session.id,file,purpose:"before_service"});
  const after=await client.prepareTrainingEvidence({sessionId:w.session.id,file,purpose:"after_service"});
  assert.notEqual(before.id,after.id,"identical fixture bytes remain bound to their distinct proof slots");assert.equal(before.objectStored,false,"no real bucket is configured in this isolated world");assert.equal(calls.filter(c=>c.method==='PUT').length,2);
  const report={...REPORT,progress:{focus:7},evidenceRefs:[before.ref,after.ref]};
  await assert.rejects(client.trainingSessionAction({sessionId:w.session.id,action:"complete",report}));
  await client.trainingSessionAction({sessionId:w.session.id,action:"owner_handover",ownerHandoverMinutes:18});
  const rows=await client.loadTrainerSessions(TRAINER);assert.equal(rows[0].ownerHandover.durationMinutes,18);assert.ok(rows[0].ownerHandover.completedAt>0);
  await assert.rejects(client.trainingSessionAction({sessionId:w.session.id,action:"complete",report}),"uploaded-only files cannot complete");
  const self=await routeCall(media.PATCH,"PATCH","/api/training-session-media",{cookie:w.cookie,body:{id:before.id,action:"record_review",decision:"approved",reason:"Uploader cannot approve"}});assert.equal(self.status,403);
  for(const id of [before.id,after.id]){const r=await review(w,id);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.data.proofReady,true);}
  const ready=await client.loadTrainingEvidence(w.session.id);assert.equal(ready.assets.filter(a=>a.proofReady).length,2);
  assert.ok(ready.assets.every(a=>a.scan_status==='pending'),"UAT human review is never mislabeled as a scanner result");
  const repeated=await client.prepareTrainingEvidence({sessionId:w.session.id,file,purpose:"before_service"});assert.equal(repeated.id,before.id);assert.equal(repeated.alreadyUploaded,true);assert.equal(calls.filter(c=>c.method==='PUT').length,2);
  const completed=await client.trainingSessionAction({sessionId:w.session.id,action:"complete",report});assert.equal(completed.status,"completed");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_session_consumptions").get().n,1);assert.equal(w.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='WIRE'").get().status,'completed');
 });
});

test("denied location does not send an arrival mutation",async()=>{
 const w=await world();await withClient(w,async calls=>{
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{geolocation:{getCurrentPosition:(_success,fail)=>fail({code:1})}}});
  await assert.rejects(client.trainingSessionAction({sessionId:w.session.id,action:'arrive'}),/Allow location access/);assert.equal(calls.length,0);
 });
});

test("a lost registration response can be retried, while each session owns its pending upload",async()=>{
 const w=await world();const sha256=createHash('sha256').update(png).digest('hex');
 const body={sessionId:w.session.id,purpose:'before_service',mimeType:'image/png',sizeBytes:png.length,sha256,retryUpload:true};
 const first=await routeCall(media.POST,'POST','/api/training-session-media',{cookie:w.cookie,body});assert.equal(first.status,201);
 const next=await routeCall(media.POST,'POST','/api/training-session-media',{cookie:w.cookie,body});assert.equal(next.status,201);assert.notEqual(next.body.data.id,first.body.data.id);
 assert.equal(w.sqlite.prepare("SELECT retention_status FROM service_media_assets WHERE id=?").get(first.body.data.id).retention_status,'superseded');
 const oldUpload=await upload.PUT(new Request(ORIGIN+'/api/service-media/upload',{method:'PUT',headers:{cookie:w.cookie,'content-type':'image/png','x-pawspace-media-id':first.body.data.id,'x-pawspace-upload-token':first.body.data.upload.token},body:png}));assert.equal(oldUpload.status,409);
 // A second session in the same canonical booking must not retire the first session's active grant.
 w.sqlite.prepare("INSERT INTO training_sessions (id,programme_id,booking_id,sequence_no,provider_id,schedule_reservation_id,scheduled_start,scheduled_end,status,attendance_json,homework_json,progress_json,evidence_json,started_at,completed_at,created_at,updated_at) SELECT 'OTHER-SESSION',programme_id,booking_id,2,provider_id,schedule_reservation_id||'-other',scheduled_start,scheduled_end,status,attendance_json,homework_json,progress_json,evidence_json,started_at,completed_at,created_at,updated_at FROM training_sessions WHERE id=?").run(w.session.id);
 const other=await routeCall(media.POST,'POST','/api/training-session-media',{cookie:w.cookie,body:{...body,sessionId:'OTHER-SESSION'}});assert.equal(other.status,201,JSON.stringify(other.body));
 assert.equal(w.sqlite.prepare("SELECT retention_status FROM service_media_assets WHERE id=?").get(next.body.data.id).retention_status,'active');
 const invalid=await routeCall(media.POST,'POST','/api/training-session-media',{cookie:w.cookie,body:{...body,purpose:'stay_update'}});assert.equal(invalid.status,400);
 const foreign=await routeCall(media.POST,'POST','/api/training-session-media',{cookie:await sessionCookie(w.db,'provider',OTHER_TRAINER),body});assert.equal(foreign.status,403);
});

test("Training proof keeps unscanned production assets blocked after human approval",async()=>{
 const w=await world({PAWSPACE_MEDIA_ENV:'production'});await withClient(w,async()=>{
  const registered=await client.prepareTrainingEvidence({sessionId:w.session.id,file:new File([png],'qa.png',{type:'image/png'}),purpose:'before_service'});
  const reviewed=await review(w,registered.id);assert.equal(reviewed.status,200);assert.equal(reviewed.body.data.proofReady,false);
  const assets=(await client.loadTrainingEvidence(w.session.id)).assets;assert.equal(assets[0].proofReady,false);assert.equal(assets[0].access_status,'quarantined');
 });
});

test("trainer completion controls show each proof category and the saved handover, without claiming unreviewed uploads are approved",()=>{
 const html=renderToStaticMarkup(React.createElement(TrainingEvidenceControls,{assets:[{id:'M',purpose:'before_service',proofReady:false,access_status:'quarantined',review_status:'pending_review'}],busy:false,error:'',onUpload:()=>{},onRefresh:()=>{}}));
 assert.match(html,/Before photo: Awaiting approval/);assert.match(html,/After photo: Not uploaded/);assert.match(html,/Refresh photo approval/);
 const handed=renderToStaticMarkup(React.createElement(TrainingOwnerHandover,{record:{durationMinutes:18,completedAt:1},busy:false,onRecord:()=>{}}));assert.match(handed,/18 minutes/);
 const empty=renderToStaticMarkup(React.createElement(TrainingOwnerHandover,{record:null,busy:false,onRecord:()=>{}}));assert.match(empty,/Minutes completed/);assert.match(empty,/disabled=""/);
});
