from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if new in text:
        return
    if old not in text:
        raise SystemExit(f"patch marker not found in {path}: {old[:180]}")
    file.write_text(text.replace(old, new, 1))


# Gate 1: shared scheduler, governed Taxi providers, UAT roster and client type.
replace_once(
    "backend/src/scheduling.ts",
    'export type SchedulingService = "grooming" | "dog_training" | "boarding" | "pet_sitting";',
    'export type SchedulingService = "grooming" | "dog_training" | "boarding" | "pet_sitting" | "pet_taxi";'
)
replace_once(
    "backend/src/scheduling.ts",
    '  pet_sitting: { label:"Pet Sitting", durationMinutes:60, bufferMinutes:30, maxOccurrences:1, capacityMode:"care_mode" },',
    '  pet_sitting: { label:"Pet Sitting", durationMinutes:60, bufferMinutes:30, maxOccurrences:1, capacityMode:"care_mode" },\n  pet_taxi: { label:"Pet Taxi", durationMinutes:45, bufferMinutes:20, maxOccurrences:1, capacityMode:"appointment" },'
)

provider_path = Path("lib/provider-capacity-governance.ts")
provider_text = provider_path.read_text()
if 'taxi_rahul' not in provider_text:
    marker = '  {id:"sit_asha",cityId:"blr",name:"Asha R.",model:"commission",services:["pet_sitting"],zones:["blr-east"],rating:4.7,qualityScore:89,capacity:4,travelBufferMinutes:30,maxDailyJobs:6,acceptanceTimeoutMinutes:3},'
    addition = marker + '\n  {id:"taxi_rahul",cityId:"blr",name:"Rahul K.",model:"full_time",services:["pet_taxi"],zones:["blr-east"],rating:4.9,qualityScore:96,capacity:1,travelBufferMinutes:20,maxDailyJobs:8,acceptanceTimeoutMinutes:3},\n  {id:"taxi_meera",cityId:"blr",name:"Meera S.",model:"full_time",services:["pet_taxi"],zones:["blr-east"],rating:4.8,qualityScore:92,capacity:1,travelBufferMinutes:20,maxDailyJobs:8,acceptanceTimeoutMinutes:3},\n  {id:"taxi_imran",cityId:"blr",name:"Imran A.",model:"full_time",services:["pet_taxi"],zones:["blr-east"],rating:4.9,qualityScore:94,capacity:1,travelBufferMinutes:20,maxDailyJobs:8,acceptanceTimeoutMinutes:3},'
    if marker not in provider_text:
        raise SystemExit("Taxi provider seed marker not found")
    provider_path.write_text(provider_text.replace(marker, addition, 1))

replace_once(
    "app/api/uat-scheduling/route.ts",
    'JSON.stringify([input.serviceCode==="boarding"||input.careMode==="overnight"?"00:00-23:59":"09:00-19:00"])',
    'JSON.stringify([input.serviceCode==="boarding"||input.careMode==="overnight"?"00:00-23:59":input.serviceCode==="pet_taxi"?"06:00-22:00":"09:00-19:00"])'
)
replace_once(
    "lib/uat-scheduling-client.ts",
    'serviceCode:"grooming"|"dog_training"|"boarding"|"pet_sitting";',
    'serviceCode:"grooming"|"dog_training"|"boarding"|"pet_sitting"|"pet_taxi";'
)

# Gate 1-5 gateway authority. Public quote remains separate from authenticated booking/actions.
gateway_path = Path("lib/api-gateway.ts")
gateway = gateway_path.read_text()
if 'url.pathname==="/api/taxi-commercial"' not in gateway:
    marker = '||url.pathname==="/api/sitting-commercial"'
    if marker not in gateway:
        raise SystemExit("Taxi public gateway marker not found")
    gateway = gateway.replace(marker, marker + '||url.pathname==="/api/taxi-commercial"', 1)
if 'url.pathname==="/api/taxi-bookings"' not in gateway:
    marker = '  if(url.pathname==="/api/provider-assignment-recovery"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return ["accept","decline"].includes(String(body.action))?"bookings.view":"bookings.manage";}'
    addition = marker + '\n  if(url.pathname==="/api/taxi-bookings")return "scheduling.book";\n  if(url.pathname==="/api/taxi-lifecycle"){if(method==="GET")return url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return String(body.action)==="no_show"?"bookings.manage":"bookings.view";}\n  if(url.pathname==="/api/taxi-finance"){if(method==="GET")return "finance.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return String(body.action)==="request_cancel"?"scheduling.book":"finance.manage";}\n  if(url.pathname==="/api/taxi-proof"){if(method==="GET")return url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"");if(action==="acknowledge_incident")return "scheduling.book";if(["sandbox_finalize_media","record_media_scan","revoke_media","resolve_incident"].includes(action))return "bookings.manage";return "bookings.view";}\n  if(url.pathname==="/api/taxi-ops")return method==="GET"?"bookings.view":"bookings.manage";\n  if(url.pathname==="/api/taxi-recovery")return "bookings.view";'
    if marker not in gateway:
        raise SystemExit("Taxi authenticated gateway marker not found")
    gateway = gateway.replace(marker, addition, 1)
gateway_path.write_text(gateway)

