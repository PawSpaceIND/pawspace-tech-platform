from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if new in text:
        return
    if old not in text:
        raise SystemExit(f"patch marker not found in {path}: {old[:140]}")
    file.write_text(text.replace(old, new, 1))


# Refuse to build Taxi on a stale pre-Walking base.
scheduler = Path("backend/src/scheduling.ts").read_text()
if '"dog_walking"' not in scheduler:
    raise SystemExit("Taxi branch does not contain the merged Dog Walking scheduler; refresh from main first")

replace_once(
    "backend/src/scheduling.ts",
    'export type SchedulingService = "grooming" | "dog_training" | "boarding" | "pet_sitting" | "dog_walking";',
    'export type SchedulingService = "grooming" | "dog_training" | "boarding" | "pet_sitting" | "dog_walking" | "pet_taxi";'
)
replace_once(
    "backend/src/scheduling.ts",
    '  dog_walking: { label:"Dog Walking", durationMinutes:30, bufferMinutes:20, maxOccurrences:12, capacityMode:"appointment" },',
    '  dog_walking: { label:"Dog Walking", durationMinutes:30, bufferMinutes:20, maxOccurrences:12, capacityMode:"appointment" },\n  pet_taxi: { label:"Pet Taxi", durationMinutes:45, bufferMinutes:20, maxOccurrences:1, capacityMode:"appointment" },'
)

# Seed governed UAT Taxi drivers into the existing provider-capacity contract.
provider_path = Path("lib/provider-capacity-governance.ts")
provider_text = provider_path.read_text()
if 'taxi_rahul' not in provider_text:
    marker = '  {id:"walk_asha",cityId:"blr",name:"Asha R.",model:"commission",services:["dog_walking"],zones:["blr-east"],rating:5.0,qualityScore:94,capacity:1,travelBufferMinutes:20,maxDailyJobs:10,acceptanceTimeoutMinutes:3},'
    addition = marker + '\n  {id:"taxi_rahul",cityId:"blr",name:"Rahul K.",model:"full_time",services:["pet_taxi"],zones:["blr-east"],rating:4.9,qualityScore:96,capacity:1,travelBufferMinutes:20,maxDailyJobs:8,acceptanceTimeoutMinutes:3},\n  {id:"taxi_meera",cityId:"blr",name:"Meera S.",model:"full_time",services:["pet_taxi"],zones:["blr-east"],rating:4.8,qualityScore:92,capacity:1,travelBufferMinutes:20,maxDailyJobs:8,acceptanceTimeoutMinutes:3},\n  {id:"taxi_imran",cityId:"blr",name:"Imran A.",model:"full_time",services:["pet_taxi"],zones:["blr-east"],rating:4.9,qualityScore:94,capacity:1,travelBufferMinutes:20,maxDailyJobs:8,acceptanceTimeoutMinutes:3},'
    if marker not in provider_text:
        raise SystemExit("Walking provider seed marker not found")
    provider_path.write_text(provider_text.replace(marker, addition, 1))

replace_once(
    "app/api/uat-scheduling/route.ts",
    'const window=input.serviceCode==="boarding"||input.careMode==="overnight"?"00:00-23:59":input.serviceCode==="dog_walking"?"06:00-21:00":"09:00-19:00";',
    'const window=input.serviceCode==="boarding"||input.careMode==="overnight"?"00:00-23:59":input.serviceCode==="dog_walking"?"06:00-21:00":input.serviceCode==="pet_taxi"?"06:00-22:00":"09:00-19:00";'
)
replace_once(
    "lib/uat-scheduling-client.ts",
    'serviceCode:"grooming"|"dog_training"|"boarding"|"pet_sitting"|"dog_walking";',
    'serviceCode:"grooming"|"dog_training"|"boarding"|"pet_sitting"|"dog_walking"|"pet_taxi";'
)

# Public server quote, authenticated canonical booking.
gateway_path = Path("lib/api-gateway.ts")
gateway = gateway_path.read_text()
if 'url.pathname==="/api/taxi-commercial"' not in gateway:
    gateway = gateway.replace('||url.pathname==="/api/walking-commercial"', '||url.pathname==="/api/walking-commercial"||url.pathname==="/api/taxi-commercial"', 1)
if 'url.pathname==="/api/taxi-bookings"' not in gateway:
    marker = '  if(url.pathname==="/api/walking-bookings")return "scheduling.book";'
    if marker not in gateway:
        raise SystemExit("Walking booking gateway marker not found")
    gateway = gateway.replace(marker, marker + '\n  if(url.pathname==="/api/taxi-bookings")return "scheduling.book";', 1)
gateway_path.write_text(gateway)

Path("app/taxi/page.tsx").write_text('import CanonicalTaxiPage from"./canonical-taxi-page";\nexport default function TaxiPage(){return <CanonicalTaxiPage/>}\n')

print("Pet Taxi Gate 1 shared-platform patch applied")
