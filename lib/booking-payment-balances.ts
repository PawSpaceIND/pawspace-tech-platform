import { resolvePaymentStageAmount, type PaymentStageAmount } from './payment-stage-amount';
import { readPaymentStageSnapshots } from './payment-stage-snapshot';

/** Same consistent monetary snapshot and calculation used by customer checkout. */
export async function bookingPaymentBalances(db: Pick<D1Database, "prepare">, bookingIds: string[]): Promise<Map<string, PaymentStageAmount>> {
  const snapshots = await readPaymentStageSnapshots(db, bookingIds), out = new Map<string, PaymentStageAmount>();
  for (const [id, row] of snapshots) out.set(id, resolvePaymentStageAmount(row.payment, row.schedule, row.credits, row.recon));
  return out;
}
