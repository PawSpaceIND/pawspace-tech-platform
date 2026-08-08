from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if new in text:
        return
    if old not in text:
        raise SystemExit(f"patch marker not found in {path}: {old[:140]}")
    file.write_text(text.replace(old, new, 1))


if '"pet_taxi"' not in Path("backend/src/scheduling.ts").read_text():
    raise SystemExit("Pet Taxi Gate 1 shared scheduler patch is missing")

replace_once(
    "lib/api-gateway.ts",
    '  if(url.pathname==="/api/taxi-bookings")return "scheduling.book";',
    '  if(url.pathname==="/api/taxi-bookings")return "scheduling.book";\n  if(url.pathname==="/api/taxi-lifecycle"){if(method==="GET")return url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return String(body.action)==="no_show"?"bookings.manage":"bookings.view";}'
)

Path("app/driver/page.tsx").write_text('import CanonicalDriverPage from"./canonical-driver-page";\nexport default function DriverPage(){return <CanonicalDriverPage/>}\n')

replace_once(
    "app/taxi/canonical-taxi-page.tsx",
    '<button onClick={()=>{setBooking(null);setAssignedDriver(null)}}>Back to Taxi</button>',
    '<Link href={`/driver?bookingId=${encodeURIComponent(booking.bookingId)}`}>Open canonical driver workspace →</Link><button onClick={()=>{setBooking(null);setAssignedDriver(null)}}>Back to Taxi</button>'
)

print("Pet Taxi Gate 2 wiring applied")
