import { authError } from "../../../../lib/server-auth";
import { ensurePricingControlRuntime } from "../../../../lib/pricing-control-runtime";
import { groomingCommercialPackages } from "../../../../lib/grooming-commercial-catalogue";

type Row = Record<string, unknown>;

type Bundle = {
  petCount: number;
  packageCode: string;
  price: number;
  currency: string;
  slotMinutes: number;
  blockingMinutes: number;
  effectiveFrom: string;
  effectiveTo: string | null;
};

type CataloguePackage = {
  code: string;
  name: string;
  description: string;
  audience: "dog" | "cat" | "young";
  bundles: Bundle[];
};

const multiPetSuffix = /__(\d+)_pets$/;

function baseCode(packageCode: string) {
  return packageCode.replace(multiPetSuffix, "");
}

function petCount(packageCode: string) {
  const match = multiPetSuffix.exec(packageCode);
  return match ? Number(match[1]) : 1;
}

function audienceFor(code: string): CataloguePackage["audience"] | null {
  if (code.startsWith("dog-")) return "dog";
  if (code.startsWith("cat-")) return "cat";
  if (code.startsWith("young-")) return "young";
  return null;
}

function publicName(name: string) {
  return name.replace(/\s*·\s*\d+\s+pets$/i, "").trim();
}

const commercialIncludes = new Map(groomingCommercialPackages.map(item => [item.code, item.included]));

/**
 * Seeded rows carry an internal note ("Canonical Grooming price for …") as their description. Customers see
 * what the package includes from the approved commercial catalogue instead; an operator-written description wins.
 */
function operatorDescription(stored: unknown, code: string) {
  const text = String(stored || "").trim();
  return text && !/^canonical\b/i.test(text) && !seededDescription(code, text) ? text : null;
}

/** Pricing Control seeds rows with this same catalogue copy ("For 2 pets, each groomed in full. Includes …"); it is not operator-written. */
function seededDescription(code: string, text: string) {
  const included = commercialIncludes.get(code);
  return Boolean(included?.length) && text.replace(/^For \d+ pets, each groomed in full\.\s*/, "") === `Includes ${included!.join(", ")}.`;
}

function customerDescription(code: string, stored: unknown) {
  const written = operatorDescription(stored, code);
  if (written) return written;
  const included = commercialIncludes.get(code);
  return included?.length ? `Includes ${included.join(", ")}.` : "Professional doorstep grooming by PawSpace.";
}

/**
 * Customer-safe V2 catalogue projection.
 *
 * Important: V2 deliberately exposes ONLY operator-published (active) package rows. The old customer
 * UI carried its own fallback catalogue and therefore silently remained a second pricing authority.
 * V2 fails closed instead: if Pricing Control has not published an exact package/bundle, the customer
 * cannot select it here. Exact slot pricing is still resolved later by /api/live-price-quote.
 */
export async function GET() {
  try {
    const { env } = await import("cloudflare:workers");
    const db = env.DB;
    await ensurePricingControlRuntime(db);

    const result = await db.prepare(
      "SELECT package_code,name,description,base_price,currency,slot_minutes,blocking_minutes,effective_from,effective_to FROM service_packages WHERE service_code='grooming' AND active=1 ORDER BY package_code",
    ).all<Row>();

    const grouped = new Map<string, CataloguePackage>(), singleWritten = new Set<string>();
    for (const row of result.results) {
      const packageCode = String(row.package_code || "");
      const code = baseCode(packageCode);
      const audience = audienceFor(code);
      const count = petCount(packageCode);
      if (!audience || !code || !Number.isInteger(count) || count < 1 || count > 4) continue;

      const bundle: Bundle = {
        petCount: count,
        packageCode,
        price: Number(row.base_price || 0),
        currency: String(row.currency || "INR"),
        slotMinutes: Number(row.slot_minutes || 0),
        blockingMinutes: Number(row.blocking_minutes || 0),
        effectiveFrom: String(row.effective_from || ""),
        effectiveTo: row.effective_to ? String(row.effective_to) : null,
      };
      if (!Number.isFinite(bundle.price) || bundle.price <= 0 || bundle.slotMinutes <= 0) continue;

      const current = grouped.get(code) || {
        code,
        name: publicName(String(row.name || code)),
        description: customerDescription(code, row.description),
        audience,
        bundles: [],
      };
      // Any bundle row may carry the operator's description; the single-pet row's wins when both do.
      const written = operatorDescription(row.description, code);
      if (written && (count === 1 || !singleWritten.has(code))) {
        current.description = written;
        if (count === 1) singleWritten.add(code);
      }
      current.bundles.push(bundle);
      grouped.set(code, current);
    }

    const packages = [...grouped.values()]
      .map(item => ({ ...item, bundles: item.bundles.sort((a, b) => a.petCount - b.petCount) }))
      .filter(item => item.bundles.some(bundle => bundle.petCount === 1));

    return Response.json(
      { data: { serviceCode: "grooming", packages } },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return authError(error, "Unable to load the grooming catalogue");
  }
}
