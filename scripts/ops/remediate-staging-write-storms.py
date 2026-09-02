from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"{label}: source anchor missing")
    return text.replace(old, new, 1)


# Bound lease maintenance so a foreground scheduling request never cleans the entire
# historical staging backlog in one transaction. The batch re-checks eligibility after
# candidate selection, preserving the booking-vs-cleanup race guard.
leases = Path("lib/scheduling-reservation-leases.ts")
s = leases.read_text()
start = s.index("export async function cleanupExpiredReservationLeases")
cleanup = r'''export async function cleanupExpiredReservationLeases(db:Db,now=Date.now()){
  const running=cleanupRunning.get(db);if(running)return running;
  const pending=(async()=>{
    if(!(await ensureSchedulingReservationLeaseGovernance(db)))return{groups:0,reservations:0};
    const hasCanonical=await tableExists(db,"canonical_bookings");
    const confirmedClause=hasCanonical?"AND NOT EXISTS (SELECT 1 FROM canonical_bookings b WHERE b.schedule_group_id=r.group_id)":"";
    const expiredLease="((r.lease_expires_at IS NOT NULL AND r.lease_expires_at<=?) OR (r.customer_session_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_identity_sessions s WHERE s.id=r.customer_session_id AND s.status IN ('active','superseded') AND s.expires_at>?)))";
    const expired=await db.prepare(`SELECT DISTINCT r.group_id FROM scheduling_reservations r WHERE r.status='assigned' AND ${expiredLease} ${confirmedClause} LIMIT 8`).bind(now,now).all<{group_id:string}>();
    const groupIds=expired.results.map(row=>String(row.group_id));
    if(!groupIds.length)return{groups:0,reservations:0};
    const placeholders=groupIds.map(()=>"?").join(","),reason="reservation_lease_expired";
    const hasOffers=await tableExists(db,"provider_assignment_offers");
    const marker=`EXISTS (SELECT 1 FROM scheduling_reservation_lease_cleanup c WHERE c.group_id=r.group_id AND c.reason=? AND c.released_at=?)`;
    const statements=[
      db.prepare(`INSERT OR REPLACE INTO scheduling_reservation_lease_cleanup (group_id,reason,released_at) SELECT DISTINCT r.group_id,?,? FROM scheduling_reservations r WHERE r.group_id IN (${placeholders}) AND r.status='assigned' AND ${expiredLease} ${confirmedClause}`).bind(reason,now,...groupIds,now,now),
      db.prepare(`UPDATE scheduling_reservations AS r SET status='cancelled' WHERE r.status='assigned' AND r.group_id IN (${placeholders}) AND ${marker}`).bind(...groupIds,reason,now),
      db.prepare(`UPDATE scheduling_assignment_decisions AS r SET status='expired',actor_id='system:reservation-lease-cleanup',reason=?,updated_at=? WHERE r.status IN ('assigned','awaiting_admin') AND r.group_id IN (${placeholders}) AND ${marker}`).bind(reason,now,...groupIds,reason,now),
    ];
    if(hasOffers)statements.push(db.prepare(`UPDATE provider_assignment_offers AS r SET status='cancelled',responded_at=?,response_reason=?,updated_at=? WHERE r.status='pending' AND r.group_id IN (${placeholders}) AND ${marker}`).bind(now,reason,now,...groupIds,reason,now));
    const result=await db.batch(statements);
    return{groups:Number(result[0]?.meta?.changes||0),reservations:Number(result[1]?.meta?.changes||0)};
  })();
  cleanupRunning.set(db,pending);try{return await pending;}finally{if(cleanupRunning.get(db)===pending)cleanupRunning.delete(db);}
}
'''
s = s[:start] + cleanup
leases.write_text(s)


