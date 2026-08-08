from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if new in text:
        return
    if old not in text:
        raise SystemExit(f"patch marker not found in {path}: {old[:140]}")
    file.write_text(text.replace(old, new, 1))


# Completion must be enforced by canonical route evidence on the server.
path = "lib/taxi-lifecycle.ts"
marker = 'const amount=Number(b.total_amount);if(!Number.isFinite(amount)||amount<=0)throw new Response("Canonical Pet Taxi amount is missing",{status:409});'
replacement = 'const route=await db.prepare("SELECT COUNT(*) count FROM taxi_trip_events WHERE booking_id=? AND event_type=\'route_location_sample\'").bind(b.id).first<{count:number}>(),routeSamples=Number(route?.count||0);if(routeSamples<2)throw new Response("Pet Taxi UAT completion requires at least two canonical sandbox route samples",{status:409});'+marker
replace_once(path, marker, replacement)
replace_once(path, 'paymentStatus:"due",liveMoney:false,productionPaymentTimingPolicy:"pending"}', 'paymentStatus:"due",liveMoney:false,routeSamples,productionPaymentTimingPolicy:"pending"}')
replace_once(path, 'paymentStatus:"due",amount,liveMoney:false})', 'paymentStatus:"due",amount,routeSamples,liveMoney:false})')

# Driver workspace exposes proof/recovery and mirrors the server completion prerequisite.
path = "app/driver/canonical-driver-page.tsx"
old = 'const bookingStatus=String(booking.status),tripStatus=String(booking.trip_status),vehicleId=String(booking.vehicle_id||vehicles[String(booking.provider_id)]||"");'
new = 'const bookingStatus=String(booking.status),tripStatus=String(booking.trip_status),vehicleId=String(booking.vehicle_id||vehicles[String(booking.provider_id)]||""),routeSamples=(booking.events||[]).filter(item=>String(item.event_type)==="route_location_sample").length;'
replace_once(path, old, new)
replace_once(path, '<p>Driver {String(booking.provider_name||booking.provider_id)} · booking {label(bookingStatus)} · trip {label(tripStatus)}</p>', '<p>Driver {String(booking.provider_name||booking.provider_id)} · booking {label(bookingStatus)} · trip {label(tripStatus)}</p>{bookingStatus==="reassignment_offered"&&<p><Link href={`/driver/recovery?bookingId=${encodeURIComponent(bookingId)}`}>Accept replacement recovery offer →</Link></p>}')
replace_once(path, '<section style={{border:"1px solid #ddd",padding:18,borderRadius:14}}><h2>Canonical lifecycle</h2>', '<section style={{border:"1px solid #ddd",padding:18,borderRadius:14}}><h2>Canonical lifecycle</h2><p><Link href={`/driver/proof?bookingId=${encodeURIComponent(bookingId)}`}>Route · proof · incident →</Link> · {routeSamples} sandbox route sample{routeSamples===1?"":"s"}</p>')
replace_once(path, '<button disabled={!!busy||tripStatus!=="dropoff_confirmed"} onClick={()=>void act("complete_trip")}>Complete trip · create payment due</button>', '<button disabled={!!busy||tripStatus!=="dropoff_confirmed"||routeSamples<2} onClick={()=>void act("complete_trip")}>{routeSamples<2?"Record 2 route samples before completion":"Complete trip · create payment due"}</button>')

# Customer confirmation reaches canonical management.
replace_once("app/taxi/canonical-taxi-page.tsx", '<Link href={`/driver?bookingId=${encodeURIComponent(booking.bookingId)}`}>Open canonical driver workspace →</Link>', '<Link href={`/taxi/manage?bookingId=${encodeURIComponent(booking.bookingId)}`}>Manage trip</Link><Link href={`/driver?bookingId=${encodeURIComponent(booking.bookingId)}`}>Open canonical driver workspace →</Link>')

# Customer management includes the governed incident view.
Path("app/taxi/manage/page.tsx").write_text('import TaxiCustomerManagement from"./taxi-customer-management";\nimport TaxiCustomerIncidents from"./taxi-customer-incidents";\nexport default async function TaxiManagePage({searchParams}:{searchParams:Promise<{bookingId?:string}>}){const params=await searchParams,bookingId=String(params.bookingId||"");return <><TaxiCustomerManagement bookingId={bookingId}/><div style={{maxWidth:980,margin:"0 auto",padding:"0 28px 28px"}}><TaxiCustomerIncidents bookingId={bookingId}/></div></>}\n')

# Gateway authority for Gates 3-5.
path = "lib/api-gateway.ts"
marker = '  if(url.pathname==="/api/taxi-lifecycle"){if(method==="GET")return url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return String(body.action)==="no_show"?"bookings.manage":"bookings.view";}'
addition = marker+'\n  if(url.pathname==="/api/taxi-finance"){if(method==="GET")return "finance.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return String(body.action)==="request_cancel"?"scheduling.book":"finance.manage";}\n  if(url.pathname==="/api/taxi-proof"){if(method==="GET")return url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"");if(action==="acknowledge_incident")return "scheduling.book";if(["sandbox_finalize_media","record_media_scan","revoke_media","resolve_incident"].includes(action))return "bookings.manage";return "bookings.view";}\n  if(url.pathname==="/api/taxi-ops")return method==="GET"?"bookings.view":"bookings.manage";\n  if(url.pathname==="/api/taxi-recovery")return "bookings.view";'
replace_once(path, marker, addition)

# Direct Team navigation for the newly governed vertical.
for path, href, label in [
    ("app/team/operations/page.tsx", "/team/operations/taxi", "Open Pet Taxi Operations exception queue ->"),
    ("app/team/finance/page.tsx", "/team/finance/taxi", "Open Pet Taxi Finance workspace ->"),
]:
    file = Path(path)
    text = file.read_text()
    if href not in text:
        marker = "</main>"
        if marker not in text:
            raise SystemExit(f"main closing marker not found in {path}")
        text = text.replace(marker, f'<p><a href="{href}">{label}</a></p>'+marker, 1)
        file.write_text(text)

print("Pet Taxi cross-gate closure patch applied")
