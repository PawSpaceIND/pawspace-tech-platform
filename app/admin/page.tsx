import { redirect } from "next/navigation";

/**
 * RETIRED ROUTE — a fabricated admin dashboard. Neither this page nor its four sub-panels read the
 * database: it claimed a day of takings, a rating, a customer-count badge and a list of
 * today's bookings, while the boarding, food, mobility and workforce panels each invented their
 * own quality scores, order counts, completion rates and payroll totals.
 *
 * Everything it depicted exists for real elsewhere: /team is the governed staff front door with live
 * counters, /team/operations covers bookings and delivery per vertical, /team/finance covers
 * collections and settlement, and /control holds the founder and system controls.
 */
export default function RetiredAdminDashboard() {
  redirect("/team");
}
