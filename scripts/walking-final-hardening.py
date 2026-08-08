from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if new in text:
        return
    if old not in text:
        raise SystemExit(f"patch marker not found in {path}: {old[:120]}")
    file.write_text(text.replace(old, new, 1))


# Make replacement-walker acceptance safe across multiple recovery episodes.
replace_once(
    "lib/walking-recovery-client.ts",
    'export async function acceptWalkingReplacement(input:{bookingId:string}){const response=await fetch("/api/walking-recovery",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({bookingId:input.bookingId,idempotencyKey:`walking-recovery-accept:${input.bookingId}`})});',
    'export async function acceptWalkingReplacement(input:{bookingId:string;idempotencyKey?:string}){const response=await fetch("/api/walking-recovery",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({bookingId:input.bookingId,idempotencyKey:input.idempotencyKey||`walking-recovery-accept:${input.bookingId}:${crypto.randomUUID()}`})});'
)

# Replacement eligibility must include the governed travel buffer around every remaining walk.
replace_once(
    "lib/walking-ops-governance.ts",
    'const conflicts=await db.prepare("SELECT id FROM scheduling_reservations WHERE provider_id=? AND group_id!=? AND status NOT IN (\'cancelled\',\'completed\') AND scheduled_start<? AND scheduled_end>? LIMIT 1").bind(row.id,booking.schedule_group_id,end,start).first<Row>();if(conflicts){eligible=false;break}',
    'const bufferMs=Math.max(0,Number(row.travel_buffer_minutes||20))*60_000,bufferedStart=new Date(new Date(start).getTime()-bufferMs).toISOString(),bufferedEnd=new Date(new Date(end).getTime()+bufferMs).toISOString(),conflicts=await db.prepare("SELECT id FROM scheduling_reservations WHERE provider_id=? AND group_id!=? AND status NOT IN (\'cancelled\',\'completed\') AND scheduled_start<? AND scheduled_end>? LIMIT 1").bind(row.id,booking.schedule_group_id,bufferedEnd,bufferedStart).first<Row>();if(conflicts){eligible=false;break}'
)

# Reuse one DB handle for a single Operations request/audit.
replace_once(
    "app/api/walking-ops/route.ts",
    'const result=await mutateWalkingOps(await database(),{...body,bookingId,action,idempotencyKey,actorId:actor.email});await securityAudit(await database(),actor,`walking.ops.${action}`',
    'const db=await database(),result=await mutateWalkingOps(db,{...body,bookingId,action,idempotencyKey,actorId:actor.email});await securityAudit(db,actor,`walking.ops.${action}`'
)

# Add Walking to Team Operations navigation if it is not already present.
ops = Path("app/team/operations/page.tsx")
ops_text = ops.read_text()
if '/team/operations/walking' not in ops_text:
    marker = '<Link href="/team/operations/sitting" style={{border:"1px solid #ddd",borderRadius:16,padding:20,textDecoration:"none",color:"inherit"}}><h2>Sitting exception queue</h2><p>Sitter recovery, care incidents, Finance review, proof/media blockers and service-timing exceptions.</p></Link>'
    addition = marker + '<Link href="/team/operations/walking" style={{border:"1px solid #ddd",borderRadius:16,padding:20,textDecoration:"none",color:"inherit"}}><h2>Walking exception queue</h2><p>Walker recovery, route evidence, safety incidents, completed-payment dues and settlement blockers.</p></Link>'
    if marker not in ops_text:
        raise SystemExit("Walking Operations navigation marker not found")
    ops.write_text(ops_text.replace(marker, addition, 1))

# Add Walking Finance as a direct governed workspace link without changing existing finance logic.
finance = Path("app/team/finance/page.tsx")
finance_text = finance.read_text()
if '/team/finance/walking' not in finance_text:
    needle = '</main>'
    link = '<p><a href="/team/finance/walking">Open Dog Walking Finance workspace -></a></p>'
    if needle not in finance_text:
        raise SystemExit("Finance page closing marker not found")
    finance.write_text(finance_text.replace(needle, link + needle, 1))

print("Walking final hardening applied")
