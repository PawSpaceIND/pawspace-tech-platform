import test from 'node:test';
import assert from 'node:assert/strict';
import {installAiHooks,freshAiDb,seedCustomer,inboundMessage,applyOwnedDdl} from './helpers/ai-harness.mjs';
import {d1} from './helpers/execution-harness.mjs';
import {installRevisionPrerequisites,revisionMigration} from './helpers/grooming-authority-harness.mjs';
import {splitSqlStatements} from '../scripts/schema/sql-statements.mjs';
installAiHooks();
const {installGroomingRevisionRuntimeSchema:installCore,groomingRevisionTableDefinitionTokens:tokens}=await import('../lib/grooming-revision-runtime-schema.ts');
const {groomingRevisionPrerequisiteDdl:groomingRevisionTableDdl}=await import('../lib/grooming-revision-schema.ts');
const {expectedGroomingTriggers,assertGroomingRevisionInstallation:ready}=await import('../lib/grooming-revision-installation.ts');
const {CANONICAL_BOOKING_CORE_DDL}=await import('../lib/canonical-booking-core-schema.ts');
const {readPersistedGroomingOwnershipLease:lease,persistedOwnershipBatchGuard:guard}=await import('../lib/grooming-persisted-ownership-lease.ts');
const {POST}=await import('../app/api/ai-bootstrap/route.ts');
const email='installer@pawspace.test';
const {securityAuditStatement}=await import('../lib/server-auth.ts');
const installerActor={email,name:'Installer',roleCode:'schema_installer',permissions:['settings.manage'],developmentPreview:false,identitySource:'workspace',principalType:'email',principalKey:email};
const install=(db,actorEmail)=>installCore(db,actorEmail,result=>securityAuditStatement(db,installerActor,'ai.bootstrap.grooming_schema_install','grooming_revision_schema',null,'completed',result));
const normalize=sql=>sql.replace(/\bIF NOT EXISTS\s+/g,'').replace(/\s+/g,' ').replace(/;\s*$/,'').trim();
const conflict=e=>e instanceof Response&&e.status===409;
async function world(prerequisites=true){
 const w=freshAiDb({PAWSPACE_DEPLOYMENT_ENV:'staging',PAWSPACE_WORKSPACE_IDENTITY_TRUST:'openai-dispatch',PAWSPACE_DEPLOYMENT_INCARNATION:'installer-test-deployment'});
 w.db=d1(w.sqlite);globalThis.__AI_DB__=w.db;
 if(prerequisites){
  seedCustomer(w.sqlite,'CUS-I','Installer','9876500011');
  await inboundMessage(w.sqlite,w.db,{threadId:'THREAD-I',customerId:'CUS-I',text:'Grooming',idempotencyKey:'INSTALL-I'});
  applyOwnedDdl(w.sqlite,'lib/ai-human-handoff.ts');applyOwnedDdl(w.sqlite,'lib/ai-conversation-orchestrator.ts');
  w.sqlite.exec('DROP TABLE canonical_bookings');for(const sql of CANONICAL_BOOKING_CORE_DDL)w.sqlite.exec(sql);
  installRevisionPrerequisites(w.sqlite);
 }
 const exists=table=>Boolean(w.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
 const approve=(overrides={})=>{
  const expectedInstallation=exists('grooming_revision_installation_epoch')?w.sqlite.prepare('SELECT epoch,incarnation FROM grooming_revision_installation_epoch WHERE id=1').get()??null:null;
  const expectedDatabaseIncarnation=exists('grooming_effective_control_revision')?w.sqlite.prepare('SELECT database_incarnation FROM grooming_effective_control_revision WHERE id=1').get()?.database_incarnation??null:null;
  globalThis.__PAWSPACE_TEST_ENV__.PAWSPACE_GROOMING_SCHEMA_INSTALL_APPROVAL=JSON.stringify({purpose:'grooming_revision_installation',binding:'DB',schemaVersion:2,actorEmail:email,
   deploymentIncarnation:'installer-test-deployment',workersDrained:true,expiresAt:Date.now()+60000,approvalId:'isolated-approval',expectedInstallation,expectedDatabaseIncarnation,...overrides});
 };
 approve();return {...w,approve,exists};
}
function request(body={operation:'install_grooming_revision_schema'},actor=email,origin='https://app.pawspace.test'){
 return new Request('https://app.pawspace.test/api/ai-bootstrap',{method:'POST',headers:{origin,'content-type':'application/json','oai-authenticated-user-email':actor},body:JSON.stringify(body)});
}
function provision(w,permission=true){
 w.sqlite.prepare("INSERT INTO role_definitions VALUES('schema_installer','Installer','Isolated endpoint test',?,0,1)").run(JSON.stringify(permission?['settings.manage']:[]));
 w.sqlite.prepare("INSERT INTO app_users VALUES('INSTALLER',?,'Installer','schema_installer','active',1,1)").run(email);
}

test('runtime/archive table declarations and all trigger definitions agree',()=>{
 const archive=splitSqlStatements(revisionMigration);
 for(const ddl of groomingRevisionTableDdl)assert.ok(archive.some(sql=>/^CREATE TABLE/i.test(sql)&&JSON.stringify(tokens(sql))===JSON.stringify(tokens(ddl))),ddl);
 const triggers=archive.filter(sql=>/^CREATE TRIGGER/i.test(sql));assert.equal(triggers.length,expectedGroomingTriggers.length);
 for(const trigger of expectedGroomingTriggers)assert.ok(triggers.some(sql=>normalize(sql)===normalize(trigger.sql)),trigger.name);
});

test('missing source prerequisites refuse before creating any revision schema',async()=>{
 const w=await world(false);await assert.rejects(()=>install(w.db,email),conflict);assert.equal(w.exists('conversation_ownership_revisions'),false);w.sqlite.close();
});

test('actual runtime installation backfills and intact replay writes only completion audit',async()=>{
 const w=await world(),result=await install(w.db,email);assert.equal(result.status,'installed');await ready(w.db);
 assert.equal(w.sqlite.prepare("SELECT revision FROM conversation_ownership_revisions WHERE thread_id='THREAD-I'").get().revision,1);
 w.approve();const before=w.sqlite.prepare('SELECT * FROM grooming_revision_installation_epoch').get();
 const original=w.db.batch;w.db.batch=items=>{assert.ok(items.every(item=>item.sql.startsWith('SELECT ')||item.sql.startsWith('INSERT INTO security_audit_events')),'intact replay may only assert and audit');return original(items);};assert.equal((await install(w.db,email)).status,'intact');w.db.batch=original;
 assert.deepEqual(w.sqlite.prepare('SELECT * FROM grooming_revision_installation_epoch').get(),before);w.sqlite.close();
});

test('runtime repair invalidates a lease issued before a missing-trigger mutation gap',async()=>{
 const w=await world();await install(w.db,email);const old=await lease(w.db,{threadId:'THREAD-I',customerId:'CUS-I',actor:'ai'});
 w.sqlite.exec('DROP TRIGGER conversation_revision_update');w.sqlite.exec("UPDATE communication_threads SET assigned_to='employee'; UPDATE communication_threads SET assigned_to='ai-orchestrator'");
 w.approve();assert.equal((await install(w.db,email)).status,'repaired');await assert.rejects(()=>w.db.batch([guard(w.db,old)]));w.sqlite.close();
});

test('concurrent installers cannot both commit against an uninitialized approval',async()=>{
 const w=await world(),results=await Promise.allSettled([install(w.db,email),install(w.db,email)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);await ready(w.db);w.sqlite.close();
});

test('failed trigger replacement rolls back installation epoch and preserves unavailable readiness',async()=>{
 const w=await world();await install(w.db,email);w.sqlite.exec('DROP TRIGGER conversation_revision_update');w.approve();
 const before=w.sqlite.prepare('SELECT * FROM grooming_revision_installation_epoch').get(),batch=w.db.batch;
 w.db.batch=items=>batch([...items,w.db.prepare('SELECT abs(-9223372036854775808)')]);
 await assert.rejects(()=>install(w.db,email),conflict);assert.deepEqual(w.sqlite.prepare('SELECT * FROM grooming_revision_installation_epoch').get(),before);
 await assert.rejects(()=>ready(w.db),conflict);w.sqlite.close();
});

for(const override of [{workersDrained:false},{actorEmail:'other@pawspace.test'},{deploymentIncarnation:'old'},{expiresAt:1}])test(`server maintenance authorization rejects ${JSON.stringify(override)}`,async()=>{
 const w=await world();w.approve(override);await assert.rejects(()=>install(w.db,email),e=>e.status===403);assert.equal(w.exists('conversation_ownership_revisions'),false);w.sqlite.close();
});

test('approval epoch mismatch refuses repair before writes',async()=>{
 const w=await world();await install(w.db,email);w.sqlite.exec('DROP TRIGGER conversation_revision_update');
 await assert.rejects(()=>install(w.db,email),conflict);assert.equal(w.sqlite.prepare('SELECT epoch FROM grooming_revision_installation_epoch').get().epoch,2);w.sqlite.close();
});

test('actual authenticated endpoint installs without seeding profile/prompt/knowledge',async()=>{
 const w=await world();provision(w);const seedTables=['ai_assistant_profile_versions','ai_prompt_policy_versions','ai_knowledge_source_versions','ai_intent_versions','ai_kill_switches','ai_audience_rollout','whatsapp_conversation_routing_modes'];
 const before=seedTables.map(table=>w.sqlite.prepare(`SELECT * FROM ${table}`).all());
 const response=await POST(request());assert.equal(response.status,201,await response.clone().text());await ready(w.db);
 assert.deepEqual(seedTables.map(table=>w.sqlite.prepare(`SELECT * FROM ${table}`).all()),before);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE action='ai.bootstrap.grooming_schema_install'").get().n,1);
 w.approve();assert.equal((await POST(request())).status,200);w.sqlite.close();
});

test('endpoint rejects cross-origin, missing permission and client drain/seed fields',async()=>{
 const w=await world();provision(w,false);
 assert.equal((await POST(request(undefined,email,'https://attacker.test'))).status,403);
 assert.equal((await POST(request())).status,403);assert.equal(w.exists('conversation_ownership_revisions'),false);
 w.sqlite.exec("UPDATE role_definitions SET permissions_json='[\"settings.manage\"]' WHERE code='schema_installer'");
 assert.equal((await POST(request({operation:'install_grooming_revision_schema',workersDrained:true}))).status,400);
 assert.equal((await POST(request({operation:'unknown'}))).status,400);w.sqlite.close();
});


test('missing canonical commercial prerequisite column refuses before revision writes',async()=>{
 const w=await world();w.sqlite.exec('ALTER TABLE canonical_bookings DROP COLUMN currency');
 await assert.rejects(()=>install(w.db,email),conflict);assert.equal(w.exists('conversation_ownership_revisions'),false);w.sqlite.close();
});

test('approval expiry between preflight and final batch rolls back initial installation',async()=>{
 const w=await world();w.approve({expiresAt:Date.now()+2000});const batch=w.db.batch;
 w.db.batch=async items=>{await new Promise(resolve=>setTimeout(resolve,2100));return batch(items);};
 await assert.rejects(()=>install(w.db,email),conflict);assert.equal(w.exists('conversation_ownership_revisions'),false);w.sqlite.close();
});

test('concurrent administrative trigger change loses the installation snapshot guard',async()=>{
 const w=await world();await install(w.db,email);w.sqlite.exec('DROP TRIGGER conversation_revision_update');w.approve();
 const batch=w.db.batch;w.db.batch=async items=>{w.sqlite.exec('CREATE TRIGGER conversation_revision_update AFTER UPDATE ON communication_threads BEGIN SELECT 1; END');return batch(items);};
 await assert.rejects(()=>install(w.db,email),conflict);assert.equal(w.sqlite.prepare('SELECT epoch FROM grooming_revision_installation_epoch').get().epoch,2);
 await assert.rejects(()=>ready(w.db),conflict);w.sqlite.close();
});

test('endpoint cannot install with a client receipt when the server receipt is absent',async()=>{
 const w=await world();provision(w);delete globalThis.__PAWSPACE_TEST_ENV__.PAWSPACE_GROOMING_SCHEMA_INSTALL_APPROVAL;
 assert.equal((await POST(request())).status,403);assert.equal(w.exists('conversation_ownership_revisions'),false);w.sqlite.close();
});

const {ensureGroomingRevisionPrerequisiteTables:prepare}=await import('../lib/grooming-revision-schema.ts');
test('reconciled installer uses the existing prerequisite owner and preserves its empty tables',async()=>{
 const w=await world();await prepare(w.db);w.approve();assert.equal((await install(w.db,email)).status,'installed');await ready(w.db);w.sqlite.close();
});

test('equivalent table syntax with comments, identifier quoting and punctuation spacing installs',async()=>{
 const w=await world();
 for(const ddl of groomingRevisionTableDdl)w.sqlite.exec(ddl.replace('CREATE TABLE','create /*table-owner*/ table').replace('thread_id TEXT','"thread_id" TEXT').replaceAll('(', ' ( ').replaceAll(')', ' ) ').replaceAll(',', ' , '));
 w.approve();assert.equal((await install(w.db,email)).status,'installed');await ready(w.db);w.sqlite.close();
});

for(const [name,change] of [
 ['CHECK bound',sql=>sql.replace('revision BETWEEN 1 AND','revision BETWEEN 2 AND')],
 ['CHECK string literal',sql=>sql.replace("typeof(revision)='integer'","typeof(revision)='INTEGER'")],
 ['primary key',sql=>sql.replace('thread_id TEXT PRIMARY KEY','thread_id TEXT')],
 ['collation',sql=>sql.replace('thread_id TEXT PRIMARY KEY','thread_id TEXT COLLATE NOCASE PRIMARY KEY')],
 ['unique constraint',sql=>sql.replace('revision INTEGER NOT NULL','revision INTEGER NOT NULL UNIQUE')],
 ['nullability',sql=>sql.replace('revision INTEGER NOT NULL','revision INTEGER')],
 ['rowid semantics',sql=>sql+' WITHOUT ROWID'],
])test(`semantic revision table change is refused: ${name}`,async()=>{
 const w=await world();const ddl=groomingRevisionTableDdl.find(sql=>sql.includes('CREATE TABLE IF NOT EXISTS conversation_ownership_revisions'));
 w.sqlite.exec(change(ddl));w.approve();await assert.rejects(()=>install(w.db,email),conflict);
 assert.equal(w.exists('grooming_revision_installation_epoch'),false);w.sqlite.close();
});

for(const [name,sql] of [
 ['index','CREATE UNIQUE INDEX extra_revision_key ON conversation_ownership_revisions(revision)'],
 ['trigger','CREATE TRIGGER extra_revision_trigger AFTER INSERT ON conversation_ownership_revisions BEGIN SELECT 1; END'],
])test(`unexpected revision ${name} is refused without repair`,async()=>{
 const w=await world();await prepare(w.db);w.sqlite.exec(sql);w.approve();await assert.rejects(()=>install(w.db,email),conflict);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM grooming_revision_installation_epoch').get().n,0);w.sqlite.close();
});

test('live schema contract is independent of D1 JSON property serialization order',async()=>{
 const w=await world();await prepare(w.db);w.approve();const original=w.db.prepare;
 w.db.prepare=sql=>{
  const statement=original(sql);if(!sql.startsWith('PRAGMA table_xinfo'))return statement;
  return {...statement,all:async()=>{const result=await statement.all();return {...result,results:result.results.map(row=>Object.fromEntries(Object.entries(row).reverse()))};}};
 };
 assert.equal((await install(w.db,email)).status,'installed');await ready(w.db);w.sqlite.close();
});


test('server approval cannot authorize an alternate D1 binding',async()=>{
 const w=await world();await assert.rejects(()=>install(d1(w.sqlite),email),error=>error.status===403);
 assert.equal(w.exists('conversation_ownership_revisions'),false);w.sqlite.close();
});

function failCompletionAudit(w){w.sqlite.exec("CREATE TRIGGER fail_install_completion_audit BEFORE INSERT ON security_audit_events WHEN NEW.action='ai.bootstrap.grooming_schema_install' BEGIN SELECT RAISE(ABORT,'injected completion audit failure'); END");}
test('review P2: endpoint audit failure rolls back initial installation and readiness',async()=>{
 const w=await world();provision(w);failCompletionAudit(w);
 const response=await POST(request());assert.equal(response.ok,false);
 assert.equal(w.exists('grooming_revision_installation_epoch'),false,'installation must roll back with its failed audit');
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE action='ai.bootstrap.grooming_schema_install'").get().n,0);w.sqlite.close();
});

test('review P2: endpoint audit failure rolls back repair epoch and trigger replacement',async()=>{
 const w=await world();provision(w);await install(w.db,email);w.sqlite.exec('DROP TRIGGER conversation_revision_update');w.approve();failCompletionAudit(w);
 const before=w.sqlite.prepare('SELECT * FROM grooming_revision_installation_epoch').get();
 const count=w.sqlite.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE action='ai.bootstrap.grooming_schema_install'").get().n;
 assert.equal((await POST(request())).ok,false);
 assert.deepEqual(w.sqlite.prepare('SELECT * FROM grooming_revision_installation_epoch').get(),before);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name='conversation_revision_update'").get().n,0);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE action='ai.bootstrap.grooming_schema_install'").get().n,count);w.sqlite.close();
});


