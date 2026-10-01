// Actual PawSpace turn/quote/booking code against an in-memory fixture DB. No live customer or call.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { setupJourney } from '../tests/helpers/grooming-journey-harness.mjs';
import { seedOwnedPet } from '../tests/helpers/saved-pet-fixture.mjs';

if (process.env.VOICE_SALE_ACTION !== 'evaluate-runtime-sale') throw Error('Explicit isolated runtime sale evaluation required');
const key = String(process.env.PAWSPACE_OPENAI_API_KEY || '').trim();
if (!key) throw Error('Runtime model evaluation credential missing');
const model = String(process.env.PAWSPACE_AI_VOICE_MODEL || 'gpt-5.6-luna');
const scenario = String(process.env.VOICE_SALE_SCENARIO || 'booking');
assert.ok(['booking', 'concierge', 'all-services', 'all-bookings'].includes(scenario), 'Unsupported isolated scenario');
const actor = { email: 'elevenlabs-voice@system.pawspace', name: 'Synthetic Runtime Evaluation', roleCode: 'service_elevenlabs_voice', permissions: ['communications.manage', 'customers.manage', 'bookings.manage', 'scheduling.book'], developmentPreview: false, identitySource: 'workspace', principalType: 'identity_subject', principalKey: 'service:elevenlabs-voice' };
const customerId = 'CUS-MAYA-SYNTHETIC', petId = 'PET-MAYA-SYNTHETIC', threadId = 'THREAD-MAYA-SYNTHETIC';
const start = '2026-10-20T04:30:00.000Z', end = '2026-10-20T06:30:00.000Z';
const realFetch = globalThis.fetch, turns = [], modelDrafts = [];
let modelCalls = 0, paymentRequests = 0;
// Before fixture setup, reject every destination other than the isolated model and mocked order API.
globalThis.fetch = async (url, init) => {
  if (String(url) === 'https://api.openai.com/v1/responses') {
    modelCalls++;
    const response = await realFetch(url, init);
    const body = await response.clone().json().catch(() => ({}));
    const text = body.output_text || (body.output || []).flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text).join('');
    const request = JSON.parse(init.body), context = JSON.parse(request.input).canonicalContext;
    modelDrafts.push({ status: response.status, text, catalogue: context.catalogue });
    return response;
  }
  assert.equal(String(url), 'https://api.razorpay.com/v1/orders', 'Unexpected external request is forbidden');
  paymentRequests++;
  const body = JSON.parse(init.body);
  return Response.json({ id: 'order_maya_synthetic_' + paymentRequests, entity: 'order', amount: body.amount, amount_paid: 0, amount_due: body.amount, currency: body.currency, receipt: body.receipt, status: 'created' });
};
const world = await setupJourney();
const fixtureErrors = [];
const prepare = world.db.prepare;
function traced(statement, sql) {
  const wrapped = { ...statement, bind: (...args) => traced(statement.bind(...args), sql) };
  for (const method of ['first', 'all', 'run']) wrapped[method] = async (...args) => {
    try { return await statement[method](...args); }
    catch (error) { fixtureErrors.push({ sql, error: error.message }); throw error; }
  };
  return wrapped;
}
world.db.prepare = sql => traced(prepare(sql), sql);
try {
  const account = await import('../lib/customer-account.ts');
  const orchestrator = await import('../lib/ai-conversation-orchestrator.ts');
  const rollout = await import('../lib/ai-audience-rollout.ts');
  const scheduling = await import('../app/api/uat-scheduling/route.ts');
  const { runElevenLabsGroundedTurn } = await import('../lib/elevenlabs-custom-llm.ts');
  const sales = await import('../lib/voice-sales-specialists.ts');
  await account.ensureCustomerAccountTables(world.db);
  await (await import('../lib/customer-360.ts')).ensureCustomer360Tables(world.db);
  await (await import('../lib/pricing-control-runtime.ts')).ensurePricingControlRuntime(world.db);
  // Seed packages are intentionally inactive. Activate only these reviewed defaults in this in-memory fixture.
  world.sqlite.prepare("UPDATE service_packages SET active=1 WHERE package_code IN ('dog-basic','dog-makeover')").run();
  await orchestrator.ensureAiConversationOrchestrator(world.db);
  const { applyOwnedDdl } = await import('../tests/helpers/ai-harness.mjs');
  for (const owner of ['lib/training-commercial-governance.ts', 'lib/boarding-governance.ts', 'lib/sitting-governance.ts', 'lib/walking-governance.ts', 'lib/taxi-governance.ts']) applyOwnedDdl(world.sqlite, owner);
  if (scenario.startsWith('all-')) {
    await (await import('../lib/training-commercial-governance.ts')).ensureTrainingCommercialTables(world.db);
    await (await import('../lib/boarding-governance.ts')).ensureBoardingGovernanceTables(world.db);
    await (await import('../lib/sitting-governance.ts')).ensureSittingGovernanceTables(world.db);
    await (await import('../lib/walking-governance.ts')).ensureWalkingGovernanceTables(world.db);
    await (await import('../lib/taxi-governance.ts')).ensureTaxiGovernanceTables(world.db);
  }
  if (scenario !== 'booking') {
    // Publish the repository's reviewed knowledge only inside this temporary in-memory fixture.
    await (await import('../lib/maya-knowledge-base.ts')).seedMayaKnowledge(world.db, { maker: 'synthetic-maker@pawspace.test', checker: 'synthetic-checker@pawspace.test' });
  }
  const now = Date.now();
  world.sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,'blr','Synthetic Maya Evaluator','9876500099','test','{}',?,?)").run(customerId, now, now);
  await seedOwnedPet(world.db, customerId, petId, 'Milo');
  world.sqlite.prepare("INSERT INTO communication_threads (id,customer_id,status,assigned_to,created_at,updated_at) VALUES (?,?,'open','ai-orchestrator',?,?)").run(threadId, customerId, now, now);
  await rollout.setAiRolloutStage(world.db, { stage: 'customers', reason: 'Customer audience enabled only in the in-memory synthetic fixture', actorEmail: actor.email });
  globalThis.__GROOM_GOLDEN_ENV__ = { ...globalThis.__GROOM_GOLDEN_ENV__, FORBID_PRODUCTION: 'true', PAWSPACE_DEPLOYMENT_ENV: 'local', PAWSPACE_AI_PROVIDER: 'openai', PAWSPACE_OPENAI_API_KEY: key, PAWSPACE_AI_VOICE_MODEL: model, RAZORPAY_KEY_ID_SANDBOX: 'rzp_test_synthetic', RAZORPAY_KEY_SECRET_SANDBOX: 'not-a-real-key' };
  await scheduling.executeGovernedSchedulingRequest(new Request('https://internal.pawspace/api/uat-scheduling', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'preview', clientRequestId: 'SYNTHETIC-INIT', customerId, petIds: [petId], serviceCode: 'grooming', serviceAddress: '12 Test Street', servicePincode: '560038', scheduledStart: start, scheduledEnd: end }) }), actor);
  for (const provider of world.sqlite.prepare("SELECT id,city_id,zones_json FROM provider_capacity_profiles WHERE live=1 AND status='active'").all()) {
    world.sqlite.prepare("INSERT OR IGNORE INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) VALUES (?,?,?,12.9716,77.5946,0,NULL,'test','test',?)").run('eval-base-' + provider.id, provider.id, 'Test base', now);
    for (const zone of JSON.parse(provider.zones_json)) world.sqlite.prepare("INSERT OR REPLACE INTO scheduling_availability (id,provider_id,city_id,zone_id,date,windows_json,source,updated_at) VALUES (?,?,?,?,?,'[\"09:00-19:00\"]','roster',?)").run(provider.id + ':' + zone + ':2026-10-20', provider.id, provider.city_id, zone, '2026-10-20', now);
  }
  const history = [], countBookings = () => world.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='canonical_bookings'").get() ? world.sqlite.prepare('SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id=?').get(customerId).n : 0;
  async function turn(message) {
    const started = Date.now();
    const result = await runElevenLabsGroundedTurn(world.db, { model: scenario.startsWith('all-') ? 'pawspace-service-sales' : 'pawspace-grooming-sales', input: [...history, { role: 'user', content: message }], elevenlabs_extra_body: { pawspace_customer_id: customerId, pawspace_thread_id: threadId } });
    turns.push({ customer: message, maya: result.output, elapsedMs: Date.now() - started, path: result.path });
    history.push({ role: 'user', content: message }, { role: 'assistant', content: result.output });
    return result;
  }
  if (scenario === 'all-bookings') {
    const cases = [
      {service:'grooming',package:'Complete Makeover',date:20,end:'12 PM',mode:'prepaid'},
      {service:'dog_training',package:'Meet & Greet',date:21,end:'11 AM',mode:'prepaid'},
      {service:'boarding',package:'Standard Stay',date:22,end:'2 PM',mode:'prepaid'},
      {service:'pet_sitting',package:'Home Visit',date:23,end:'11 AM',mode:'prepaid'},
      {service:'dog_walking',package:'30-minute Solo Walk',date:24,end:'10:30 AM',mode:'pay_after_service'},
    ];
    for (const item of cases) {
      const before=countBookings(),beforePayment=paymentRequests;
      await turn(`Please prepare an unconfirmed quote for ${item.service}, ${item.package}, for my saved dog Milo, ${item.mode}, October ${item.date} 2026 from 10 AM to ${item.end} India time, at 12 Test Street, Bengaluru, PIN 560038. This is one appointment. Do not reserve or create a booking or payment order yet. Read back the quote and ask for my separate confirmation.`);
      const offer=await sales.pendingVoiceSalesOffer(world.db,threadId,customerId,'all_services');
      assert.ok(offer,`No stored offer for ${item.service}`);
      assert.equal(offer.service_code,item.service);
      assert.equal(countBookings(),before);
      assert.equal(paymentRequests,beforePayment);
      await turn('Yes, please.');
      assert.equal(countBookings(),before+1,`Exactly one ${item.service} booking after confirmation`);
      assert.equal(paymentRequests,beforePayment+(item.service==='dog_walking'?0:1));
      const result=JSON.parse(world.sqlite.prepare('SELECT result_json FROM voice_sales_offers WHERE id=?').get(offer.id).result_json);
      assert.ok(result.bookingId);assert.equal(result.paymentVerified,false);
      assert.equal(world.sqlite.prepare('SELECT service_code FROM canonical_bookings WHERE id=?').get(result.bookingId).service_code,item.service);
    }
    const report={passed:true,scenario,dialed:false,liveDatabaseAccess:false,model,modelCalls,mockedPaymentRequests:paymentRequests,bookingCount:countBookings(),premiumCertified:false,scope:'Actual model and canonical service booking implementations in an isolated in-memory fixture. Payment provider mocked; no hosted booking, payment capture, handset or delivery proof.',turns};
    await mkdir('artifacts/maya-runtime-sale',{recursive:true});await writeFile('artifacts/maya-runtime-sale/report.json',JSON.stringify(report,null,2));console.log('MAYA_ALL_SERVICE_BOOKINGS='+JSON.stringify(report));
  } else if (scenario === 'concierge' || scenario === 'all-services') {
    const checks = [
      { message: 'I need boarding for Milo for two nights. What do you need from me?', required: /boarding|stay|host/i, forbidden: /how many nights|grooming/i, maxWords: 70 },
      { message: 'Milo needs a complete body bath and full-body trim. Which one-time grooming package fits that and why?', required: /Complete Makeover/i },
      { message: 'I work long office hours and Milo misses his daily outdoor exercise. What would help with that?', required: /walk/i },
      { message: 'No extra services please, I only want grooming.', forbidden: /you should (?:also )?book|would you like.*walk|recommend.*walk/i },
      { message: 'The Complete Makeover price feels high. Is there an approved offer for that package?', required: /offer|discount|sav(?:e|ing)|200/i, forbidden: /GROOM200|GROOM400/ },
      { message: 'Milo has mild itching but is otherwise behaving normally. What general information can you share?', required: /vet(?:erinarian)?/i, forbidden: /\bGROOM\d+\b|coupon|discount|book.*groom|\b(?:mg|milligrams?|dose)\b/i, maxWords: 80 }
    ];
    if (scenario === 'all-services') checks.push(
      { message: 'For a different enquiry: what does your dog training service help with?', required: /train|behavio|cues/i },
      { message: 'What is the difference between pet sitting at my home and boarding at a host home?', required: /sitt/i },
      { message: 'I need care just during the daytime, not overnight. Do you offer daycare?', required: /daycare|daytime|day care/i },
      { message: 'How does your pet taxi service work, and what pickup information would you need?', required: /pickup|pick.up|transport|taxi/i },
      { message: 'I am moving to another city with my cat. How can your relocation team help?', required: /relocation|mov|travel/i },
      { message: 'What fresh pet food options can your team help me explore?', required: /food|meal|diet/i },
      { message: 'My pet has passed away. What funeral or memorial support does PawSpace provide?', required: /sorry|condolence|loss/i, forbidden: /discount|coupon|grooming|cross.sell/i },
      { message: 'Please explain how I can arrange a routine veterinary consultation, without booking anything yet.', required: /vet|consultation/i }
    );
    for (const check of checks) {
      const reply = await turn(check.message);
      if (check.required) assert.match(reply.output, check.required, check.message);
      if (check.forbidden) assert.doesNotMatch(reply.output, check.forbidden, check.message);
      if (check.maxWords) assert.ok(reply.output.trim().split(/\s+/u).length <= check.maxWords, 'Spoken answer exceeded the scenario pacing limit: ' + check.message);
      assert.equal(countBookings(), 0, 'Concierge enquiries cannot create a booking');
      assert.equal(paymentRequests, 0, 'Concierge enquiries cannot create a payment order');
    }
    const report = { passed: true, scenario, dialed: false, liveDatabaseAccess: false, model, modelCalls, mockedPaymentRequests: paymentRequests, bookingCount: countBookings(), premiumCertified: false, modelDrafts, scope: 'Actual model and PawSpace concierge runtime with the repository knowledge pack in an in-memory fixture; pattern smoke checks require manual review, no live CRM, TTS or handset certification', turns };
    await mkdir('artifacts/maya-runtime-sale', { recursive: true });
    await writeFile('artifacts/maya-runtime-sale/report.json', JSON.stringify(report, null, 2));
    console.log('MAYA_RUNTIME_CONCIERGE=' + JSON.stringify({ ...report, modelDrafts: undefined }));
  } else {
  const recommendation = await turn('Milo needs a complete body bath and full-body trim. Which one-time grooming package fits that and why?');
  assert.match(recommendation.output, /Complete Makeover/i, 'The actual runtime must recommend the package matching the stated need');
  assert.equal(countBookings(), 0);
  await turn('Please prepare an unconfirmed quote for the one-time Complete Makeover for Milo, prepaid, October 20 2026 at 10 AM India time, at 12 Test Street, Bengaluru, PIN 560038. Do not reserve or create a booking or payment order. Read the quote and ask for my separate confirmation.');
  const offer = await sales.pendingVoiceSalesOffer(world.db, threadId, customerId, 'grooming');
  assert.ok(offer, 'The actual model must propose a valid governed quote after all supplied details');
  assert.equal(countBookings(), 0, 'Quoting must not create a booking');
  assert.equal(paymentRequests, 0, 'Quoting must not create a payment order');
  const beforeConfirmation = modelCalls;
  const confirmed = await turn('Yeah, please.');
  assert.equal(modelCalls, beforeConfirmation, 'Confirmation must not wait for another model generation');
  assert.equal(countBookings(), 1);
  assert.equal(paymentRequests, 1);
  assert.match(confirmed.output, /booking.*created|created.*booking/i);
  assert.equal(world.sqlite.prepare('SELECT status FROM canonical_bookings WHERE customer_id=?').get(customerId).status, 'payment_pending');
  assert.notEqual(world.sqlite.prepare('SELECT status FROM booking_payments WHERE customer_id=?').get(customerId).status, 'captured');
  const replay = await sales.confirmVoiceSalesOffer(world.db, { actor, threadId, customerId, service: 'grooming', offerId: offer.id, confirmation: 'Yeah, please.' });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(countBookings(), 1); assert.equal(paymentRequests, 1);
  const report = { passed: true, dialed: false, liveDatabaseAccess: false, model, modelCalls, mockedPaymentRequests: paymentRequests, bookingCount: countBookings(), paymentVerified: false, duplicatePrevented: true, premiumCertified: false, modelDrafts, scope: 'Real model plus actual PawSpace runtime against in-memory fixtures; no live booking, payment capture, TTS, delivered checkout or handset certification', turns };
  await mkdir('artifacts/maya-runtime-sale', { recursive: true });
  await writeFile('artifacts/maya-runtime-sale/report.json', JSON.stringify(report, null, 2));
  console.log('MAYA_RUNTIME_SALE=' + JSON.stringify({ ...report, modelDrafts: undefined }));
  }
} catch (error) {
  await mkdir('artifacts/maya-runtime-sale', { recursive: true });
  await writeFile('artifacts/maya-runtime-sale/report.json', JSON.stringify({ passed: false, dialed: false, liveDatabaseAccess: false, premiumCertified: false, error: error.message, modelCalls, paymentRequests, turns, modelDrafts, fixtureErrors, turnDiagnostics: world.sqlite.prepare('SELECT outcome,policy_decision,handoff_reason,intent_code,intent_confidence,provider FROM ai_conversation_turns').all() }, null, 2));
  throw error;
} finally { world.close(); globalThis.fetch = realFetch; }
