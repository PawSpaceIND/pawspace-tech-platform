import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
import {freshSqlite,makeD1} from './helpers/taxi-harness.mjs';
installWorkersHooks('__V2_LAUNCH_REPAIRS_DB__');
// Executable regressions for the V2 human-test launch blockers found by browser UAT on staging-shaped data.
const world=()=>{const sqlite=freshSqlite();return{sqlite,db:makeD1(sqlite)}};
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const loadSql=(sqlite,sql)=>{let buf=[];const run=()=>{const stmt=buf.join('\n').trim();buf=[];if(stmt&&!/^(--[^\n]*\n?)+$/.test(stmt))sqlite.exec(stmt)};for(const line of sql.split(/\r?\n/)){if(/^\s*--/.test(line)&&buf.length===0)continue;buf.push(line);if(/;\s*$/.test(line))run()}run()};

test('lead_callbacks created by drizzle 0021 (intake shape) is repaired additively so governed callbacks and Revenue CRM reads work',async()=>{
 const {sqlite,db}=world();
 const legacy=read('drizzle/0021_loe_communications_ai_haptik.sql').split('\n').find(line=>line.startsWith('CREATE TABLE IF NOT EXISTS lead_callbacks'));
 assert.ok(legacy&&!legacy.includes('requested_at'),'the migration still carries the intake shape this repair targets');
 sqlite.exec(legacy);
 sqlite.exec("INSERT INTO lead_callbacks (id,lead_id,phone,name,preferred_at,reason,status,source,requested_by,created_at,updated_at) VALUES ('LCB-LEGACY','LEAD-1','9000000000','Legacy caller',1700000000000,'call me back','scheduled','haptik','bot',1699999999000,1699999999000)");
 // Minimal lead_work_items carrying every column ensureLeadCallbackTables() indexes on the worklist.
 sqlite.exec("CREATE TABLE lead_work_items (id TEXT PRIMARY KEY,owner TEXT,customer_id TEXT,service TEXT,converted_booking_id TEXT,status TEXT,opt_out INTEGER DEFAULT 0,recycle_at INTEGER,recycle_cycle INTEGER DEFAULT 0,first_action_at INTEGER,manager_alert_at INTEGER)");sqlite.exec("INSERT INTO lead_work_items (id,owner,customer_id,service,status) VALUES ('LEAD-1','rep@pawspace.test','CUS-1','grooming','open')");
 const callbacks=await import('../lib/lead-callback-governance.ts');
 await callbacks.ensureLeadCallbackTables(db);
 const columns=sqlite.prepare('PRAGMA table_info(lead_callbacks)').all().map(c=>c.name);
 for(const column of ['requested_at','scheduled_by','completed_at','completed_outcome','missed_at','phone','preferred_at','source','requested_by'])assert.ok(columns.includes(column),column);
 const row=sqlite.prepare("SELECT requested_at,scheduled_by FROM lead_callbacks WHERE id='LCB-LEGACY'").get();
 assert.equal(row.requested_at,1700000000000);assert.equal(row.scheduled_by,'bot');
 assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='lead_callback_events'").get(),'events table is created once the batch no longer rolls back');
 assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_lead_callbacks_due'").get());
 const due=await callbacks.dueLeadCallbacks(db,{asOf:1700000000001,lookAheadMinutes:1});
 assert.equal(due.length,1);
 await callbacks.ensureLeadCallbackTables(db);
 assert.equal(sqlite.prepare('PRAGMA table_info(lead_callbacks)').all().length,columns.length,'repair is idempotent');
 const fresh=world();await callbacks.ensureLeadCallbackTables(fresh.db);
 assert.ok(fresh.sqlite.prepare('PRAGMA table_info(lead_callbacks)').all().map(c=>c.name).includes('requested_at'),'fresh databases still get the governed shape');
});

test('launch readiness answers a UAT-cookie founder with no workspace header and still refuses anonymous callers',async()=>{
 const {db}=world();globalThis.__V2_LAUNCH_REPAIRS_DB__=db;
 // installWorkersHooks(globalName) reads runtime vars from globalThis[`${globalName}_ENV`].
 const env=globalThis['__V2_LAUNCH_REPAIRS_DB___ENV']={PAWSPACE_UAT_LOGIN:'on',PAWSPACE_UAT_SIGNING_KEY:'v2-launch-repairs-uat-signing-key-2026-09-21'};
 const {ensureSecurityTables}=await import('../lib/server-auth.ts');await ensureSecurityTables(db);
 await db.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('UAT-FOUNDER','founder@pawspace.in','PawSpace Founder','founder','active',1,1)").run();
 const uat=await import('../lib/uat-staging-auth.ts');
 const cookie=`pawspace_uat=${await uat.issueUatToken(env,'founder@pawspace.in',3600)}`;
 const route=await import('../app/api/launch-readiness/route.ts');
 const signedIn=await route.GET(new Request('https://ops.pawspace.example/api/launch-readiness',{headers:{cookie}}));
 const raw=await signedIn.text();assert.equal(signedIn.status,200,raw);
 const body=JSON.parse(raw);assert.ok(body&&typeof body==='object'&&!body.error&&Object.keys(body).length>0,'readiness payload: '+raw.slice(0,120));
 const anonymous=await route.GET(new Request('https://ops.pawspace.example/api/launch-readiness'));
 assert.equal(anonymous.status,401);
 delete globalThis['__V2_LAUNCH_REPAIRS_DB___ENV'];
});