test('review P2: intact replay audits without schema change and a failed audit remains retryable',async()=>{
 const w=await world();provision(w);await install(w.db,email);w.approve();failCompletionAudit(w);
 const before=w.sqlite.prepare('SELECT * FROM grooming_revision_installation_epoch').get();
 const count=w.sqlite.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE action='ai.bootstrap.grooming_schema_install'").get().n;
 assert.equal((await POST(request())).ok,false);await ready(w.db);
 assert.deepEqual(w.sqlite.prepare('SELECT * FROM grooming_revision_installation_epoch').get(),before);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE action='ai.bootstrap.grooming_schema_install'").get().n,count);
 w.sqlite.exec('DROP TRIGGER fail_install_completion_audit');assert.equal((await POST(request())).status,200);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE action='ai.bootstrap.grooming_schema_install'").get().n,count+1);
 assert.deepEqual(w.sqlite.prepare('SELECT * FROM grooming_revision_installation_epoch').get(),before);w.sqlite.close();
});

test('review P2: assertion failure after completion audit rolls back repair and audit together',async()=>{
 const w=await world();provision(w);await install(w.db,email);w.sqlite.exec('DROP TRIGGER conversation_revision_update');w.approve();
 const before=w.sqlite.prepare('SELECT * FROM grooming_revision_installation_epoch').get();
 const count=w.sqlite.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE action='ai.bootstrap.grooming_schema_install'").get().n;
 const batch=w.db.batch;w.db.batch=items=>batch([...items,w.db.prepare('SELECT abs(-9223372036854775808)')]);
 assert.equal((await POST(request())).ok,false);
 assert.deepEqual(w.sqlite.prepare('SELECT * FROM grooming_revision_installation_epoch').get(),before);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE action='ai.bootstrap.grooming_schema_install'").get().n,count);w.sqlite.close();
});

test('review P2: successful repair completion audit records the committed installation epoch',async()=>{
 const w=await world();provision(w);await install(w.db,email);w.sqlite.exec('DROP TRIGGER conversation_revision_update');w.approve();
 const response=await POST(request());assert.equal(response.status,201);const result=(await response.json()).data;
 const rows=w.sqlite.prepare("SELECT detail_json FROM security_audit_events WHERE action='ai.bootstrap.grooming_schema_install'").all().map(row=>JSON.parse(row.detail_json));
 assert.equal(rows.filter(row=>row.status==='repaired'&&row.installation.epoch===result.installation.epoch&&row.approvalId===result.approvalId).length,1);
 assert.equal(w.sqlite.prepare('SELECT epoch FROM grooming_revision_installation_epoch').get().epoch,result.installation.epoch);w.sqlite.close();
});
