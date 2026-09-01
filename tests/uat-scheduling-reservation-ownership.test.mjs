import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const route = readFileSync(new URL('../app/api/uat-scheduling/route.ts', import.meta.url), 'utf8');
const auth = readFileSync(new URL('../lib/server-auth.ts', import.meta.url), 'utf8');

test('reserve enforces customer ownership before reservation work and preserves auth status', () => {
  assert.match(route, /import \{authError,requireCustomerOwnership,requirePermission,resolveActor,securityAudit,type AuthenticatedActor\} from "\.\.\/\.\.\/\.\.\/lib\/server-auth";/);

  const postStart = route.indexOf('export async function POST(request:Request)');
  assert.notEqual(postStart, -1, 'POST handler must exist');
  // Bounded by the next exported handler rather than by a comment: the '// Staff day board:' comment this
  // used to slice on is gone, and indexOf returning -1 silently widened `post` to the rest of the file,
  // so the ordering assertions below were no longer confined to POST at all.
  const nextExport = route.indexOf('export async function', postStart + 1);
  const post = route.slice(postStart, nextExport === -1 ? route.length : nextExport);

  // resolveActor used to sit AFTER the field validation, and this test located it that way. It now runs
  // first, because tests/route-authorization-class.test.mjs requires a guarded route to settle identity
  // before it judges a payload - an unauthorized caller must never be answered "Missing scheduling
  // fields". The ordering this test actually protects is unchanged and is asserted below, and one link
  // is now stronger: ownership is checked BEFORE the field validation, not after it.
  // Declared in a combined const list alongside db and input, so the binding keyword is not adjacent.
  const resolveIndex = post.indexOf('actor=await resolveActor(request);');
  const permissionIndex = post.indexOf('requirePermission(actor,"scheduling.book");');
  const ownershipIndex = post.indexOf('await requireCustomerOwnership(db,actor,input.customerId);');
  // The code form, not the phrase: the route's own comment mentions it too, ahead of the check.
  const validationIndex = post.indexOf('return json({error:"Missing scheduling fields"},400);');
  const seedIndex = post.indexOf('await seedProviderCapacityDefaults(db);', ownershipIndex);
  const ensureIndex = post.indexOf('await ensureSchedulingTables(db);', ownershipIndex);
  const reservationReadIndex = post.indexOf('SELECT * FROM scheduling_assignment_decisions', ownershipIndex);
  const rosterIndex = post.indexOf('await seedUatRoster(input,db);', ownershipIndex);
  const insertIndex = post.indexOf('await insertReservations(db,input.clientRequestId,input,decision,lease);', ownershipIndex);

  assert.ok(resolveIndex > 0, 'reserve must resolve an authenticated actor');
  assert.ok(permissionIndex > resolveIndex, 'the reserve permission must be required after authentication');
  assert.ok(ownershipIndex > permissionIndex, 'ownership must be checked after authentication');
  assert.ok(validationIndex > ownershipIndex, 'an unauthorized caller must be refused, not told which fields are missing');
  assert.ok(seedIndex > ownershipIndex, 'capacity/default writes must happen only after ownership passes');
  assert.ok(ensureIndex > ownershipIndex, 'scheduling-table writes must happen only after ownership passes');
  assert.ok(reservationReadIndex > ownershipIndex, 'reservation decision reads must happen only after ownership passes');
  assert.ok(rosterIndex > ownershipIndex, 'roster writes must happen only after ownership passes');
  assert.ok(insertIndex > ownershipIndex, 'reservation inserts must happen only after ownership passes');
  assert.match(post, /catch\(error\)\{return authError\(error,"Scheduling failed"\);\}\}/, 'Response auth failures must retain their 401/403 status instead of becoming 500');
});

test('customer ownership helper denies cross-customer access with 403 and preserves privileged bypass', () => {
  const helperStart = auth.indexOf('export async function requireCustomerOwnership');
  const helperEnd = auth.indexOf('export async function requireProviderOwnership', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'customer ownership helper must exist');
  const helper = auth.slice(helperStart, helperEnd);

  assert.match(helper, /actor\.developmentPreview\|\|hasPermission\(actor\.permissions,"customers\.manage"\)\|\|hasPermission\(actor\.permissions,"bookings\.manage"\)/, 'staff/admin booking or customer managers must retain bypass');
  assert.match(helper, /String\(binding\.subject_id\)!==customerId\)throw authFailure\("Customer ownership denied",403\)/, 'bound customer mismatch must return 403');
  assert.match(helper, /String\(legacy\.customer_id\)!==customerId\)throw authFailure\("Customer ownership denied",403\)/, 'legacy customer mismatch must return 403');
});
