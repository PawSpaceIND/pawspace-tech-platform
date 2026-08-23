/**
 * Provider LMS / SOP library - the training module the business gap check asked to expand.
 *
 * Staff author versioned SOP/training modules (content sections + a real pass/fail quiz) scoped to
 * a service or to every provider. Providers complete a module by ANSWERING the quiz - a completion
 * is only earned at or above the module's pass mark, attempts are recorded idempotently, and a
 * republished module (content change -> version bump) invalidates old completions so stale
 * knowledge never counts as trained. Readiness is derived live: a provider is training-ready only
 * when every REQUIRED published module covering their services has a passing attempt at the
 * CURRENT version.
 */

type Db=D1Database;
type Row=Record<string,unknown>;

export type LmsQuizQuestion={question:string;options:string[];answerIndex:number};
export type LmsModuleInput={id?:string;title:string;serviceCode:string;summary:string;sections:string[];quiz:LmsQuizQuestion[];passPct?:number;required?:boolean;actorId:string};

const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
const SERVICE_SCOPES=new Set(["all","grooming","dog_training","boarding","pet_sitting","pet_taxi","dog_walking","pet_food","pet_relocation"]);
const parse=<T>(value:unknown,fallback:T):T=>{try{return JSON.parse(String(value??"")) as T}catch{return fallback}};

export async function ensureLmsTables(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS lms_modules (id TEXT PRIMARY KEY,title TEXT NOT NULL,service_code TEXT NOT NULL,summary TEXT NOT NULL,content_json TEXT NOT NULL,quiz_json TEXT NOT NULL,pass_pct INTEGER NOT NULL DEFAULT 80,required INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'draft',updated_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS lms_module_events (id TEXT PRIMARY KEY,module_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS lms_completion_attempts (id TEXT PRIMARY KEY,module_id TEXT NOT NULL,provider_id TEXT NOT NULL,module_version INTEGER NOT NULL,score_pct INTEGER NOT NULL,passed INTEGER NOT NULL,answers_json TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL)"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_lms_attempts_provider ON lms_completion_attempts(provider_id,module_id,module_version,passed)"),
]);}

