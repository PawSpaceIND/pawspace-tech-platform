import type { Db } from "mongodb";
import type { PlatformRepository } from "./domain.js";

type MongoBackedRepository = PlatformRepository & { db?: Db };
type SequenceRow = { _id: string; next: number };

const memorySequences = new WeakMap<object, Map<number, number>>();
const indexedRepositories = new WeakSet<object>();

async function ensureMongoInvoiceConstraints(repository: object, db: Db) {
  if (indexedRepositories.has(repository)) return;
  const invoices = db.collection("tax_invoices");
  await Promise.all([
    invoices.createIndex({ invoiceNumber: 1 }, { unique: true, name: "uniq_tax_invoices_invoice_number" }),
    invoices.createIndex({ bookingId: 1 }, { unique: true, name: "uniq_tax_invoices_booking_id" }),
  ]);
  indexedRepositories.add(repository);
}

/**
 * Allocate a monotonic invoice number. Mongo-backed repositories use a single-document
 * atomic $inc counter and unique indexes on both invoice number and booking. In-memory
 * repositories use a repository-scoped counter so certification exercises the same
 * numbering shape without touching an external database.
 */
export async function allocateInvoiceNumber(repository: PlatformRepository, issuedAt = new Date()) {
  const year = issuedAt.getUTCFullYear();
  const repositoryObject = repository as object;
  const db = (repository as unknown as MongoBackedRepository).db;

  if (db) {
    await ensureMongoInvoiceConstraints(repositoryObject, db);
    const counter = await db.collection<SequenceRow>("finance_sequences").findOneAndUpdate(
      { _id: `tax_invoice:${year}` },
      { $inc: { next: 1 } },
      { upsert: true, returnDocument: "after" },
    );
    if (!counter || !Number.isSafeInteger(counter.next) || counter.next < 1) {
      throw new Error("Unable to allocate GST invoice sequence");
    }
    return `PS/${year}/${String(counter.next).padStart(8, "0")}`;
  }

  let byYear = memorySequences.get(repositoryObject);
  if (!byYear) {
    byYear = new Map<number, number>();
    memorySequences.set(repositoryObject, byYear);
  }
  const next = (byYear.get(year) ?? 0) + 1;
  byYear.set(year, next);
  return `PS/${year}/${String(next).padStart(8, "0")}`;
}

export function isDuplicateKeyError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && Number((error as { code?: unknown }).code) === 11000;
}
