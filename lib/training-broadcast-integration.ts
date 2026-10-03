import {repository, activeRules, parallelAppointmentsFor} from '../app/api/uat-scheduling/route';
import {schedule, buildOccurrences, type ScheduleRequest} from '../backend/src/scheduling';
import {trainingBroadcastAudience} from './training-broadcast-audience';
import {claimTrainingBroadcastOffer, ensureTrainingBroadcastTables} from './training-broadcast-claim';
import {dispatchSnapshots, ensureTrainingDispatchTables} from './training-assignment-dispatch';
import {getProviderAcceptanceTimeout} from './provider-capacity-governance';
import {resolveAssignmentPolicy} from './provider-assignment-policy';
import {trainingPaymentPredicate} from './training-payment-eligibility';
import {ensureProviderLifecycleTables, providerLifecycleAssertionStatement, runAtomicProviderLifecycleTransition} from './provider-lifecycle';
import {ensureTrainingWorkflowNotificationTables, trainingWorkflowNotificationStatements} from './training-workflow-notifications';
import {ensureTrainingSessionLifecycleTables} from './training-session-lifecycle';

type Row = Record<string, unknown>;
type RequestInput = Parameters<typeof repository>[1];
const txt = (value: unknown) => String(value ?? '');
const parse = <T>(value: unknown): T => JSON.parse(txt(value));
const conflict = (message: string) => new Response(message, {status: 409});
export const trainingBroadcastOwner = (bookingId: string) => `training-broadcast:${bookingId}`;

async function evaluate(db: D1Database, booking: Row, request: RequestInput) {
  // A provisional hold belongs to the booking, not to the prospective winner's workload.
  // Governance initialization can write defaults. Discard those reads, then bracket fresh evaluation.
  await repository(db, request).listEligibleProviders(txt(booking.city_id), txt(booking.zone_id), 'dog_training');
  const snapshots = await dispatchSnapshots(db, {...request, cityId: txt(booking.city_id), zoneId: txt(booking.zone_id)});
  const repo = repository(db, request), listBookings = repo.listBookings.bind(repo);
  const providers = await repo.listEligibleProviders(txt(booking.city_id), txt(booking.zone_id), 'dog_training');
  const decision = await schedule({...repo, listEligibleProviders: async () => providers,
    listBookings: async (cityId: string, providerId?: string) => (await listBookings(cityId, providerId)).filter(item => item.scheduleGroupId !== booking.schedule_group_id)},
    {...request, cityId: txt(booking.city_id), zoneId: txt(booking.zone_id), serviceCode: 'dog_training',
      // Contractor recipients are always an automatic audience. Explicit historical selection is untouched.
      preferredProviderId: undefined, preferredProviderMode: 'disabled',
      customRules: await activeRules(db, request), parallelAppointments: await parallelAppointmentsFor(request)} as ScheduleRequest);
  return {providers, snapshots, decision, audience: trainingBroadcastAudience(decision, providers)};
}

function assertions(db: D1Database, snapshots: Awaited<ReturnType<typeof dispatchSnapshots>>, token: string) {
  return snapshots.map((snapshot, i) => db.prepare(`INSERT INTO training_broadcast_assertions(id,ok) SELECT ?,CASE WHEN CAST((${snapshot.sql}) AS TEXT)=? THEN 1 ELSE 0 END`).bind(`${token}:source:${i}`, ...snapshot.binds, snapshot.value));
}

function operationsStatements(db: D1Database, booking: Row, sessionId: string, reason: string, now: number) {
  return [
    db.prepare("UPDATE training_assignment_chains SET state='needs_operations',revision=revision+1 WHERE booking_id=? AND state='broadcast_pending'").bind(booking.id),
    db.prepare("INSERT INTO training_assignment_ops_cases(booking_id,reason,due_at,created_at) VALUES (?,?,?,?) ON CONFLICT(booking_id) DO UPDATE SET status='open',reason=excluded.reason,due_at=excluded.due_at").bind(booking.id, reason, now, now),
    db.prepare("INSERT INTO training_session_recovery_cases(id,session_id,programme_id,booking_id,recovery_type,status,reason,requested_by,detail_json,created_at,updated_at) SELECT ?,s.id,s.programme_id,s.booking_id,'assignment_recovery','open',?,'system:training-broadcast','{}',?,? FROM training_sessions s WHERE s.id=? ON CONFLICT(id) DO UPDATE SET status='open',reason=excluded.reason,updated_at=excluded.updated_at").bind(`training-broadcast-ops:${booking.id}`, reason, now, now, sessionId),
  ];
}

