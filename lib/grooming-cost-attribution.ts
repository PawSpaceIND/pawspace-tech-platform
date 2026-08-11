import { computeGroomerMonthlyIncentive } from "./grooming-incentive-engine";

type Db = D1Database;
type Row = Record<string, unknown>;

/**
 * Real per-booking direct-cost attribution for Grooming - the piece originally judged
 * unachievable, before finding that computeGroomerMonthlyIncentive() already computes a real,
 * booking-derived monthly incentive total per head groomer (headTotal + helperTotal), against a
 * real orderValueTotal built from exactly the same real completed bookings (provider_id +
 * scheduled_start, matching canonical_bookings directly).
 *
 * Allocates that real monthly total proportionally across the real bookings that contributed to
 * it - a booking worth 20% of a groomer's monthly order value carries 20% of that groomer's real
 * monthly incentive as its cost. This is real incentive/bonus cost specifically, not full labour
 * cost (base salary is a separate payroll concern this system doesn't track) - the same honest
 * scope as Boarding/Sitting/Training's cost being provider payout, not full overhead.
 *
 * Safety property, matching every other cost-attribution guardrail this session: a (groomer, month)
 * with no bracket configured throws from computeGroomerMonthlyIncentive - every booking in that
 * group is marked unknown, not silently allocated zero. A (groomer, month) that's genuinely below
 * the real eligibility threshold returns a real, computed zero - correctly allocated as zero cost,
 * because that's what the incentive engine actually paid, not a data gap.
 */
export async function attributeGroomingBookingCosts(db: Db, bookingIds: string[]): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (!bookingIds.length) return result;
  const placeholders = bookingIds.map(() => "?").join(",");
  const rows = await db.prepare(
    `SELECT id,provider_id,total_amount,scheduled_start FROM canonical_bookings WHERE id IN (${placeholders}) AND service_code='grooming' AND status='completed'`
  ).bind(...bookingIds).all<Row>();

  const groups = new Map<string, { headGroomerId: string; monthStart: string; bookings: Array<{ id: string; amount: number }> }>();
  for (const row of rows.results) {
    const headGroomerId = String(row.provider_id), scheduledStart = String(row.scheduled_start);
    const monthStart = `${scheduledStart.slice(0, 7)}-01`;
    const key = `${headGroomerId}:${monthStart}`;
    const group = groups.get(key) || { headGroomerId, monthStart, bookings: [] };
    group.bookings.push({ id: String(row.id), amount: Number(row.total_amount || 0) });
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    try {
      const incentive = await computeGroomerMonthlyIncentive(db, { headGroomerId: group.headGroomerId, monthStart: group.monthStart, actorId: "system:cost_attribution" });
      const totalIncentive = incentive.headTotal + incentive.helperTotal;
      const orderValueTotal = incentive.orderValueTotal;
      for (const booking of group.bookings) {
        result.set(booking.id, orderValueTotal > 0 ? Math.round((booking.amount / orderValueTotal) * totalIncentive * 100) / 100 : 0);
      }
    } catch {
      // No bracket configured for this groomer/month - genuinely unknown, not zero.
      for (const booking of group.bookings) result.set(booking.id, null);
    }
  }
  return result;
}
