import { MongoClient } from "mongodb";
import { financeUatDeploymentMatches } from "./finance-uat-auth.js";

const FINANCE_UAT_DATABASE = "pawspace_finance_uat";

const canonicalUatGroomingPrice = {
  id: "price_blr_essential",
  cityId: "blr",
  serviceCode: "grooming",
  packageCode: "essential_bath",
  name: "Essential Bath",
  amount: 1349,
  currency: "INR",
  taxInclusive: true,
  active: true,
};

const canonicalUatProvider = {
  id: "pro_arjun",
  cityId: "blr",
  name: "Arjun Kumar",
  model: "full_time",
  services: ["grooming"],
  zones: ["blr-east"],
  live: true,
  rating: 4.8,
  qualityScore: 94,
  capacity: 1,
  travelBufferMinutes: 30,
  maxDailyJobs: 4,
};

/**
 * Seeds only the isolated Finance UAT Mongo database, and only when the exact
 * Finance preview is running. Production, staging and all other previews are
 * intentionally excluded by financeUatDeploymentMatches().
 *
 * The price/provider values mirror the backend's existing canonical Test
 * fixtures; the Essential Bath amount also matches the governed PawSpace
 * grooming catalogue. Existing active UAT grooming prices are never replaced.
 */
export async function bootstrapFinanceUatReferenceData(env: NodeJS.ProcessEnv = process.env) {
  if (!financeUatDeploymentMatches(env)) return { seededPrice: false, seededProvider: false };
  if (String(env.MONGODB_DATABASE ?? "").trim() !== FINANCE_UAT_DATABASE) {
    throw new Error("Finance UAT bootstrap refused a non-isolated Mongo database");
  }
  const uri = String(env.MONGODB_URI ?? "").trim();
  if (uri.length < 16) throw new Error("Finance UAT bootstrap requires MONGODB_URI");

  const client = new MongoClient(uri, { maxPoolSize: 2, minPoolSize: 0, retryWrites: true });
  await client.connect();
  try {
    const db = client.db(FINANCE_UAT_DATABASE);
    const prices = db.collection("city_prices");
    const providers = db.collection("providers");

    const activeGroomingPrices = await prices.countDocuments({ cityId: "blr", serviceCode: "grooming", active: true });
    let seededPrice = false;
    if (activeGroomingPrices === 0) {
      await prices.updateOne(
        { id: canonicalUatGroomingPrice.id },
        { $set: canonicalUatGroomingPrice },
        { upsert: true },
      );
      seededPrice = true;
    }

    const existingProvider = await providers.findOne({ id: canonicalUatProvider.id });
    let seededProvider = false;
    if (!existingProvider) {
      await providers.insertOne(canonicalUatProvider);
      seededProvider = true;
    } else if (
      existingProvider.cityId !== "blr"
      || existingProvider.live !== true
      || !Array.isArray(existingProvider.services)
      || !existingProvider.services.includes("grooming")
      || !Array.isArray(existingProvider.zones)
      || !existingProvider.zones.includes("blr-east")
    ) {
      await providers.updateOne({ id: canonicalUatProvider.id }, { $set: canonicalUatProvider });
      seededProvider = true;
    }

    return { seededPrice, seededProvider };
  } finally {
    await client.close();
  }
}