async function moduleEvent(db:Db,moduleId:string,eventType:string,actorId:string,detail:unknown={}){await db.prepare("INSERT INTO lms_module_events (id,module_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(),moduleId,eventType,actorId,JSON.stringify(detail),Date.now()).run();}
function requireText(value:unknown,name:string,min=3){const text=String(value||"").trim();if(text.length<min)throw new Response(`${name} is required`,{status:400});return text;}

function validateQuiz(quiz:LmsQuizQuestion[]){
 if(!Array.isArray(quiz)||quiz.length<1)throw new Response("A module needs at least one quiz question",{status:400});
 for(const item of quiz){
  if(String(item?.question||"").trim().length<5)throw new Response("Each quiz question needs real text",{status:400});
  if(!Array.isArray(item.options)||item.options.length<2||item.options.some(option=>String(option||"").trim().length<1))throw new Response("Each quiz question needs at least two answer options",{status:400});
  const answer=Number(item.answerIndex);
  if(!Number.isInteger(answer)||answer<0||answer>=item.options.length)throw new Response("Each quiz question needs a valid correct-answer index",{status:400});
 }
}

/** Create or edit a module. Editing a PUBLISHED module bumps its version, which invalidates every
 *  existing completion by design - retraining is the point of a content change. */
export async function saveLmsModule(db:Db,input:LmsModuleInput){
 await ensureLmsTables(db);
 const title=requireText(input.title,"Module title"),summary=requireText(input.summary,"Module summary",5),serviceCode=String(input.serviceCode||"").trim();
 if(!SERVICE_SCOPES.has(serviceCode))throw new Response("Module service scope must be 'all' or a real service code",{status:400});
 const sections=(input.sections||[]).map(section=>String(section||"").trim()).filter(section=>section.length>0);
 if(!sections.length)throw new Response("A module needs at least one content section",{status:400});
 validateQuiz(input.quiz);
 const passPct=input.passPct==null?80:Math.floor(Number(input.passPct));
 if(!Number.isInteger(passPct)||passPct<1||passPct>100)throw new Response("Pass mark must be 1-100",{status:400});
 const now=Date.now();
 if(input.id){
  const existing=await db.prepare("SELECT * FROM lms_modules WHERE id=?").bind(input.id).first<Row>();
  if(!existing)throw new Response("Module not found",{status:404});
  if(String(existing.status)==="archived")throw new Response("An archived module cannot be edited",{status:409});
  const nextVersion=String(existing.status)==="published"?Number(existing.version)+1:Number(existing.version);
  await db.prepare("UPDATE lms_modules SET title=?,service_code=?,summary=?,content_json=?,quiz_json=?,pass_pct=?,required=?,version=?,updated_by=?,updated_at=? WHERE id=?")
   .bind(title,serviceCode,summary,JSON.stringify(sections),JSON.stringify(input.quiz),passPct,input.required===false?0:1,nextVersion,input.actorId,now,input.id).run();
  await moduleEvent(db,input.id,nextVersion>Number(existing.version)?"republished":"updated",input.actorId,{version:nextVersion,retrainingRequired:nextVersion>Number(existing.version)});
  return{moduleId:input.id,version:nextVersion,status:String(existing.status),retrainingRequired:nextVersion>Number(existing.version)};
 }
 const id=uid("LMS");
 await db.prepare("INSERT INTO lms_modules (id,title,service_code,summary,content_json,quiz_json,pass_pct,required,version,status,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,'draft',?,?,?)")
  .bind(id,title,serviceCode,summary,JSON.stringify(sections),JSON.stringify(input.quiz),passPct,input.required===false?0:1,input.actorId,now,now).run();
 await moduleEvent(db,id,"created",input.actorId,{serviceCode,passPct});
 return{moduleId:id,version:1,status:"draft",retrainingRequired:false};
}

export async function setLmsModuleStatus(db:Db,input:{moduleId:string;status:"published"|"archived";actorId:string}){
 await ensureLmsTables(db);
 const moduleRow=await db.prepare("SELECT id,status FROM lms_modules WHERE id=?").bind(String(input.moduleId||"")).first<Row>();
 if(!moduleRow)throw new Response("Module not found",{status:404});
 if(String(moduleRow.status)===input.status)return{moduleId:String(moduleRow.id),status:input.status,duplicatePrevented:true};
 if(input.status==="published"&&String(moduleRow.status)==="archived")throw new Response("An archived module cannot be republished; create a new module",{status:409});
 await db.prepare("UPDATE lms_modules SET status=?,updated_at=? WHERE id=?").bind(input.status,Date.now(),moduleRow.id).run();
 await moduleEvent(db,String(moduleRow.id),input.status,input.actorId);
 return{moduleId:String(moduleRow.id),status:input.status,duplicatePrevented:false};
}

/** A provider earns a completion by answering the CURRENT version's quiz at or above the pass
 *  mark. Every attempt is recorded (idempotent per key); failing attempts never count as trained. */
export async function submitLmsCompletion(db:Db,input:{moduleId:string;providerId:string;answers:number[];idempotencyKey:string;actorId:string}){
 await ensureLmsTables(db);
 const idempotencyKey=requireText(input.idempotencyKey,"Idempotency key",4);
 const prior=await db.prepare("SELECT * FROM lms_completion_attempts WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
 if(prior)return{attemptId:String(prior.id),scorePct:Number(prior.score_pct),passed:Number(prior.passed)===1,moduleVersion:Number(prior.module_version),duplicatePrevented:true};
 const providerId=requireText(input.providerId,"Provider");
 const moduleRow=await db.prepare("SELECT * FROM lms_modules WHERE id=?").bind(String(input.moduleId||"")).first<Row>();
 if(!moduleRow)throw new Response("Module not found",{status:404});
 if(String(moduleRow.status)!=="published")throw new Response("Only a published module can be completed",{status:409});
 const quiz=parse<LmsQuizQuestion[]>(moduleRow.quiz_json,[]);
 if(!Array.isArray(input.answers)||input.answers.length!==quiz.length)throw new Response(`This module's quiz has ${quiz.length} question(s); answer all of them`,{status:400});
 const correct=quiz.reduce((count,question,index)=>count+(Number(input.answers[index])===Number(question.answerIndex)?1:0),0);
 const scorePct=Math.round((correct/quiz.length)*100),passed=scorePct>=Number(moduleRow.pass_pct);
 const id=uid("LMA");
 await db.prepare("INSERT INTO lms_completion_attempts (id,module_id,provider_id,module_version,score_pct,passed,answers_json,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
  .bind(id,moduleRow.id,providerId,Number(moduleRow.version),scorePct,passed?1:0,JSON.stringify(input.answers),idempotencyKey,Date.now()).run();
 return{attemptId:id,moduleId:String(moduleRow.id),moduleVersion:Number(moduleRow.version),scorePct,passPct:Number(moduleRow.pass_pct),passed,duplicatePrevented:false};
}

async function tableExists(db:Db,name:string){const row=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>();return Boolean(row);}

/** Which required modules cover this provider, and is each one passed at the CURRENT version? */
export async function providerTrainingReadiness(db:Db,providerId:string){
 await ensureLmsTables(db);
 // Whether the provider's service set could be ESTABLISHED, kept separate from what it contains. A
 // provider with no capacity profile — anyone not yet activated — resolves to an empty service list, and
 // an empty list makes every "is each required module complete?" question vacuously true. Reporting that
 // as training-ready tells staff a provider who has completed nothing is cleared to work.
 let services:string[]=[];
 let servicesResolved=false;
 if(await tableExists(db,"provider_capacity_profiles")){
  const profile=await db.prepare("SELECT services_json FROM provider_capacity_profiles WHERE id=?").bind(providerId).first<Row>();
  if(profile){services=parse<string[]>(profile?.services_json,[]);servicesResolved=services.length>0;}
 }
 const modules=await db.prepare("SELECT id,title,service_code,version,pass_pct,required,summary FROM lms_modules WHERE status='published' ORDER BY created_at").all<Row>();
 const applicable=modules.results.filter(row=>String(row.service_code)==="all"||services.includes(String(row.service_code)));
 const items=[];
 for(const row of applicable){
  const passedNow=await db.prepare("SELECT id,score_pct,created_at FROM lms_completion_attempts WHERE module_id=? AND provider_id=? AND module_version=? AND passed=1 ORDER BY created_at DESC LIMIT 1").bind(row.id,providerId,Number(row.version)).first<Row>();
  const passedEver=passedNow?null:await db.prepare("SELECT module_version FROM lms_completion_attempts WHERE module_id=? AND provider_id=? AND passed=1 ORDER BY created_at DESC LIMIT 1").bind(row.id,providerId).first<Row>();
  items.push({moduleId:String(row.id),title:String(row.title),serviceCode:String(row.service_code),version:Number(row.version),required:Number(row.required)===1,passPct:Number(row.pass_pct),
   state:passedNow?"complete":passedEver?"stale_retraining_required":"not_started",
   completedAt:passedNow?Number(passedNow.created_at):null,scorePct:passedNow?Number(passedNow.score_pct):null});
 }
 const requiredItems=items.filter(item=>item.required);
 const allComplete=requiredItems.every(item=>item.state==="complete");
 // Unknown is not satisfied. Readiness is claimed only when we know what the provider does AND every
 // module required for it is complete; otherwise the reason is stated rather than left to be inferred
 // from a bare `false`.
 const trainingReady=servicesResolved&&allComplete;
 const readinessReason=servicesResolved
  ?(allComplete?"required_modules_complete":"required_modules_outstanding")
  :"provider_services_unknown";
 return{providerId,services,servicesResolved,modules:items,requiredTotal:requiredItems.length,requiredComplete:requiredItems.filter(item=>item.state==="complete").length,trainingReady,readinessReason};
}

/** Staff overview: every module with live pass stats, and provider compliance across the fleet. */
export async function lmsOverview(db:Db){
 await ensureLmsTables(db);
 const modules=await db.prepare("SELECT * FROM lms_modules ORDER BY created_at DESC LIMIT 200").all<Row>();
 const moduleStats=[];
 for(const row of modules.results){
  const stats=await db.prepare("SELECT COUNT(DISTINCT CASE WHEN passed=1 AND module_version=? THEN provider_id END) passed_current,COUNT(*) attempts FROM lms_completion_attempts WHERE module_id=?").bind(Number(row.version),row.id).first<Row>();
  moduleStats.push({...row,sections:parse<string[]>(row.content_json,[]),quizQuestions:parse<LmsQuizQuestion[]>(row.quiz_json,[]).length,providersPassedCurrentVersion:Number(stats?.passed_current||0),totalAttempts:Number(stats?.attempts||0)});
 }
 const providers:Array<{providerId:string;name:string;trainingReady:boolean;requiredComplete:number;requiredTotal:number}>=[];
 if(await tableExists(db,"provider_capacity_profiles")){
  const rows=await db.prepare("SELECT id,name FROM provider_capacity_profiles WHERE status='active' AND live=1 ORDER BY name LIMIT 100").all<Row>();
  for(const row of rows.results){
   const readiness=await providerTrainingReadiness(db,String(row.id));
   providers.push({providerId:String(row.id),name:String(row.name),trainingReady:readiness.trainingReady,requiredComplete:readiness.requiredComplete,requiredTotal:readiness.requiredTotal});
  }
 }
 return{modules:moduleStats,providers,metrics:{published:modules.results.filter(row=>String(row.status)==="published").length,draft:modules.results.filter(row=>String(row.status)==="draft").length,providersNotReady:providers.filter(provider=>!provider.trainingReady).length},truth:{completionRule:"pass the current version's quiz at or above the module pass mark",republishInvalidatesCompletions:true,productionReady:false}};
}