# Canonical customer/driver entrypoints replace fixture-only screens.
Path("app/taxi/page.tsx").write_text('import CanonicalTaxiPage from"./canonical-taxi-page";\nexport default function TaxiPage(){return <CanonicalTaxiPage/>}\n')
Path("app/driver/page.tsx").write_text('import CanonicalDriverPage from"./canonical-driver-page";\nexport default function DriverPage(){return <CanonicalDriverPage/>}\n')

# Customer confirmation reaches management and driver lifecycle.
replace_once(
    "app/taxi/canonical-taxi-page.tsx",
    '<button onClick={()=>{setBooking(null);setAssignedDriver(null)}}>Back to Taxi</button>',
    '<Link href={`/taxi/manage?bookingId=${encodeURIComponent(booking.bookingId)}`}>Manage trip</Link><Link href={`/driver?bookingId=${encodeURIComponent(booking.bookingId)}`}>Open canonical driver workspace →</Link><button onClick={()=>{setBooking(null);setAssignedDriver(null)}}>Back to Taxi</button>'
)

# Customer management includes governed incident visibility/acknowledgement.
Path("app/taxi/manage/page.tsx").write_text(
    'import TaxiCustomerManagement from"./taxi-customer-management";\n'
    'import TaxiCustomerIncidents from"./taxi-customer-incidents";\n'
    'export default async function TaxiManagePage({searchParams}:{searchParams:Promise<{bookingId?:string}>}){const params=await searchParams,bookingId=String(params.bookingId||"");return <><TaxiCustomerManagement bookingId={bookingId}/><div style={{maxWidth:980,margin:"0 auto",padding:"0 28px 28px"}}><TaxiCustomerIncidents bookingId={bookingId}/></div></>}\n'
)

# Completion must be enforced by canonical route evidence and verify the due ledger row.
path = "lib/taxi-lifecycle.ts"
marker = 'const amount=Number(b.total_amount);if(!Number.isFinite(amount)||amount<=0)throw new Response("Canonical Pet Taxi amount is missing",{status:409});'
replacement = 'const route=await db.prepare("SELECT COUNT(*) count FROM taxi_trip_events WHERE booking_id=? AND trip_id=? AND event_type=\'route_location_sample\'").bind(b.id,b.trip_id).first<{count:number}>(),routeSamples=Number(route?.count||0);if(routeSamples<2)throw new Response("Pet Taxi UAT completion requires at least two canonical sandbox route samples",{status:409});'+marker
replace_once(path, marker, replacement)
replace_once(
    path,
    ')]);const eventId=await event(db,b,"trip_completed",input.actorId,{paymentEventId,amount,paymentStatus:"due",liveMoney:false,productionPaymentTimingPolicy:"pending"});',
    ')]);const dueEvent=await db.prepare("SELECT id FROM taxi_trip_payment_events WHERE id=? AND status=\'due\'").bind(paymentEventId).first<Row>();if(!dueEvent)throw new Response("Pet Taxi completion payment event was not recorded as due",{status:500});const eventId=await event(db,b,"trip_completed",input.actorId,{paymentEventId,amount,paymentStatus:"due",liveMoney:false,routeSamples,productionPaymentTimingPolicy:"pending"});'
)
replace_once(path, 'paymentStatus:"due",amount,liveMoney:false})', 'paymentStatus:"due",amount,routeSamples,liveMoney:false})')

# Driver UI mirrors the same completion prerequisite and routes proof/recovery explicitly.
path = "app/driver/canonical-driver-page.tsx"
replace_once(
    path,
    'const bookingStatus=String(booking.status),tripStatus=String(booking.trip_status),vehicleId=String(booking.vehicle_id||vehicles[String(booking.provider_id)]||"");',
    'const bookingStatus=String(booking.status),tripStatus=String(booking.trip_status),vehicleId=String(booking.vehicle_id||vehicles[String(booking.provider_id)]||""),routeSamples=(booking.events||[]).filter(item=>String(item.event_type)==="route_location_sample").length;'
)
replace_once(
    path,
    '<p>Driver {String(booking.provider_name||booking.provider_id)} · booking {label(bookingStatus)} · trip {label(tripStatus)}</p>',
    '<p>Driver {String(booking.provider_name||booking.provider_id)} · booking {label(bookingStatus)} · trip {label(tripStatus)}</p>{bookingStatus==="reassignment_offered"&&<p><Link href={`/driver/recovery?bookingId=${encodeURIComponent(bookingId)}`}>Accept replacement recovery offer →</Link></p>}'
)
replace_once(
    path,
    '<section style={{border:"1px solid #ddd",padding:18,borderRadius:14}}><h2>Canonical lifecycle</h2>',
    '<section style={{border:"1px solid #ddd",padding:18,borderRadius:14}}><h2>Canonical lifecycle</h2><p><Link href={`/driver/proof?bookingId=${encodeURIComponent(bookingId)}`}>Route · proof · incident →</Link> · {routeSamples} sandbox route sample{routeSamples===1?"":"s"}</p>'
)
replace_once(
    path,
    '<button disabled={!!busy||tripStatus!=="dropoff_confirmed"} onClick={()=>void act("complete_trip")}>Complete trip · create payment due</button>',
    '<button disabled={!!busy||tripStatus!=="dropoff_confirmed"||routeSamples<2} onClick={()=>void act("complete_trip")}>{routeSamples<2?"Record 2 route samples before completion":"Complete trip · create payment due"}</button>'
)

print("Pet Taxi recertification patch applied")
