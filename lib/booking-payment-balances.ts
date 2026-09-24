import { resolvePaymentStageAmount, type PaymentStageAmount } from './payment-stage-amount';
import { readPaymentStageSnapshots } from './payment-stage-snapshot';

/** Same consistent monetary snapshot and calculation used by customer checkout. */
export async function bookingPaymentBalances(db: Pick<D1Database, "prepare">, bookingIds: string[], options: { includePaymentMetadata?: boolean } = {}): Promise<Map<string, PaymentStageAmount & { paymentMethod?: string; paymentMode?: string }>> {
  const snapshots = await readPaymentStageSnapshots(db, bookingIds, options), out = new Map<string, PaymentStageAmount & { paymentMethod?: string; paymentMode?: string }>();
  for (const [id, row] of snapshots) out.set(id, { ...resolvePaymentStageAmount(row.payment, row.schedule, row.credits, row.recon), ...(options.includePaymentMetadata ? { paymentMethod: String(row.payment.method || ""), paymentMode: String(row.payment.mode || "") } : {}) });
  return out;
}
