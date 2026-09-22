import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
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
 const env=globalThis['__V2_LAUNCH_REPAIRS_DB___ENV']={PAWSPACE_UAT_LOGIN:'on',PAWSPACE_UAT_SIGNING_KEY:crypto.randomUUID()+crypto.randomUUID()};
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
 const env=globalThis['__V2_LAUNCH_REPAIRS_DB___ENV']={PAWSPACE_UAT_LOGIN:'on',PAWSPACE_UAT_SIGNING_KEY:crypto.randomUUID()+crypto.randomUUID()};
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

test('Booking Command Center stream refuses out-of-scope and anonymous callers with governed 401/403, never 500 (EMP-15)',async()=>{
 const {sqlite,db}=world();globalThis.__V2_LAUNCH_REPAIRS_DB__=db;loadSql(sqlite,read('scripts/employee-seed.sql'));
 const env=globalThis['__V2_LAUNCH_REPAIRS_DB___ENV']={PAWSPACE_UAT_LOGIN:'on',PAWSPACE_UAT_SIGNING_KEY:crypto.randomUUID()+crypto.randomUUID()};
 const {ensureSecurityTables}=await import('../lib/server-auth.ts');await ensureSecurityTables(db);
 const uat=await import('../lib/uat-staging-auth.ts');
 const cookieFor=async email=>`pawspace_uat=${await uat.issueUatToken(env,email,3600)}`;
 const route=await import('../app/api/booking-command-center/stream/route.ts');
 const url='https://ops.pawspace.example/api/booking-command-center/stream';
 const anonymous=await route.GET(new Request(url));
 assert.equal(anonymous.status,401,await anonymous.text());
 const sales=await route.GET(new Request(url,{headers:{cookie:await cookieFor('sunita.manager37@tkpetcare.in')}}));
 const salesBody=await sales.text();
 assert.equal(sales.status,403,salesBody);
 assert.match(JSON.parse(salesBody).error,/organizational scope/i);
 const controller=new AbortController();
 const operations=await route.GET(new Request(url,{headers:{cookie:await cookieFor('jyoti.manager39@tkpetcare.in')},signal:controller.signal}));
 assert.equal(operations.status,200);
 assert.match(String(operations.headers.get('content-type')),/text\/event-stream/);
 const reader=operations.body.getReader();const first=await reader.read();
 assert.match(new TextDecoder().decode(first.value),/^event: ready/);
 controller.abort();await reader.cancel().catch(()=>{});
 delete globalThis['__V2_LAUNCH_REPAIRS_DB___ENV'];
});

// ---------------------------------------------------------------------------------------------------
// The leave 500 above is fixed and the refusal is governed. What was still open was whether a policy is
// seeded at all: only CL had one, while the /me leave form is a free-text code whose own placeholder
// tells the tester "e.g. CL / SL / EL". Two of the three codes the form suggests therefore dead-ended on
// that governed 409 - correct behaviour, useless for a tester.
//
// Owner decision 2026-09-22: seed a generic sandbox policy set. This executes scripts/employee-seed.sql
// into SQLite and drives the real requestLeave for each code, so a seed that stops carrying one of them
// fails here rather than in someone's test session.
// ---------------------------------------------------------------------------------------------------

test('every leave code the /me form suggests has a seeded UAT policy and a balance to draw on', async () => {
  const {sqlite, db} = world();
  const leave = await import('../lib/attendance-leave.ts');
  const {isGovernedHttpError} = await import('../lib/governed-http-error.ts');
  await leave.ensureAttendanceLeaveTables(db);
  sqlite.exec(read('scripts/employee-seed.sql'));

  // The form's placeholder is the contract being honoured here; if it changes, this must too.
  const form = read('app/me/page.tsx');
  const placeholder = form.match(/placeholder="e\.g\. ([A-Z /]+)"/);
  assert.ok(placeholder, 'the leave form must still advertise its codes in a placeholder');
  const advertised = placeholder[1].split('/').map(code => code.trim()).filter(Boolean);
  assert.deepEqual(advertised, ['CL', 'SL', 'EL'], 'seeded policies below must match what the form suggests');

  const employee = sqlite.prepare("SELECT id FROM employees LIMIT 1").get().id;
  for (const code of advertised) {
    const policy = sqlite.prepare("SELECT status,entitlement_units,approval_reference FROM leave_policies WHERE leave_code=?").get(code);
    assert.ok(policy, `${code} must have a seeded policy`);
    assert.equal(policy.status, 'active_uat', `${code} policy must be active for UAT`);
    assert.ok(Number(policy.entitlement_units) > 0, `${code} must carry an entitlement`);
    assert.equal(policy.approval_reference, 'UAT-ONLY-NOT-PRODUCTION', `${code} must stay marked as sandbox data`);

    const balance = sqlite.prepare("SELECT balance FROM employee_leave_balances WHERE employee_id=? AND leave_code=?").get(employee, code);
    assert.ok(balance && Number(balance.balance) > 0, `${code} must give the seeded employee something to draw on`);

    const created = await leave.requestLeave(db, {
      employeeId: employee, leaveCode: code, startDate: '2026-10-01', endDate: '2026-10-02',
      units: 1, reason: `UAT ${code} request`, actorId: employee,
    });
    assert.ok(created?.id, `${code} must produce a leave request, not a refusal`);
  }

  // The governed refusal must still stand for a code nobody configured - seeding three must not have
  // turned the guard into a blanket pass.
  let refused = null;
  try {
    await leave.requestLeave(db, {employeeId: employee, leaveCode: 'ZZ', startDate: '2026-10-01', endDate: '2026-10-02', units: 1, reason: 'unconfigured code', actorId: employee});
  } catch (error) { refused = error; }
  assert.ok(refused instanceof Response && isGovernedHttpError(refused), 'an unconfigured code must still refuse');
  assert.equal(refused.status, 409);
  sqlite.close();
});

test('employee-seed.sql can be regenerated without losing hand-added rows', () => {
  // scripts/employee-seed.sql is GENERATED by scripts/employee-seed-gen.mjs, but the seeded managers'
  // employment versions were once written straight into the .sql and never added to the generator. The
  // two silently diverged, and simply running the generator dropped them - taking the managers'
  // organizational scope with them, which is what locks them out of Booking Command Center, CRM and
  // People. Every statement the .sql carries for that table must therefore also exist in the generator.
  const sql = read('scripts/employee-seed.sql');
  const gen = read('scripts/employee-seed-gen.mjs');
  const rows = sql.split('\n').filter(line => line.includes('employee_employment_versions'));
  assert.ok(rows.length >= 5, 'the seed must still carry the managers\' employment versions');
  for (const row of rows) {
    assert.ok(gen.includes(JSON.stringify(row)) || gen.includes(row.slice(0, 60)),
      `regenerating would drop this row - add it to employee-seed-gen.mjs:\n  ${row.slice(0, 120)}`);
  }
});
