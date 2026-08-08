from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if new in text:
        return
    if old not in text:
        raise SystemExit(f"patch marker not found in {path}: {old[:140]}")
    file.write_text(text.replace(old, new, 1))


# Customer confirmation reaches canonical management.
replace_once(
    "app/food/canonical-food-page.tsx",
    '<button onClick={()=>setOrder(null)}>Back to UAT catalogue</button>',
    '<Link href={`/food/manage?orderId=${encodeURIComponent(order.orderId)}`}>Manage order</Link><button onClick={()=>setOrder(null)}>Back to UAT catalogue</button>'
)

# Customer management includes governed quality incidents.
Path("app/food/manage/page.tsx").write_text('import FoodCustomerManagement from"./food-customer-management";\nimport FoodCustomerIncidents from"./food-customer-incidents";\nexport default async function FoodManagePage({searchParams}:{searchParams:Promise<{orderId?:string}>}){const params=await searchParams,orderId=String(params.orderId||"");return <><FoodCustomerManagement orderId={orderId}/><div style={{maxWidth:920,margin:"0 auto",padding:"0 28px 28px"}}><FoodCustomerIncidents orderId={orderId}/></div></>}\n')

# Gateway authority for fulfilment, Finance, proof and Ops.
path = "lib/api-gateway.ts"
gateway = Path(path).read_text()
marker = '  if(url.pathname==="/api/food-orders")return "scheduling.book";'
addition = marker+'\n  if(url.pathname==="/api/food-fulfilment"){if(method==="GET")return url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view";return "bookings.manage";}\n  if(url.pathname==="/api/food-finance"){if(method==="GET")return "finance.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return String(body.action)==="request_cancel"?"scheduling.book":"finance.manage";}\n  if(url.pathname==="/api/food-proof"){if(method==="GET")return url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return String(body.action)==="acknowledge_incident"?"scheduling.book":"bookings.manage";}\n  if(url.pathname==="/api/food-ops")return method==="GET"?"bookings.view":"bookings.manage";'
if addition not in gateway:
    if marker not in gateway:
        raise SystemExit("Food order gateway marker not found")
    gateway = gateway.replace(marker, addition, 1)
Path(path).write_text(gateway)

# Direct Team navigation.
for path, href, label in [
    ("app/team/operations/page.tsx", "/team/operations/food", "Open Food Operations exception queue ->"),
    ("app/team/finance/page.tsx", "/team/finance/food", "Open Food Finance workspace ->"),
]:
    file = Path(path)
    text = file.read_text()
    if href not in text:
        marker = "</main>"
        if marker not in text:
            raise SystemExit(f"main closing marker not found in {path}")
        text = text.replace(marker, f'<p><a href="{href}">{label}</a></p>'+marker, 1)
        file.write_text(text)

print("Food cross-gate closure patch applied")
