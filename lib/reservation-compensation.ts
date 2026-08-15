/**
 * Release a scheduling hold when the booking it was made for is refused.
 *
 * THE BUG THIS FIXES
 * Reserve and confirm are two separate requests. Reserve writes durable, capacity-consuming rows into
 * scheduling_reservations (status 'assigned'). Confirm then re-validates price, commercial policy,
 * provider, city/zone - and on refusal simply returned 4xx and walked away. The reservation stayed
 * 'assigned' forever: there is no expiry column and no sweep (proven by
 * tests/reservation-capacity-release.test.mjs), so the provider's slot stayed consumed even though no
 * booking existed and no money had moved. Tester 3 hit this twice on the release candidate - a
 * Bengaluru price mismatch and a Chennai booking with no commercial policy - and both stranded real
 * capacity.
 *
 * WHY COMPENSATION AND NOT A TRANSACTION
 * The reservation and the booking are written by two different HTTP requests, so no single database
 * transaction can span them - db.batch() cannot help here. (This is a genuinely different failure mode
 * from the intra-request crash window: that one is about two writes inside ONE request.) Moving the
 * price check earlier is not release-safe either: reserve does not receive a package or a price at
 * all, so validating there would mean changing the reserve contract. Compensating on the refusal path
 * is the smallest change that actually returns the capacity, and it returns it immediately rather than
 * after some future TTL.
 *
 * THE OWNERSHIP INVARIANT - THE REASON THIS FUNCTION TAKES A customerId
 * A release is destructive: it frees somebody's slot. The booking route proves, via
 * requireCustomerOwnership, that the caller owns input.customer.id - but it does NOT prove the caller
 * owns input.scheduleGroupId. Nothing in that route compares a reservation's customer_id to the
 * caller's customer at all. So a release scoped only by group_id would hand any authenticated customer
 * a way to free a stranger's hold: send a deliberately-failing booking quoting the victim's group, and
 * the cleanup does the damage. That is a worse bug than the one being fixed.
 *
 * So the WHERE clause is scoped by BOTH group_id AND customer_id, and the customerId passed in must be
 * the one that has already cleared requireCustomerOwnership. An attacker quoting a victim's group with
 * their own (legitimately owned) customer id matches zero rows and mutates nothing. This function
 * cannot be made unsafe by calling it in the wrong place, because the scope travels with the query.
 *
 * Callers must therefore never pass a customer id taken straight from the request body without having
 * proven ownership of it first.
 */

type Db = D1Database;

export type CompensationOutcome = {
  /** Rows actually moved to 'cancelled'. 0 is normal (nothing held) AND is what an attacker sees. */
  released: number;
  /** False only when the cleanup itself failed. Never claim capacity is free when it may not be. */
  ok: boolean;
  /** Present only on failure, for the operator - not for the client. */
  error?: string;
};

/**
 * Cancel any still-active reservations for this group that belong to this customer.
 *
 * Idempotent: `status!='cancelled'` means a second call releases nothing and reports released:0, so a
 * retried or replayed refusal cannot double-release or resurrect a hold.
 *
 * Never throws. A refusal is already being returned to the caller; a failure to clean up must not be
 * converted into a 500 that hides the real reason the booking was refused. Instead it is logged and
 * reported honestly in the return value so the caller can tell the client the truth.
 */
export async function releaseReservationForRefusedBooking(
  db: Db,
  input: { groupId: string; ownershipProvenCustomerId: string },
): Promise<CompensationOutcome> {
  if (!input.groupId || !input.ownershipProvenCustomerId) return { released: 0, ok: true };
  try {
    const held = await db
      .prepare("SELECT COUNT(*) count FROM scheduling_reservations WHERE group_id=? AND customer_id=? AND status!='cancelled'")
      .bind(input.groupId, input.ownershipProvenCustomerId)
      .first<{ count: number }>();
    const count = Number(held?.count || 0);
    if (!count) return { released: 0, ok: true };
    await db
      .prepare("UPDATE scheduling_reservations SET status='cancelled' WHERE group_id=? AND customer_id=? AND status!='cancelled'")
      .bind(input.groupId, input.ownershipProvenCustomerId)
      .run();
    return { released: count, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "reservation compensation failed";
    console.error("[booking] failed to release reservation after refused booking:", input.groupId, message);
    return { released: 0, ok: false, error: message };
  }
}
