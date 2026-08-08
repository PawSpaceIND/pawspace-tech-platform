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
    raise SystemExit("Food branch is not stacked on the Pet Taxi build as expected")

Path("app/food/page.tsx").write_text('import CanonicalFoodPage from"./canonical-food-page";\nexport default function FoodPage(){return <CanonicalFoodPage/>}\n')

gateway_path = Path("lib/api-gateway.ts")
gateway = gateway_path.read_text()
if 'url.pathname==="/api/food-commercial"' not in gateway:
    marker = '||url.pathname==="/api/taxi-commercial"'
    if marker not in gateway:
        raise SystemExit("Taxi public API gateway marker not found")
    gateway = gateway.replace(marker, marker+'||url.pathname==="/api/food-commercial"', 1)
if 'url.pathname==="/api/food-orders"' not in gateway:
    marker = '  if(url.pathname==="/api/taxi-bookings")return "scheduling.book";'
    if marker not in gateway:
        raise SystemExit("Taxi booking gateway marker not found")
    gateway = gateway.replace(marker, marker+'\n  if(url.pathname==="/api/food-orders")return "scheduling.book";', 1)
gateway_path.write_text(gateway)

print("Food Gate 1 app wiring applied")
