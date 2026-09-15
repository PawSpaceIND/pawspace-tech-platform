import OpsShell from"../../components/ops-shell/OpsShell";
import StaffHubWorkspaceLinks, { type HubWorkspaceLink } from "../../components/hub-workspace-links";
import styles from "../team-console.module.css";

/**
 * The per-service exception queues.
 *
 * R3-G / F4: these six were a plain hardcoded array rendered to everybody - associate, provider,
 * customer, both OTP sessions and a signed-out visitor - while every one of their destinations is
 * gated at bookings.manage, which none of those actors holds. That produced 49 of the 60
 * offered-then-refused combinations found across the platform, and it sat directly above the
 * "Operations workspaces" section below, which IS filtered and says so in its own note. One page
 * cannot both filter its links and not filter them.
 *
 * They are now the same HubWorkspaceLink shape, gated by the same filter, as every other hub list.
 * The permission on each entry is the one its API enforces: /api/booking-command-center,
 * /api/boarding-ops, /api/sitting-ops, /api/walking-ops, /api/food-ops and /api/taxi-ops are all
 * bookings.manage.
 */
export const operationsWorkspaceLinks: HubWorkspaceLink[] = [
  { href: "/team/operations/bookings", label: "Booking Command Center", detail: "All canonical bookings, providers, payments, tickets and operational events.", permission: "bookings.manage" },
  { href: "/team/operations/boarding", label: "Boarding exception queue", detail: "Host recovery, care incidents, finance review, proof/media blockers and settlement readiness.", permission: "bookings.manage" },
  { href: "/team/operations/sitting", label: "Sitting exception queue", detail: "Sitter recovery, care incidents, finance review, proof/media blockers and service-timing exceptions.", permission: "bookings.manage" },
  { href: "/team/operations/walking", label: "Walking exception queue", detail: "Walker recovery, route evidence, safety incidents, completed-payment dues and settlement blockers.", permission: "bookings.manage" },
  // Both of these hung off a single fragile edge: /team/operations/food was linked only from its own
  // two children (the supply-chain and proof screens beneath it) and /team/operations/taxi only from
  // app/driver/canonical-driver-page.tsx, the DRIVER's workspace. Neither counted as an orphan, and
  // neither was reachable from the hub that owns it. They read /api/food-ops and /api/taxi-ops, which
  // the gateway gates at bookings.manage - the same permission as the boarding, sitting and walking
  // queues beside them, so they sit here on exactly the same terms as their neighbours.
  { href: "/team/operations/food", label: "Fresh Food exception queue", detail: "Order exceptions, stock recovery, delivery proof, incidents and refund review for Fresh Food.", permission: "bookings.manage" },
  { href: "/team/operations/taxi", label: "Taxi exception queue", detail: "Driver recovery and replacement, route evidence, trip incidents, refund review and settlement blockers.", permission: "bookings.manage" },
  /*
   * The operations workspaces that are not a per-service exception queue. None of them was linked
   * from anywhere: the cross-service exception work queue, Training operations, the Fresh Food supply
   * chain, and the Relocation and Funeral coordination queues were reachable only by typing the URL,
   * which for a work queue means the work simply was not picked up.
   *
   * Each permission is the one its API enforces: /api/ops-work-queue, /api/training-ops and
   * /api/food-supply-chain all require bookings.manage, while /api/relocation and
   * /api/funeral-memorial are staff booking reads at bookings.view. They share ONE gated section
   * with the queues above because a hub that filters half its links and not the other half is the
   * defect this page was fixed for.
   */
  { href: "/team/operations/work-queue", label: "Exception work queue", detail: "The cross-service queue of operational exceptions, with assignment and closure evidence.", permission: "bookings.manage" },
  { href: "/team/operations/training", label: "Training operations", detail: "Dog Training sessions, provider replacement, rescheduling and session evidence.", permission: "bookings.manage" },
  { href: "/team/operations/food/supply-chain", label: "Fresh Food supply chain", detail: "Kitchen batches, stock and fulfilment readiness behind Fresh Food orders.", permission: "bookings.manage" },
  { href: "/team/relocation", label: "Relocation coordination", detail: "Vendor, document, quote and milestone control for a relocation case.", permission: "bookings.view" },
  { href: "/team/funeral-memorial", label: "Funeral & memorial queue", detail: "Urgent request queue, milestone coordination, service configuration and the summary report.", permission: "bookings.view" },
];

export default function TeamOperations() {
  return <OpsShell
      eyebrow="PAWSPACE TEAM · OPERATIONS"
      title="Operations control"
      description="Open the canonical cross-service Booking Command Center, or a service-specific exception and recovery queue."
      >

    <StaffHubWorkspaceLinks heading="Operations workspaces" note="The canonical Booking Command Center, the per-service exception and recovery queues, and the cross-service workspaces. Only the workspaces your role can open are listed." links={operationsWorkspaceLinks} />

    <footer className={styles.footnote}>UAT controlled. Live integrations and production credentials remain disabled.</footer>
  </OpsShell>;
}