/** Prepared with programme/session creation; no offers can exist without their canonical first session. */
export async function prepareTrainingBroadcast(db: D1Database, booking: Row, sessionId: string) {
  const stored = await db.prepare('SELECT shortlist_json FROM scheduling_assignment_decisions WHERE group_id=?').bind(booking.schedule_group_id).first<Row>().catch((error: unknown) => {
    if (/no such table: scheduling_assignment_decisions/i.test(error instanceof Error ? error.message : txt(error))) return null;
    throw error;
  });
  if (!stored) return null;
  const payload = parse<{request: RequestInput; trainingDispatchVersion?: number; trainingProviderModel?: string}>(stored.shortlist_json);
  if (payload.trainingDispatchVersion !== 1) return null;
  if (payload.trainingProviderModel === 'full_time') return null;
  await ensureTrainingDispatchTables(db); await ensureTrainingBroadcastTables(db);
  const evaluated = await evaluate(db, booking, payload.request);
  // Availability can change between reservation and programme creation. Prefer newly eligible staff.
  if (evaluated.audience.mode === 'full_time') {
    const provider = evaluated.providers.find(item => item.id === evaluated.audience.providerId)!;
    const token = crypto.randomUUID(), now = Date.now(), owner = provider.id;
    return {owner, statements: [
      ...assertions(db, evaluated.snapshots, token),
      db.prepare("INSERT INTO training_broadcast_assertions(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM canonical_bookings WHERE id=? AND provider_id=? AND status NOT IN ('cancelled','canceled','refunded','failed','expired','completed')) AND EXISTS(SELECT 1 FROM provider_work_orders WHERE booking_id=? AND provider_id=?) THEN 1 ELSE 0 END").bind(`${token}:booking`,booking.id,booking.provider_id,booking.id,booking.provider_id),
      db.prepare("UPDATE canonical_bookings SET provider_id=?,updated_at=? WHERE id=? AND provider_id=?").bind(owner,now,booking.id,booking.provider_id),
      db.prepare("UPDATE provider_work_orders SET provider_id=?,provider_name=?,provider_model='full_time',status='assigned',updated_at=? WHERE booking_id=? AND provider_id=?").bind(owner,provider.name,now,booking.id,booking.provider_id),
      db.prepare("UPDATE scheduling_reservations SET provider_id=? WHERE group_id=? AND provider_id=? AND status='assigned'").bind(owner,booking.schedule_group_id,booking.provider_id),
      db.prepare("UPDATE scheduling_assignment_decisions SET selected_provider_id=?,updated_at=?,reason='Training full-time automatic assignment' WHERE group_id=?").bind(owner,now,booking.schedule_group_id),
      db.prepare("UPDATE provider_assignment_offers SET provider_id=?,status='accepted',responded_at=?,response_reason='Training full-time automatic assignment',updated_at=? WHERE group_id=?").bind(owner,now,now,booking.schedule_group_id),
      db.prepare("INSERT INTO training_broadcast_assertions(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM canonical_bookings WHERE id=? AND provider_id=?) AND EXISTS(SELECT 1 FROM provider_work_orders WHERE booking_id=? AND provider_id=? AND provider_model='full_time' AND status='assigned') AND EXISTS(SELECT 1 FROM training_programmes WHERE booking_id=? AND provider_id=?) AND EXISTS(SELECT 1 FROM training_sessions WHERE id=? AND provider_id=?) AND EXISTS(SELECT 1 FROM scheduling_reservations WHERE group_id=? AND provider_id=?) AND NOT EXISTS(SELECT 1 FROM scheduling_reservations WHERE group_id=? AND (provider_id!=? OR status!='assigned')) AND EXISTS(SELECT 1 FROM scheduling_assignment_decisions WHERE group_id=? AND selected_provider_id=?) AND EXISTS(SELECT 1 FROM provider_assignment_offers WHERE group_id=? AND provider_id=? AND status='accepted') THEN 1 ELSE 0 END").bind(`${token}:owners`,booking.id,owner,booking.id,owner,booking.id,owner,sessionId,owner,booking.schedule_group_id,owner,booking.schedule_group_id,owner,booking.schedule_group_id,owner,booking.schedule_group_id,owner),
      db.prepare("DELETE FROM training_broadcast_assertions WHERE id LIKE ?").bind(`${token}:%`),
    ]};
  }
  const policy = await resolveAssignmentPolicy(db, 'dog_training', txt(booking.city_id), new Date(txt(booking.scheduled_start)), {readOnly: true});
  const original = await db.prepare('SELECT offered_at,expires_at FROM provider_assignment_offers WHERE group_id=?').bind(booking.schedule_group_id).first<Row>();
  const now = Date.now(), started = Number(original?.offered_at ?? now), due = started + policy.config.opsEscalationMinutes * 60000;
  const ids = evaluated.audience.mode === 'broadcast' ? evaluated.audience.contractorIds : [];
  const ttl = await Promise.all(ids.map(id => getProviderAcceptanceTimeout(db, id)));
  const expiry = Math.min(due, Number(original?.expires_at ?? due), ...ttl.map(minutes => started + minutes * 60000));
  const valid = ids.length > 0 && ttl.every(minutes => Number.isFinite(minutes) && minutes > 0) && expiry > now;
  const token = crypto.randomUUID(), owner = trainingBroadcastOwner(txt(booking.id));
  const statements = [
    ...assertions(db, evaluated.snapshots, token),
    db.prepare("INSERT INTO training_broadcast_assertions(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM canonical_bookings WHERE id=? AND provider_id=? AND schedule_group_id=? AND status NOT IN ('cancelled','canceled','refunded','failed','expired','completed')) AND EXISTS(SELECT 1 FROM provider_work_orders WHERE booking_id=? AND provider_id=?) THEN 1 ELSE 0 END").bind(`${token}:booking`,booking.id,booking.provider_id,booking.schedule_group_id,booking.id,booking.provider_id),
    db.prepare("INSERT INTO training_assignment_chains(booking_id,group_id,first_session_id,started_at,ops_due_at,max_attempts,policy_json,request_json,state) VALUES (?,?,?,?,?,?,?,?,'broadcast_pending')").bind(booking.id, booking.schedule_group_id, sessionId, started, due, Math.max(1, policy.config.fallbackAttempts), JSON.stringify(policy.config), JSON.stringify(payload.request)),
    // Stop the legacy scheduler offer from granting one provisional contractor special authority.
    db.prepare("UPDATE provider_assignment_offers SET status='withdrawn',responded_at=?,response_reason='Replaced by Training broadcast',updated_at=? WHERE group_id=? AND status='pending'").bind(now, now, booking.schedule_group_id),
    ...(valid ? ids.map(providerId => db.prepare("INSERT INTO training_broadcast_offers(booking_id,provider_id,session_id,status,offered_at,expires_at,source_snapshot_json) VALUES (?,?,?,'pending',?,?,?)").bind(booking.id, providerId, sessionId, started, expiry, JSON.stringify(evaluated.decision.evaluations))) : operationsStatements(db, booking, sessionId, ids.length ? 'broadcast_deadline_elapsed' : 'no_eligible_contractor',now)),
    db.prepare("UPDATE canonical_bookings SET provider_id=?,updated_at=? WHERE id=? AND provider_id=?").bind(owner,now,booking.id,booking.provider_id),
    db.prepare("UPDATE provider_work_orders SET provider_id=?,provider_name='PawSpace certified trainer',updated_at=? WHERE booking_id=? AND provider_id=?").bind(owner,now,booking.id,booking.provider_id),
    db.prepare("UPDATE scheduling_reservations SET provider_id=? WHERE group_id=? AND provider_id=? AND status='assigned'").bind(owner,booking.schedule_group_id,booking.provider_id),
    db.prepare("UPDATE scheduling_assignment_decisions SET selected_provider_id=?,updated_at=? WHERE group_id=?").bind(owner,now,booking.schedule_group_id),
    db.prepare("INSERT INTO training_broadcast_assertions(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM canonical_bookings WHERE id=? AND provider_id=?) AND EXISTS(SELECT 1 FROM provider_work_orders WHERE booking_id=? AND provider_id=?) AND EXISTS(SELECT 1 FROM training_programmes WHERE booking_id=? AND provider_id=?) AND EXISTS(SELECT 1 FROM training_sessions WHERE id=? AND provider_id=?) AND NOT EXISTS(SELECT 1 FROM scheduling_reservations WHERE group_id=? AND provider_id!=?) THEN 1 ELSE 0 END").bind(`${token}:owners`,booking.id,owner,booking.id,owner,booking.id,owner,sessionId,owner,booking.schedule_group_id,owner),
    db.prepare("DELETE FROM training_broadcast_assertions WHERE id LIKE ?").bind(`${token}:%`),
  ];
  return {owner, statements};
}