test('subscription business view route works on a database where the grooming plan module has never run',async()=>{
 const {db}=world();globalThis.__V2_LAUNCH_REPAIRS_DB__=db;
 const env=globalThis['__V2_LAUNCH_REPAIRS_DB___ENV']={PAWSPACE_UAT_LOGIN:'on',PAWSPACE_UAT_SIGNING_KEY:'v2-launch-repairs-uat-signing-key-2026-09-21'};
 const {ensureSecurityTables}=await import('../lib/server-auth.ts');await ensureSecurityTables(db);
 await db.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('UAT-FOUNDER','founder@pawspace.in','PawSpace Founder','founder','active',1,1)").run();
 const wallet=await import('../lib/subscription-wallet.ts');
 await wallet.ensureSubscriptionWalletTables(db);
 await db.prepare("INSERT INTO customer_grooming_subscriptions (id,customer_id,plan_code,service_package_code,total_sessions,sessions_reserved,sessions_consumed,status,started_at,expires_at,source_booking_id,catalogue_version,created_at,updated_at) VALUES ('SUB-1','CUS-1','plan-a','dog-basic',4,0,1,'active',1,9999999999999,'BK-1','v1',1,1)").run();
 // The wallet module itself stays dependency-free (tests/lane1-commercial-runtime imports it under
 // the plain loader); the route is what ensures grooming_subscription_plans before the read.
 const uat=await import('../lib/uat-staging-auth.ts');
 const cookie=`pawspace_uat=${await uat.issueUatToken(env,'founder@pawspace.in',3600)}`;
 const route=await import('../app/api/subscription-business-view/route.ts');
 const response=await route.GET(new Request('https://ops.pawspace.example/api/subscription-business-view',{headers:{cookie}}));
 const raw=await response.text();assert.equal(response.status,200,raw);
 const body=JSON.parse(raw);
 assert.equal(body.source,'customer_grooming_subscriptions');
 assert.equal(body.data.priceCoverage.unknown,1);
 const plans=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='grooming_subscription_plans'").all();
 assert.equal(plans.results.length,1,'route must create the plan table it reads');
 delete globalThis['__V2_LAUNCH_REPAIRS_DB___ENV'];
});

test('every seeded manager in employee-seed.sql resolves a full organizational scope and the UAT manager owns Booking Command Center',async()=>{
 const {sqlite,db}=world();loadSql(sqlite,read('scripts/employee-seed.sql'));
 const scope=await import('../lib/organizational-scope.ts');
 const actor=email=>({email,name:email,roleCode:'manager',permissions:['bookings.manage','customers.manage'],developmentPreview:false,identitySource:'workspace',principalType:'email',principalKey:email});
 const expected={'jyoti.manager39@tkpetcare.in':['operations','cc-operations',scope.OPERATIONS_MANAGER_DOMAIN],'sunita.manager37@tkpetcare.in':['sales','cc-sales',scope.CRM_MANAGER_DOMAIN],'karthik.manager38@tkpetcare.in':['operations','cc-operations',scope.OPERATIONS_MANAGER_DOMAIN],'vishal.manager40@tkpetcare.in':['customer-experience','cc-customer-experience',scope.CRM_MANAGER_DOMAIN]};
 for(const [email,[team,department,domain]] of Object.entries(expected)){
  const resolved=await scope.resolveManagerOrganizationalScope(db,actor(email));
  assert.deepEqual({cityId:resolved.cityId,teamCode:resolved.teamCode,departmentCode:resolved.departmentCode},{cityId:'blr',teamCode:team,departmentCode:department},email);
  scope.requireManagerDomain(resolved,domain);
 }
 const jyoti=await scope.resolveManagerOrganizationalScope(db,actor('jyoti.manager39@tkpetcare.in'));
 // requireManagerDomain refuses with a governed 403 Response (authFailure), not an Error.
 let refused=null;try{scope.requireManagerDomain(jyoti,scope.CRM_MANAGER_DOMAIN)}catch(error){refused=error}
 assert.ok(refused instanceof Response);assert.equal(refused.status,403);assert.match((await refused.json()).error,/outside the manager's organizational scope/);
 assert.match(read('app/staging-login/page.tsx'),/Manager \(operations · Booking Command Center & scheduling\)/);
});

test('leave requests without an active policy or with invalid input are governed 4xx refusals, not 500s',async()=>{
 const {db}=world();
 const leave=await import('../lib/attendance-leave.ts');
 const {isGovernedHttpError}=await import('../lib/governed-http-error.ts');
 const attempt=async input=>{try{await leave.requestLeave(db,{employeeId:'E1',leaveCode:'CL',startDate:'2026-10-01',endDate:'2026-10-02',units:2,reason:'family visit',actorId:'E1',...input});return null}catch(error){return error}};
 const noPolicy=await attempt({});
 assert.ok(noPolicy instanceof Response&&isGovernedHttpError(noPolicy));assert.equal(noPolicy.status,409);assert.match((await noPolicy.json()).error,/Active leave policy configuration is required/);
 const badInput=await attempt({units:0});
 assert.ok(badInput instanceof Response);assert.equal(badInput.status,400);
});

test('Employee AI mobile surfaces a refused or failed chat turn instead of clearing the message silently',()=>{
 const source=read('app/mobile-app/employee-ai-mobile.tsx');
 assert.match(source,/<\/form>\{error&&<p role="alert" className=\{styles\.voiceError\}>\{error\}<\/p>\}/);
});