# UAT discovery should not persist synthetic availability on every candidate request.
# Real partner/ops/roster rows remain authoritative; only when none exists does UAT get
# an in-memory synthetic window. This removes the availability INSERT burst entirely.
route = Path("app/api/uat-scheduling/route.ts")
s = route.read_text()
start = s.index("async function seedUatRoster(")
end = s.index("\n\nfunction repository(", start)
s = s[:start] + '''async function syntheticUatRosterEnabled(){const {env}=await import("cloudflare:workers");return uatRosterSeedingEnabled(env);}\nfunction syntheticUatWindow(input:RequestBody){return input.serviceCode==="boarding"||input.careMode==="overnight"?"00:00-23:59":input.serviceCode==="pet_taxi"?"06:00-22:00":input.serviceCode==="dog_walking"?"06:00-21:00":"09:00-19:00";}''' + s[end:]
s = replace_once(
    s,
    'function repository(db:Awaited<ReturnType<typeof database>>):PlatformRepository{',
    'function repository(db:Awaited<ReturnType<typeof database>>,input?:RequestBody,syntheticUatRoster=false):PlatformRepository{',
    "repository arguments",
)
old = '''    async listAvailability(providerId:string,date:string){if((await blockedProviders(date)).has(providerId))return [];const providerRows=(await availabilityRows(date)).filter(row=>String(row.provider_id)===providerId),authored=providerRows.filter(row=>["partner_app","operations","roster"].includes(String(row.source))),results=authored.length?authored:providerRows;return results.map(row=>({id:String(row.id),providerId:String(row.provider_id),cityId:String(row.city_id),zoneId:String(row.zone_id),date:String(row.date),windows:JSON.parse(String(row.windows_json)),source:String(row.source) as ProviderAvailability["source"],updatedAt:new Date(Number(row.updated_at)).toISOString()}));},'''
new = '''    async listAvailability(providerId:string,date:string){if((await blockedProviders(date)).has(providerId))return [];const providerRows=(await availabilityRows(date)).filter(row=>String(row.provider_id)===providerId),authored=providerRows.filter(row=>["partner_app","operations","roster"].includes(String(row.source))),results=authored.length?authored:providerRows;if(results.length)return results.map(row=>({id:String(row.id),providerId:String(row.provider_id),cityId:String(row.city_id),zoneId:String(row.zone_id),date:String(row.date),windows:JSON.parse(String(row.windows_json)),source:String(row.source) as ProviderAvailability["source"],updatedAt:new Date(Number(row.updated_at)).toISOString()}));if(!syntheticUatRoster||!input)return [];return[{id:`uat_synthetic_${providerId}_${date}_${input.zoneId}`,providerId,cityId:cityIdFor(input),zoneId:input.zoneId,date,windows:[syntheticUatWindow(input)],source:"uat_roster" as ProviderAvailability["source"],updatedAt:new Date(0).toISOString()}];},'''
s = replace_once(s, old, new, "synthetic availability")
s = replace_once(
    s,
    'schedule(repository(db),{cityId:cityIdFor(original)',
    'schedule(repository(db,original,await syntheticUatRosterEnabled()),{cityId:cityIdFor(original)',
    "operations assignment repository",
)
s = replace_once(
    s,
    'await seedUatRoster(input,db);const rules=await activeRules(db,input),requestInput:ScheduleRequest=',
    'const syntheticUatRoster=await syntheticUatRosterEnabled();const rules=await activeRules(db,input),requestInput:ScheduleRequest=',
    "remove roster materialization",
)
s = replace_once(
    s,
    'decision=await schedule(repository(db),requestInput);',
    'decision=await schedule(repository(db,input,syntheticUatRoster),requestInput);',
    "reserve assignment repository",
)
route.write_text(s)


tests = Path("tests/uat-scheduling-d1-contention.test.mjs")
s = tests.read_text()
s += r'''

test("Track 3 UAT assignment discovery is read-only before the atomic reservation claim",()=>{
  const scheduling=fs.readFileSync(new URL("../app/api/uat-scheduling/route.ts",import.meta.url),"utf8");
  assert.doesNotMatch(scheduling,/async function seedUatRoster/);
  assert.doesNotMatch(scheduling,/await seedUatRoster\(input,db\)/);
  assert.match(scheduling,/syntheticUatRosterEnabled/);
  assert.match(scheduling,/uat_synthetic_/);
});

test("expired reservation maintenance is bounded per foreground request",()=>{
  const leases=fs.readFileSync(new URL("../lib/scheduling-reservation-leases.ts",import.meta.url),"utf8");
  assert.match(leases,/LIMIT 8/);
  assert.match(leases,/groupIds\.map\(\(\)=>"\?"\)/);
  assert.match(leases,/scheduling_reservation_lease_cleanup[\s\S]*?released_at=\?/);
});
'''
tests.write_text(s)