async function broadcastExists(db: D1Database) {
  return Boolean(await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='training_broadcast_offers'").first());
}

/** Redacted inbox: no customer/pet identity, address, notes, proof or another recipient is exposed. */
export async function listTrainingBroadcastOffers(db: D1Database, providerId: string) {
  if (!await broadcastExists(db)) return [];
  const rows = await db.prepare("SELECT o.booking_id bookingId,o.session_id sessionId,o.provider_id providerId,o.expires_at expiresAt,b.package_name packageName,b.zone_id zoneId,s.scheduled_start scheduledStart,s.scheduled_end scheduledEnd FROM training_broadcast_offers o JOIN canonical_bookings b ON b.id=o.booking_id JOIN training_sessions s ON s.id=o.session_id JOIN training_assignment_chains c ON c.booking_id=b.id WHERE o.provider_id=? AND o.status='pending' AND o.expires_at>? AND c.state='broadcast_pending' AND b.status NOT IN ('cancelled','canceled','refunded','failed','expired','completed') ORDER BY o.offered_at LIMIT 200").bind(providerId, Date.now()).all<Row>();
  return rows.results;
}

export async function trainingBroadcastOffer(db: D1Database, bookingId: string, providerId: string) {
  if (!await broadcastExists(db)) return undefined;
  const chain = await db.prepare('SELECT state FROM training_assignment_chains WHERE booking_id=?').bind(bookingId).first<Row>();
  if (!chain || !['broadcast_pending', 'broadcast_accepted', 'needs_operations'].includes(txt(chain.state))) return undefined;
  const offer = await db.prepare('SELECT status,session_id,expires_at FROM training_broadcast_offers WHERE booking_id=? AND provider_id=?').bind(bookingId, providerId).first<Row>();
  if (!offer) throw new Response('Training broadcast recipient access denied', {status: 403});
  return {state: offer.status === 'pending' ? Number(offer.expires_at) <= Date.now() ? 'expired' : 'open' : offer.status,
    providerId, sessionId: txt(offer.session_id), expiresAt: Number(offer.expires_at), canDecline: offer.status === 'pending' && Number(offer.expires_at) > Date.now(), broadcast: true, externalDelivery: false};
}

export async function acceptTrainingBroadcast(db: D1Database, input: {bookingId: string; sessionId: string; providerId: string; idempotencyKey: string; actorId: string}) {
  await ensureTrainingBroadcastTables(db); await ensureTrainingDispatchTables(db); await ensureTrainingSessionLifecycleTables(db); await ensureProviderLifecycleTables(db); await ensureTrainingWorkflowNotificationTables(db);
  const offer = await db.prepare('SELECT 1 FROM training_broadcast_offers WHERE booking_id=? AND provider_id=? AND session_id=?').bind(input.bookingId, input.providerId, input.sessionId).first();
  if (!offer) throw new Response('Training broadcast recipient access denied', {status: 403});
  const claimed = await db.prepare('SELECT provider_id,session_id,idempotency_key FROM training_broadcast_claims WHERE booking_id=?').bind(input.bookingId).first<Row>();
  if (claimed) {
    if (claimed.provider_id === input.providerId && claimed.session_id === input.sessionId && claimed.idempotency_key === input.idempotencyKey) return {status: 'accepted', providerId: input.providerId, duplicatePrevented: true};
    throw conflict('Training offer already accepted by another claim');
  }
  if(await db.prepare('SELECT 1 FROM training_assignment_responses WHERE idempotency_key=?').bind(input.idempotencyKey).first())throw conflict('This Training key was used for a different response');
  const booking = await db.prepare("SELECT b.*,c.request_json,c.revision,c.first_session_id,c.state chain_state FROM canonical_bookings b JOIN training_assignment_chains c ON c.booking_id=b.id WHERE b.id=? AND b.service_code='dog_training'").bind(input.bookingId).first<Row>();
  if (!booking || booking.chain_state !== 'broadcast_pending' || booking.first_session_id !== input.sessionId) throw conflict('Training assignment changed; refresh offers');
  const request=parse<RequestInput>(booking.request_json),occurrences=buildOccurrences({...request,cityId:txt(booking.city_id),zoneId:txt(booking.zone_id)});
  const windows=await db.prepare("SELECT r.scheduled_start,r.scheduled_end,r.occurrence_number,s.scheduled_start session_start,s.scheduled_end session_end FROM scheduling_reservations r JOIN training_sessions s ON s.schedule_reservation_id=r.id AND s.booking_id=? WHERE r.group_id=? ORDER BY r.occurrence_number").bind(booking.id,booking.schedule_group_id).all<Row>();
  if(windows.results.length!==occurrences.length||windows.results.some((row,i)=>Date.parse(txt(row.scheduled_start))!==Date.parse(occurrences[i].start)||Date.parse(txt(row.scheduled_end))!==Date.parse(occurrences[i].end)||row.session_start!==row.scheduled_start||row.session_end!==row.scheduled_end))throw conflict('Training offer windows changed; Operations must reconcile the assignment');
  const evaluated = await evaluate(db, booking, request);
  const provider = evaluated.providers.find(item => item.id === input.providerId);
  if (!provider || provider.model !== 'commission' || !evaluated.decision.evaluations.some(item => item.providerId === provider.id && item.eligible)) throw conflict('Trainer is no longer eligible or available for this offer');
  const fullyPaid = booking.package_code === 'trainer-meet-greet', payment = await trainingPaymentPredicate(db, input.bookingId, fullyPaid);
  const owner = trainingBroadcastOwner(input.bookingId), now = Date.now(), token = crypto.randomUUID();
  const initialSql = "EXISTS(SELECT 1 FROM canonical_bookings WHERE id=? AND service_code='dog_training' AND provider_id=? AND schedule_group_id=? AND status NOT IN ('cancelled','canceled','refunded','failed','expired','completed')) AND EXISTS(SELECT 1 FROM training_assignment_chains WHERE booking_id=? AND revision=? AND state='broadcast_pending' AND first_session_id=? AND ops_due_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) AND EXISTS(SELECT 1 FROM training_sessions WHERE id=? AND booking_id=? AND provider_id=? AND status='scheduled') AND NOT EXISTS(SELECT 1 FROM training_sessions WHERE booking_id=? AND (provider_id!=? OR status NOT IN ('scheduled','locked'))) AND EXISTS(SELECT 1 FROM scheduling_reservations WHERE group_id=? AND status!='cancelled') AND NOT EXISTS(SELECT 1 FROM scheduling_reservations WHERE group_id=? AND (provider_id!=? OR status!='assigned')) AND EXISTS(SELECT 1 FROM provider_work_orders WHERE booking_id=? AND provider_id=? AND status='awaiting_acceptance') AND EXISTS(SELECT 1 FROM training_programmes WHERE booking_id=? AND provider_id=? AND status='scheduled')";
  const initialBinds = [booking.id, booking.provider_id, booking.schedule_group_id, booking.id, booking.revision, input.sessionId, input.sessionId, booking.id, owner, booking.id, owner, booking.schedule_group_id, booking.schedule_group_id, booking.provider_id, booking.id, booking.provider_id, booking.id, owner];
  const exactSql="EXISTS(SELECT 1 FROM training_sessions WHERE id=? AND scheduled_start=? AND scheduled_end=?) AND NOT EXISTS(SELECT 1 FROM training_sessions s LEFT JOIN scheduling_reservations r ON r.id=s.schedule_reservation_id WHERE s.booking_id=? AND (r.id IS NULL OR r.group_id!=? OR s.scheduled_start!=r.scheduled_start OR s.scheduled_end!=r.scheduled_end)) AND EXISTS(SELECT 1 FROM training_commercial_quotes q JOIN training_booking_quote_links l ON l.quote_id=q.id JOIN canonical_bookings b ON b.id=l.booking_id WHERE b.id=? AND q.status='used' AND q.used_booking_id=b.id AND q.package_code=b.package_code AND q.total_amount=b.total_amount) AND EXISTS(SELECT 1 FROM canonical_bookings WHERE id=? AND customer_id=? AND city_id=? AND zone_id=? AND pricing_json=? AND scheduled_start=? AND scheduled_end=?)";
  const exactBinds=[input.sessionId,occurrences[0].start,occurrences[0].end,booking.id,booking.schedule_group_id,booking.id,booking.id,booking.customer_id,booking.city_id,booking.zone_id,booking.pricing_json,booking.scheduled_start,booking.scheduled_end];
  const finalSql = "EXISTS(SELECT 1 FROM canonical_bookings WHERE id=? AND provider_id=?) AND EXISTS(SELECT 1 FROM training_sessions WHERE id=? AND provider_id=? AND status='accepted') AND NOT EXISTS(SELECT 1 FROM training_sessions WHERE booking_id=? AND provider_id!=?) AND NOT EXISTS(SELECT 1 FROM scheduling_reservations WHERE group_id=? AND (provider_id!=? OR status!='assigned')) AND EXISTS(SELECT 1 FROM scheduling_reservations WHERE group_id=?) AND EXISTS(SELECT 1 FROM training_programmes WHERE booking_id=? AND provider_id=?) AND EXISTS(SELECT 1 FROM provider_work_orders WHERE booking_id=? AND provider_id=? AND status='assigned') AND EXISTS(SELECT 1 FROM scheduling_assignment_decisions WHERE group_id=? AND selected_provider_id=? AND status='assigned') AND EXISTS(SELECT 1 FROM provider_assignment_offers WHERE group_id=? AND provider_id=? AND status='accepted') AND EXISTS(SELECT 1 FROM training_assignment_chains WHERE booking_id=? AND state='broadcast_accepted') AND EXISTS(SELECT 1 FROM training_session_events WHERE session_id=? AND idempotency_key=? AND event_type='accept')";
  const finalBinds = [booking.id, provider.id, input.sessionId, provider.id, booking.id, provider.id, booking.schedule_group_id, provider.id, booking.schedule_group_id, booking.id, provider.id, booking.id, provider.id, booking.schedule_group_id, provider.id, booking.schedule_group_id, provider.id, booking.id, input.sessionId, input.idempotencyKey];
  const result = await claimTrainingBroadcastOffer(db, {...input, now,
    effectPredicate: () => ({sql: finalSql, binds: finalBinds}),
    effectStatements: (guard, guardBinds) => [
      ...assertions(db, evaluated.snapshots, token),
      db.prepare(`INSERT INTO training_broadcast_assertions(id,ok) SELECT ?,CASE WHEN (${initialSql}) AND (${exactSql}) AND (${payment.sql}) THEN 1 ELSE 0 END`).bind(`${token}:canonical`, ...initialBinds,...exactBinds, ...payment.binds),
      db.prepare(`UPDATE scheduling_reservations SET provider_id=? WHERE group_id=? AND provider_id=? AND status='assigned' AND ${guard}`).bind(provider.id, booking.schedule_group_id, booking.provider_id, ...guardBinds),
      db.prepare(`UPDATE canonical_bookings SET provider_id=?,updated_at=? WHERE id=? AND provider_id=? AND ${guard}`).bind(provider.id, now, booking.id, booking.provider_id, ...guardBinds),
      db.prepare(`UPDATE provider_work_orders SET provider_id=?,provider_name=?,provider_model='commission',status='assigned',updated_at=? WHERE booking_id=? AND provider_id=? AND ${guard}`).bind(provider.id, provider.name, now, booking.id, booking.provider_id, ...guardBinds),
      db.prepare(`UPDATE training_programmes SET provider_id=?,updated_at=? WHERE booking_id=? AND provider_id=? AND ${guard}`).bind(provider.id, now, booking.id, owner, ...guardBinds),
      db.prepare(`UPDATE training_sessions SET provider_id=?,status=CASE WHEN id=? THEN 'accepted' ELSE status END,updated_at=? WHERE booking_id=? AND provider_id=? AND ${guard}`).bind(provider.id, input.sessionId, now, booking.id, owner, ...guardBinds),
      db.prepare(`UPDATE scheduling_assignment_decisions SET selected_provider_id=?,status='assigned',reason='Training broadcast winner',actor_id=?,updated_at=? WHERE group_id=? AND ${guard}`).bind(provider.id, input.actorId, now, booking.schedule_group_id, ...guardBinds),
      db.prepare(`UPDATE provider_assignment_offers SET provider_id=?,status='accepted',responded_at=?,response_reason='Training broadcast winner',updated_at=? WHERE group_id=? AND ${guard}`).bind(provider.id, now, now, booking.schedule_group_id, ...guardBinds),
      db.prepare(`UPDATE training_assignment_chains SET state='broadcast_accepted',revision=revision+1 WHERE booking_id=? AND state='broadcast_pending' AND ${guard}`).bind(booking.id, ...guardBinds),
      db.prepare(`INSERT INTO training_session_events(id,session_id,programme_id,booking_id,event_type,actor_id,idempotency_key,detail_json,created_at) SELECT ?,s.id,s.programme_id,s.booking_id,'accept',?,?,?,? FROM training_sessions s WHERE s.id=? AND ${guard}`).bind(crypto.randomUUID(), input.actorId, input.idempotencyKey, JSON.stringify({from: 'scheduled', to: 'accepted', providerId: provider.id, broadcast: true}), now, input.sessionId, ...guardBinds),
      db.prepare('INSERT INTO training_assignment_responses(idempotency_key,fingerprint,result_json,actor_id,created_at) VALUES (?,?,?,?,?)').bind(input.idempotencyKey,JSON.stringify([input.bookingId,input.sessionId,input.providerId,'accept']),JSON.stringify({status:'accepted',providerId:provider.id}),input.actorId,now),
      ...trainingWorkflowNotificationStatements(db, {key: input.idempotencyKey, bookingId: input.bookingId, customerId: txt(booking.customer_id), providerId: provider.id, sessionId: input.sessionId, event: 'provider_replaced', sourceId: input.sessionId, actorId: input.actorId, now}),
      db.prepare("DELETE FROM training_broadcast_assertions WHERE id LIKE ?").bind(`${token}:%`),
    ],
    // Claim/effects/loser closure/assertions AND canonical lifecycle finalization share one batch.
    commitStatements: statements => runAtomicProviderLifecycleTransition(db, {bookingId: input.bookingId, serviceCode: 'dog_training', scopeId: `session:${input.sessionId}`, providerId: owner, nextProviderId: provider.id, from: 'provider_matched', path: ['accepted'], legacySeedStatus: 'provider_matched', actorId: input.actorId, detail: {broadcast: true, sessionId: input.sessionId}, buildStatements: () => statements,
      buildAssertion: ctx => providerLifecycleAssertionStatement(db, ctx, `(${finalSql}) AND (${payment.sql})`, [...finalBinds, ...payment.binds])}),
  });
  return {status: 'accepted', providerId: provider.id, duplicatePrevented: result.duplicatePrevented};
}

export async function respondTrainingBroadcast(db: D1Database, input: {bookingId: string;sessionId: string;providerId: string;action: 'decline'|'timeout';idempotencyKey: string;reason: string;actorId: string}) {
  await ensureTrainingDispatchTables(db); await ensureTrainingBroadcastTables(db);
  const fingerprint = JSON.stringify([input.bookingId, input.sessionId, input.providerId, input.action, input.reason]);
  const prior = await db.prepare('SELECT fingerprint,result_json FROM training_assignment_responses WHERE idempotency_key=?').bind(input.idempotencyKey).first<Row>();
  if (prior) {if (prior.fingerprint !== fingerprint) throw conflict('Training response key was used for different input'); return {...parse<Row>(prior.result_json), duplicatePrevented: true};}
  if (input.reason.trim().length < 3) throw new Response('Training response reason required', {status: 400});
  const booking = await db.prepare('SELECT b.*,c.first_session_id FROM canonical_bookings b JOIN training_assignment_chains c ON c.booking_id=b.id WHERE b.id=?').bind(input.bookingId).first<Row>();
  if (!booking || booking.first_session_id !== input.sessionId) throw conflict('Training broadcast session changed');
  const offer = await db.prepare('SELECT status,expires_at FROM training_broadcast_offers WHERE booking_id=? AND provider_id=? AND session_id=?').bind(input.bookingId, input.providerId, input.sessionId).first<Row>();
  if (!offer) throw new Response('Training broadcast recipient access denied', {status: 403});
  const now = Date.now(), token = crypto.randomUUID(), clock = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)", deadline = input.action === 'decline' ? `expires_at>${clock}` : `expires_at<=${clock}`;
  const result = {bookingId: input.bookingId, status: input.action === 'decline' ? 'declined' : 'expired', duplicatePrevented: false, externalDelivery: false};
  // Each decline is local to its recipient. Exhaustion/expiry opens one Operations case, never a sequential offer.
  const noPending = "NOT EXISTS(SELECT 1 FROM training_broadcast_offers WHERE booking_id=? AND status='pending' AND expires_at>" + clock + ") AND NOT EXISTS(SELECT 1 FROM training_broadcast_claims WHERE booking_id=?)";
  const exhausted = db.prepare(`INSERT INTO training_broadcast_assertions(id,ok) SELECT ?,1 WHERE ${noPending}`).bind(`${token}:exhausted`, booking.id, booking.id);
  const opsGuard = `EXISTS(SELECT 1 FROM training_broadcast_assertions WHERE id='${token}:exhausted')`;
  try {await db.batch([
    db.prepare(`INSERT INTO training_broadcast_assertions(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM training_broadcast_offers WHERE booking_id=? AND provider_id=? AND session_id=? AND status='pending' AND ${deadline}) AND EXISTS(SELECT 1 FROM training_assignment_chains WHERE booking_id=? AND state='broadcast_pending') AND NOT EXISTS(SELECT 1 FROM training_broadcast_claims WHERE booking_id=?) THEN 1 ELSE 0 END`).bind(token, input.bookingId, input.providerId, input.sessionId, input.bookingId, input.bookingId),
    db.prepare("UPDATE training_broadcast_offers SET status=?,responded_at=? WHERE booking_id=? AND provider_id=? AND status='pending'").bind(result.status, now, input.bookingId, input.providerId),
    ...(input.action==='decline'?[db.prepare("UPDATE training_assignment_chains SET excluded_json=json_insert(excluded_json,'$[#]',?) WHERE booking_id=?").bind(input.providerId,booking.id)]:[]),
    exhausted,
    db.prepare(`UPDATE training_broadcast_offers SET status='expired',responded_at=? WHERE booking_id=? AND status='pending' AND ${opsGuard}`).bind(now, booking.id),
    db.prepare(`UPDATE training_assignment_chains SET state='needs_operations',revision=revision+1 WHERE booking_id=? AND state='broadcast_pending' AND ${opsGuard}`).bind(booking.id),
    db.prepare(`INSERT INTO training_assignment_ops_cases(booking_id,reason,due_at,created_at) SELECT ?,'broadcast_no_acceptance',?,? WHERE ${opsGuard} ON CONFLICT(booking_id) DO UPDATE SET status='open',reason=excluded.reason,due_at=excluded.due_at`).bind(booking.id, now, now),
    db.prepare(`INSERT INTO training_session_recovery_cases(id,session_id,programme_id,booking_id,recovery_type,status,reason,requested_by,detail_json,created_at,updated_at) SELECT ?,s.id,s.programme_id,s.booking_id,'assignment_recovery','open','broadcast_no_acceptance',?,'{}',?,? FROM training_sessions s WHERE s.id=? AND ${opsGuard} ON CONFLICT(id) DO UPDATE SET status='open',reason=excluded.reason,updated_at=excluded.updated_at`).bind(`training-broadcast-ops:${booking.id}`, input.actorId, now, now, input.sessionId),
    db.prepare('INSERT INTO training_assignment_responses(idempotency_key,fingerprint,result_json,actor_id,created_at) VALUES (?,?,?,?,?)').bind(input.idempotencyKey, fingerprint, JSON.stringify(result), input.actorId, now),
    db.prepare('DELETE FROM training_broadcast_assertions WHERE id=? OR id=?').bind(token, `${token}:exhausted`),
  ]);} catch (error) {
    const replay = await db.prepare('SELECT fingerprint,result_json FROM training_assignment_responses WHERE idempotency_key=?').bind(input.idempotencyKey).first<Row>();
    if (replay?.fingerprint === fingerprint) return {...parse<Row>(replay.result_json), duplicatePrevented: true};
    if (/constraint/i.test(error instanceof Error ? error.message : txt(error))) throw conflict('Training offer changed before response');
    throw error;
  }
  return result;
}

