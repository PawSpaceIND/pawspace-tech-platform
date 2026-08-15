/**
 * Prove a caller owns the scheduling group they are trying to confirm a booking against.
 *
 * THE VULNERABILITY THIS CLOSES
 * requireCustomerOwnership proves the caller owns the customer id in the REQUEST BODY. It says nothing
 * about the scheduleGroupId in that same body. Nothing else in the booking route compared the two, so a
 * byte-identical valid request with only the scheduleGroupId swapped for a stranger's group was accepted:
 * Customer B got a 201, a real booking, a captured payment and a provider work order — all against
 * Customer A's reserved slot, while A's reservation stayed 'assigned'. The single differing variable was
 * the foreign group.
 *
 * WHERE OWNERSHIP ACTUALLY LIVES
 * scheduling_reservations.customer_id is the only authoritative record of who a scheduling group belongs
 * to. scheduling_assignment_decisions has no customer_id column at all (group_id, strategy, shortlist,
 * selected_provider_id, status, actor_id, reason, updated_at), so it makes no independent ownership claim
 * and there is no second source that could disagree. The reservation rows are therefore the whole answer.
 *
 * WHY "no rows" IS NOT A VIOLATION
 * A group with no reservations is not a stolen group, it is an absent one. Returning 403 there would leak
 * which group ids exist and would also relabel the route's existing, correct 409 ("a valid provider
 * reservation is required") as an authority failure. So this reports notFound and the caller keeps its
 * existing conflict handling; only a group that demonstrably belongs to somebody else is a refusal.
 *
 * WHY IT REFUSES RATHER THAN COMPENSATES
 * This is an authority failure, not a failed booking of the caller's own. The victim's hold must be left
 * exactly as it was - no release, no mutation of any kind - so the guard runs BEFORE the compensation
 * path is even reachable and simply refuses.
 */

type Db = D1Database;

export type SchedulingGroupOwnership =
  | { state: "owned" }
  /** The group exists and belongs to a different customer. The only case that is a 403. */
  | { state: "foreign" }
  /** No reservation rows for this group. Not an ownership failure; let existing 409 handling run. */
  | { state: "notFound" };

/**
 * Read-only. Performs no mutation of any kind, so a refused caller cannot change a victim's state
 * merely by probing.
 */
export async function schedulingGroupOwnership(
  db: Db,
  input: { groupId: string; customerId: string },
): Promise<SchedulingGroupOwnership> {
  if (!input.groupId || !input.customerId) return { state: "notFound" };
  const rows = await db
    .prepare("SELECT DISTINCT customer_id FROM scheduling_reservations WHERE group_id=?")
    .bind(input.groupId)
    .all<{ customer_id: string }>();
  const owners = rows.results.map((row) => String(row.customer_id));
  if (!owners.length) return { state: "notFound" };
  // Every reservation in the group must belong to this caller. A group whose rows disagree with each
  // other is also refused: it is not unambiguously the caller's, and confirming it could commit
  // somebody else's slot.
  return owners.every((owner) => owner === input.customerId) ? { state: "owned" } : { state: "foreign" };
}
