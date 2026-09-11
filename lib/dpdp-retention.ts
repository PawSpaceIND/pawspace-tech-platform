import { eraseCustomerPersonalData } from "./dpdp-erasure";

type Db = D1Database;
type Row = Record<string, unknown>;
const THREE_YEARS = 3;
const BATCH_SIZE = 100;

export function dpdpRetentionCutoff(asOf = Date.now()) {
  const cutoff = new Date(asOf);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - THREE_YEARS);
  return cutoff.getTime();
}

async function hash(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}

export async function runDpdpRetentionSweep(db: Db, input: { asOf?: number; requestedBy?: string } = {}) {
  const asOf = input.asOf ?? Date.now();
  const cutoff = dpdpRetentionCutoff(asOf);
  const requestedBy = input.requestedBy ?? "system:dpdp-retention";
  let cursor = "", examined = 0, erased = 0;

  for (;;) {
    const candidates = await db.prepare(`
      SELECT c.id customer_id,
        CASE WHEN COALESCE(MAX(b.updated_at),0)>c.updated_at THEN COALESCE(MAX(b.updated_at),0) ELSE c.updated_at END last_activity_at
      FROM crm_contacts c
      LEFT JOIN canonical_bookings b ON b.customer_id=c.id
      WHERE c.id>? AND c.updated_at<? AND c.primary_phone NOT LIKE 'ERASED-%'
      GROUP BY c.id,c.updated_at
      HAVING last_activity_at<?
      ORDER BY c.id LIMIT ?
    `).bind(cursor, cutoff, cutoff, BATCH_SIZE).all<Row>();
    if (!candidates.results.length) break;
    for (const candidate of candidates.results) {
      const customerId = String(candidate.customer_id || "");
      cursor = customerId;
      if (!customerId) continue;
      examined++;
      const key = `retention-v1:${await hash(customerId)}`;
      const result = await eraseCustomerPersonalData(db, {
        customerId, idempotencyKey: key, requestedBy,
        reason: "DPDP retention: no CRM or canonical booking activity for more than 3 years", now: asOf,
      });
      if (result.status === "COMPLETED") erased++;
    }
    if (candidates.results.length < BATCH_SIZE) break;
  }
  return { status: "completed", cutoff, examined, erased, ledgerPreserved: true };
}