export async function expireTrainingBroadcasts(db: D1Database) {
  if (!await broadcastExists(db)) return [];
  const rows = await db.prepare("SELECT o.booking_id,o.session_id,o.provider_id,o.expires_at FROM training_broadcast_offers o JOIN training_assignment_chains c ON c.booking_id=o.booking_id WHERE o.status='pending' AND c.state='broadcast_pending' AND o.expires_at<=? ORDER BY o.expires_at LIMIT 20").bind(Date.now()).all<Row>();
  const results: unknown[] = [];
  for (const row of rows.results) {try {results.push(await respondTrainingBroadcast(db, {bookingId: txt(row.booking_id),sessionId: txt(row.session_id),providerId: txt(row.provider_id),action: 'timeout',reason: 'Training broadcast expired',idempotencyKey: `broadcast-expiry:${row.booking_id}:${row.provider_id}:${row.expires_at}`,actorId: 'system:training-broadcast'}));} catch (error) {if (!(error instanceof Response && error.status === 409)) throw error;}}
  return results;
}

/** Explicit staff recovery uses the original total deadline and attempt budget. */
export async function retryTrainingBroadcast(db:D1Database,input:{bookingId:string;idempotencyKey:string;reason:string;actorId:string}){
 await ensureTrainingBroadcastTables(db);await ensureTrainingDispatchTables(db);await ensureTrainingWorkflowNotificationTables(db);await ensureProviderLifecycleTables(db);
 const fingerprint=JSON.stringify([input.bookingId,'retry_broadcast',input.reason]);
 const prior=await db.prepare('SELECT fingerprint,result_json FROM training_assignment_responses WHERE idempotency_key=?').bind(input.idempotencyKey).first<Row>();
 if(prior){if(prior.fingerprint!==fingerprint)throw conflict('Training response key was used for different input');return{...parse<Row>(prior.result_json),duplicatePrevented:true};}
 if(input.reason.trim().length<8)throw new Response('Training retry requires a clear Operations reason',{status:400});
 const booking=await db.prepare("SELECT b.*,c.request_json,c.policy_json,c.revision,c.excluded_json,c.max_attempts,c.ops_due_at,c.first_session_id,c.state chain_state FROM canonical_bookings b JOIN training_assignment_chains c ON c.booking_id=b.id WHERE b.id=? AND b.service_code='dog_training'").bind(input.bookingId).first<Row>();
 const owner=trainingBroadcastOwner(input.bookingId),now=Date.now();
 if(!booking||booking.chain_state!=='needs_operations'||booking.provider_id!==owner||Number(booking.ops_due_at)<=now)throw conflict('Training retry is unavailable; use Operations assignment recovery');
 const rounds=Number((await db.prepare("SELECT COUNT(*) n FROM training_assignment_responses WHERE json_extract(fingerprint,'$[0]')=? AND json_extract(fingerprint,'$[1]')='retry_broadcast'").bind(input.bookingId).first<Row>())?.n??0)+2;
 if(rounds>Number(booking.max_attempts))throw conflict('Training assignment attempt budget is exhausted');
 const request={...parse<RequestInput>(booking.request_json),excludeProviderIds:parse<string[]>(booking.excluded_json)};
 const occurrences=buildOccurrences({...request,cityId:txt(booking.city_id),zoneId:txt(booking.zone_id)});
 const windows=await db.prepare("SELECT r.scheduled_start,r.scheduled_end,r.occurrence_number,s.scheduled_start session_start,s.scheduled_end session_end FROM scheduling_reservations r JOIN training_sessions s ON s.schedule_reservation_id=r.id AND s.booking_id=? WHERE r.group_id=? ORDER BY r.occurrence_number").bind(booking.id,booking.schedule_group_id).all<Row>();
 if(windows.results.length!==occurrences.length||windows.results.some((row,i)=>Date.parse(txt(row.scheduled_start))!==Date.parse(occurrences[i].start)||Date.parse(txt(row.scheduled_end))!==Date.parse(occurrences[i].end)||row.session_start!==row.scheduled_start||row.session_end!==row.scheduled_end))throw conflict('Training retry windows changed; Operations must reconcile them');
 const evaluated=await evaluate(db,booking,request),provider=evaluated.audience.mode==='full_time'?evaluated.providers.find(p=>p.id===evaluated.audience.providerId):null;
 const ids=evaluated.audience.mode==='broadcast'?evaluated.audience.contractorIds:[];
 const ttl=await Promise.all(ids.map(id=>getProviderAcceptanceTimeout(db,id))),expiresAt=Math.min(Number(booking.ops_due_at),...ttl.map(minutes=>now+minutes*60000));
 if(!provider&&(!ids.length||ttl.some(minutes=>!Number.isFinite(minutes)||minutes<=0)||expiresAt<=now))throw conflict('No eligible available trainer can receive this retry');
 const payment=await trainingPaymentPredicate(db,input.bookingId,booking.package_code==='trainer-meet-greet');
 const guard="EXISTS(SELECT 1 FROM canonical_bookings WHERE id=? AND provider_id=? AND status NOT IN ('cancelled','canceled','refunded','failed','expired','completed')) AND EXISTS(SELECT 1 FROM training_assignment_chains WHERE booking_id=? AND revision=? AND state='needs_operations' AND ops_due_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) AND NOT EXISTS(SELECT 1 FROM training_broadcast_claims WHERE booking_id=?) AND NOT EXISTS(SELECT 1 FROM training_sessions WHERE booking_id=? AND (provider_id!=? OR status NOT IN ('scheduled','locked'))) AND NOT EXISTS(SELECT 1 FROM scheduling_reservations WHERE group_id=? AND (provider_id!=? OR status!='assigned')) AND NOT EXISTS(SELECT 1 FROM provider_lifecycle_records WHERE booking_id=? AND (provider_id!=? OR status!='provider_matched' OR lease_expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)))";
 const guardBinds=[booking.id,owner,booking.id,booking.revision,booking.id,booking.id,owner,booking.schedule_group_id,owner,booking.id,owner];
 const exact="EXISTS(SELECT 1 FROM training_sessions WHERE id=? AND booking_id=? AND provider_id=? AND status='scheduled' AND scheduled_start=? AND scheduled_end=?) AND EXISTS(SELECT 1 FROM training_programmes WHERE booking_id=? AND provider_id=? AND status='scheduled') AND EXISTS(SELECT 1 FROM provider_work_orders WHERE booking_id=? AND provider_id=? AND status='awaiting_acceptance') AND (SELECT COUNT(*) FROM scheduling_reservations WHERE group_id=?)=? AND NOT EXISTS(SELECT 1 FROM training_sessions s LEFT JOIN scheduling_reservations r ON r.id=s.schedule_reservation_id WHERE s.booking_id=? AND (r.id IS NULL OR r.group_id!=? OR s.scheduled_start!=r.scheduled_start OR s.scheduled_end!=r.scheduled_end)) AND EXISTS(SELECT 1 FROM training_commercial_quotes q JOIN training_booking_quote_links l ON l.quote_id=q.id JOIN canonical_bookings b ON b.id=l.booking_id WHERE b.id=? AND q.status='used' AND q.used_booking_id=b.id AND q.package_code=b.package_code AND q.total_amount=b.total_amount) AND EXISTS(SELECT 1 FROM canonical_bookings WHERE id=? AND customer_id=? AND city_id=? AND zone_id=? AND pricing_json=? AND scheduled_start=? AND scheduled_end=?)";
 const exactBinds=[booking.first_session_id,booking.id,owner,occurrences[0].start,occurrences[0].end,booking.id,owner,booking.id,owner,booking.schedule_group_id,occurrences.length,booking.id,booking.schedule_group_id,booking.id,booking.id,booking.customer_id,booking.city_id,booking.zone_id,booking.pricing_json,booking.scheduled_start,booking.scheduled_end];
 const token=crypto.randomUUID(),result={bookingId:input.bookingId,state:provider?'assigned':'pending',providerId:provider?.id??null,offerExpiresAt:provider?null:expiresAt,duplicatePrevented:false,externalDelivery:false};
 const statements=[...assertions(db,evaluated.snapshots,token),db.prepare(`INSERT INTO training_broadcast_assertions(id,ok) SELECT ?,CASE WHEN (${guard}) AND (${exact}) AND (${payment.sql}) THEN 1 ELSE 0 END`).bind(`${token}:retry`,...guardBinds,...exactBinds,...payment.binds)];
 if(provider){
  statements.push(
   db.prepare("UPDATE canonical_bookings SET provider_id=?,updated_at=? WHERE id=? AND provider_id=?").bind(provider.id,now,booking.id,owner),
   db.prepare("UPDATE provider_work_orders SET provider_id=?,provider_name=?,provider_model='full_time',status='assigned',updated_at=? WHERE booking_id=? AND provider_id=?").bind(provider.id,provider.name,now,booking.id,owner),
   db.prepare("UPDATE training_programmes SET provider_id=?,updated_at=? WHERE booking_id=? AND provider_id=?").bind(provider.id,now,booking.id,owner),
   db.prepare("UPDATE training_sessions SET provider_id=?,updated_at=? WHERE booking_id=? AND provider_id=?").bind(provider.id,now,booking.id,owner),
   db.prepare("UPDATE scheduling_reservations SET provider_id=? WHERE group_id=? AND provider_id=?").bind(provider.id,booking.schedule_group_id,owner),
   db.prepare("UPDATE scheduling_assignment_decisions SET selected_provider_id=?,updated_at=?,reason='Training full-time recovery assignment',actor_id=? WHERE group_id=?").bind(provider.id,now,input.actorId,booking.schedule_group_id),
   db.prepare("UPDATE provider_assignment_offers SET provider_id=?,status='accepted',responded_at=?,response_reason='Training full-time recovery assignment',updated_at=? WHERE group_id=?").bind(provider.id,now,now,booking.schedule_group_id),
   db.prepare("UPDATE provider_lifecycle_records SET provider_id=?,version=version+1,updated_at=?,updated_by=? WHERE booking_id=? AND provider_id=? AND status='provider_matched'").bind(provider.id,now,input.actorId,booking.id,owner),
   db.prepare("UPDATE training_broadcast_offers SET status='withdrawn',responded_at=? WHERE booking_id=? AND status='pending'").bind(now,booking.id),
   ...trainingWorkflowNotificationStatements(db,{key:input.idempotencyKey,bookingId:input.bookingId,customerId:txt(booking.customer_id),providerId:provider.id,sessionId:txt(booking.first_session_id),event:'provider_replaced',sourceId:txt(booking.first_session_id),actorId:input.actorId,now}),
   db.prepare("INSERT INTO training_broadcast_assertions(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM canonical_bookings WHERE id=? AND provider_id=?) AND EXISTS(SELECT 1 FROM provider_work_orders WHERE booking_id=? AND provider_id=? AND provider_model='full_time' AND status='assigned') AND EXISTS(SELECT 1 FROM training_programmes WHERE booking_id=? AND provider_id=?) AND NOT EXISTS(SELECT 1 FROM training_sessions WHERE booking_id=? AND provider_id!=?) AND NOT EXISTS(SELECT 1 FROM scheduling_reservations WHERE group_id=? AND provider_id!=?) AND NOT EXISTS(SELECT 1 FROM provider_lifecycle_records WHERE booking_id=? AND provider_id!=?) THEN 1 ELSE 0 END").bind(`${token}:final`,booking.id,provider.id,booking.id,provider.id,booking.id,provider.id,booking.id,provider.id,booking.schedule_group_id,provider.id,booking.id,provider.id),
  );
 }else statements.push(...ids.map(providerId=>db.prepare("INSERT INTO training_broadcast_offers(booking_id,provider_id,session_id,status,offered_at,expires_at,source_snapshot_json) VALUES (?,?,?,'pending',?,?,?) ON CONFLICT(booking_id,provider_id) DO UPDATE SET status='pending',offered_at=excluded.offered_at,expires_at=excluded.expires_at,responded_at=NULL,source_snapshot_json=excluded.source_snapshot_json").bind(booking.id,providerId,booking.first_session_id,now,expiresAt,JSON.stringify(evaluated.decision.evaluations))));
 statements.push(
  db.prepare("UPDATE training_assignment_chains SET state=?,revision=revision+1 WHERE booking_id=? AND revision=?").bind(provider?'assigned':'broadcast_pending',booking.id,booking.revision),
  db.prepare("UPDATE training_assignment_ops_cases SET status='resolved' WHERE booking_id=?").bind(booking.id),
  db.prepare("UPDATE training_session_recovery_cases SET status='resolved',updated_at=? WHERE id=? AND status='open'").bind(now,`training-broadcast-ops:${booking.id}`),
  db.prepare('INSERT INTO training_assignment_responses(idempotency_key,fingerprint,result_json,actor_id,created_at) VALUES (?,?,?,?,?)').bind(input.idempotencyKey,fingerprint,JSON.stringify(result),input.actorId,now),
  db.prepare("INSERT INTO training_broadcast_assertions(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM training_assignment_chains WHERE booking_id=? AND state=? AND revision=?) AND (? OR ((SELECT COUNT(*) FROM training_broadcast_offers WHERE booking_id=? AND status='pending')=? AND NOT EXISTS(SELECT 1 FROM training_broadcast_offers WHERE booking_id=? AND status='pending' AND (session_id!=? OR expires_at!=? OR provider_id NOT IN (SELECT value FROM json_each(?)))))) THEN 1 ELSE 0 END").bind(`${token}:round`,booking.id,provider?'assigned':'broadcast_pending',Number(booking.revision)+1,provider?1:0,booking.id,ids.length,booking.id,booking.first_session_id,expiresAt,JSON.stringify(ids)),
  db.prepare('DELETE FROM training_broadcast_assertions WHERE id LIKE ?').bind(`${token}:%`),
 );
 try{await db.batch(statements);}catch(error){const replay=await db.prepare('SELECT fingerprint,result_json FROM training_assignment_responses WHERE idempotency_key=?').bind(input.idempotencyKey).first<Row>();if(replay?.fingerprint===fingerprint)return{...parse<Row>(replay.result_json),duplicatePrevented:true};if(/constraint/i.test(error instanceof Error?error.message:txt(error)))throw conflict('Training retry eligibility or ownership changed; no partial assignment');throw error;}
 return result;
}

/** Customer confirmation uses this field; a provisional provider id is never an assigned trainer. */
export async function trainingCustomerAssignment(db:D1Database,bookingId:string,providerId:string){
 if(providerId===trainingBroadcastOwner(bookingId)){
  const chain=await db.prepare("SELECT state FROM training_assignment_chains WHERE booking_id=?").bind(bookingId).first<Row>();
  const pending=await db.prepare("SELECT MIN(expires_at) expiry FROM training_broadcast_offers WHERE booking_id=? AND status='pending'").bind(bookingId).first<Row>();
  return{mode:'contractor_broadcast',state:chain?.state==='needs_operations'?'needs_operations':'pending',providerId:null,offerExpiresAt:pending?.expiry??null};
 }
 const exists=await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_work_orders'").first();
 const work=exists?await db.prepare('SELECT provider_model FROM provider_work_orders WHERE booking_id=?').bind(bookingId).first<Row>():null;
 return{mode:work?.provider_model==='full_time'?'full_time':'assigned',state:'assigned',providerId,offerExpiresAt:null};
}
