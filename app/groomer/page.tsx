import { redirect } from "next/navigation";

/**
 * RETIRED ROUTE — the standalone Groomer screen that used to live here was a hardcoded prototype:
 * its jobs, customers, pets, amounts and earnings were a literal array in this file, "Complete"
 * only moved React state (nothing was written to the database, no booking closed, no payout moved)
 * and the proof photos were counted in the browser but never uploaded. It was never linked from the
 * live app and is superseded by the real Partner App workspace, which reads and writes the canonical
 * grooming lifecycle, governed proof media and computed earnings.
 *
 * app/prelaunch/page.tsx has listed this route as retired for some time; this makes that real so a
 * tester who types the URL can no longer mistake a mock for the product.
 */
export default function RetiredGroomerWorkspace() {
  redirect("/partner-app");
}
