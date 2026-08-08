from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"patch marker not found in {path}: {old[:100]}")
    file.write_text(text.replace(old, new, 1))


# Backend completion must enforce route evidence, not rely on UI state.
path = "lib/walking-lifecycle.ts"
marker = 'const pricing=parse<Record<string,unknown>>(booking.pricing_json,{}),amount=Number(pricing.perWalkAmount||0);'
replacement = 'const route=await db.prepare("SELECT COUNT(*) count FROM walking_session_events WHERE booking_id=? AND session_id=? AND event_type=\'route_location_sample\'").bind(booking.id,session.id).first<{count:number}>(),routeSamples=Number(route?.count||0);if(routeSamples<2)throw new Response("Dog Walking UAT completion requires at least two canonical sandbox route samples",{status:409});'+marker
replace(path, marker, replacement)
replace(path, 'paymentStatus:"due",liveMoney:false,allComplete}', 'paymentStatus:"due",liveMoney:false,routeSamples,allComplete}')
replace(path, 'paymentStatus:"due",amount,allComplete,liveMoney:false}', 'paymentStatus:"due",amount,routeSamples,allComplete,liveMoney:false}')

# Walker workspace exposes proof/recovery and uses route evidence as a completion prerequisite.
path = "app/walker/page.tsx"
old = 'const sessions=useMemo(()=>(booking?.sessions||[]) as Array<Record<string,unknown>>,[booking?.sessions]),selected=sessions.find(item=>String(item.id)===selectedSessionId),completed=sessions.filter(item=>String(item.status)==="completed").length,due=((booking?.sessionPayments||[]) as Array<Record<string,unknown>>).filter(item=>String(item.status)==="due").reduce((sum,item)=>sum+Number(item.amount||0),0),bookingStatus=String(booking?.status||"loading"),sessionStatus=String(selected?.status||"");'
new = 'const sessions=useMemo(()=>(booking?.sessions||[]) as Array<Record<string,unknown>>,[booking?.sessions]),selected=sessions.find(item=>String(item.id)===selectedSessionId),completed=sessions.filter(item=>String(item.status)==="completed").length,due=((booking?.sessionPayments||[]) as Array<Record<string,unknown>>).filter(item=>String(item.status)==="due").reduce((sum,item)=>sum+Number(item.amount||0),0),bookingStatus=String(booking?.status||"loading"),sessionStatus=String(selected?.status||""),routeSamples=((booking?.events||[]) as Array<Record<string,unknown>>).filter(item=>String(item.session_id)===selectedSessionId&&String(item.event_type)==="route_location_sample").length;'
replace(path, old, new)
replace(path, '<p>Provider: {String(booking.provider_id||"")}</p><p>Window:', '<p>Provider: {String(booking.provider_id||"")}</p>{bookingStatus==="reassignment_offered"&&<p><Link href={`/walker/recovery?bookingId=${encodeURIComponent(bookingId)}`}>Accept replacement recovery offer →</Link></p>}<p>Window:')
replace(path, '<div className={styles.pet}>', '<p><Link href={`/walker/proof?bookingId=${encodeURIComponent(bookingId)}&sessionId=${encodeURIComponent(selectedSessionId)}`}>Route · proof · incident →</Link></p><div className={styles.pet}>')
replace(path, '<span>GPS proof</span><strong>Not live</strong><small>Gate 4 integration pending</small>', '<span>Route evidence</span><strong>{routeSamples} sample{routeSamples===1?"":"s"}</strong><small>Sandbox/unverified · production GPS not live</small>')
replace(path, '<button className={styles.complete} disabled={!!busy||!selected||sessionStatus!=="in_progress"} onClick={()=>void act("complete_walk")}>Complete walk · create payment-due event</button>', '<button className={styles.complete} disabled={!!busy||!selected||sessionStatus!=="in_progress"||routeSamples<2} onClick={()=>void act("complete_walk")}>{routeSamples<2?"Record 2 route samples before completion":"Complete walk · create payment-due event"}</button>')

# Customer success state links to canonical management.
replace("app/walking/page.tsx", '<Link href="/account">My PawSpace</Link>', '<Link href={`/walking/manage?bookingId=${encodeURIComponent(booking?.bookingId||"")}`}>Manage walks</Link><Link href="/account">My PawSpace</Link>')

# Gateway permissions for all Walking gates.
path = "lib/api-gateway.ts"
marker = 'if(url.pathname==="/api/walking-bookings")return "scheduling.book";'
addition = marker+'\n  if(url.pathname==="/api/walking-lifecycle"){if(method==="GET")return url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return String(body.action)==="no_show"?"bookings.manage":"bookings.view";}\n  if(url.pathname==="/api/walking-finance"){if(method==="GET")return "finance.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return String(body.action)==="request_cancel"?"scheduling.book":"finance.manage";}\n  if(url.pathname==="/api/walking-proof"){if(method==="GET")return url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"");if(action==="acknowledge_incident")return "scheduling.book";if(["sandbox_finalize_media","record_media_scan","revoke_media","resolve_incident"].includes(action))return "bookings.manage";return "bookings.view";}\n  if(url.pathname==="/api/walking-ops")return method==="GET"?"bookings.view":"bookings.manage";\n  if(url.pathname==="/api/walking-recovery")return "bookings.view";'
replace(path, marker, addition)

print("Walking cross-cutting closure patch applied")
