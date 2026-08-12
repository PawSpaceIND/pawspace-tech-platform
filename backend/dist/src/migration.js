import { createHash } from "node:crypto";
const normalizePhone = (value) => String(value ?? "").replace(/\D/g, "").slice(-10);
export function analyseLegacyCollections(collections) {
    const findings = [];
    const allPhones = new Map();
    for (const collection of collections) {
        if (!collection.fields.includes("_id"))
            findings.push({ severity: "blocker", code: "MISSING_LEGACY_ID", collection: collection.name, message: "Legacy identifiers must be preserved", affected: collection.documentCount });
        if (!collection.indexes?.some(index => index.toLowerCase().includes("phone")))
            findings.push({ severity: "warning", code: "PHONE_INDEX_MISSING", collection: collection.name, message: "No phone index was reported", affected: collection.documentCount });
        let missingPhone = 0;
        for (const document of collection.sampleDocuments) {
            const phone = normalizePhone(document.primaryPhone ?? document.phone ?? document.mobile);
            if (!phone) {
                missingPhone++;
                continue;
            }
            const key = `${phone}`;
            allPhones.set(key, [...(allPhones.get(key) ?? []), `${collection.name}:${String(document._id ?? "unknown")}`]);
        }
        if (missingPhone)
            findings.push({ severity: "warning", code: "PHONE_MISSING", collection: collection.name, message: "Sample records without a usable phone number", affected: missingPhone });
    }
    for (const [phone, records] of allPhones) {
        if (records.length > 1)
            findings.push({ severity: "blocker", code: "DUPLICATE_CUSTOMER_PHONE", collection: "cross_collection", message: `Phone hash ${createHash("sha256").update(phone).digest("hex").slice(0, 10)} occurs in ${records.length} records`, affected: records.length });
    }
    const totals = { collections: collections.length, documents: collections.reduce((sum, x) => sum + x.documentCount, 0), samples: collections.reduce((sum, x) => sum + x.sampleDocuments.length, 0), blockers: findings.filter(x => x.severity === "blocker").length, warnings: findings.filter(x => x.severity === "warning").length };
    return { status: totals.blockers ? "blocked" : "ready_for_rehearsal", totals, findings, recommendations: ["Preserve every legacy _id in legacyIds", "Create canonical customer and pet IDs", "Reconcile counts, GMV, active subscriptions and unused credits", "Use controlled dual-write before cutover"] };
}
