import Link from "next/link";
import OpsShell from"../../components/ops-shell/OpsShell";
import StaffHubWorkspaceLinks, { type HubWorkspaceLink } from "../../components/hub-workspace-links";
import styles from "../team-console.module.css";

const QUEUES = [
  { href: "/team/operations/bookings", title: "Booking Command Center", body: "All canonical bookings, providers, payments, tickets and operational events." },
  { href: "/team/operations/boarding", title: "Boarding exception queue", body: "Host recovery, care incidents, finance review, proof/media blockers and settlement readiness." },
  { href: "/team/operations/sitting", title: "Sitting exception queue", body: "Sitter recovery, care incidents, finance review, proof/media blockers and service-timing exceptions." },
  { href: "/team/operations/walking", title: "Walking exception queue", body: "Walker recovery, route evidence, safety incidents, completed-payment dues and settlement blockers." },
  // Both of these hung off a single fragile edge: /team/operations/food was linked only from its own
  // two children (the supply-chain and proof screens beneath it) and /team/operations/taxi only from
  // app/driver/canonical-driver-page.tsx, the DRIVER's workspace. Neither counted as an orphan, and
  // neither was reachable from the hub that owns it. They read /api/food-ops and /api/taxi-ops, which
  // the gateway gates at bookings.manage - the same permission as the boarding, sitting and walking
  // queues beside them, so they sit here on exactly the same terms as their neighbours.
  { href: "/team/operations/food", title: "Fresh Food exception queue", body: "Order exceptions, stock recovery, delivery proof, incidents and refund review for Fresh Food." },
  { href: "/team/operations/taxi", title: "Taxi exception queue", body: "Driver recovery and replacement, route evidence, trip incidents, refund review and settlement blockers." },
];

/**
 * The operations workspaces that are not a per-service exception queue. None of them was linked
 * from anywhere: the cross-service exception work queue, Training operations, the Fresh Food supply
 * chain, and the Relocation and Funeral coordination queues were reachable only by typing the URL,
 * which for a work queue means the work simply was not picked up.
 *
 * Each permission is the one its API enforces: /api/ops-work-queue, /api/training-ops and
 * /api/food-supply-chain all require bookings.manage, while /api/relocation and
 * /api/funeral-memorial are staff booking reads at bookings.view.
 */
export const operationsWorkspaceLinks: HubWorkspaceLink[] = [
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

    <section className={styles.cardGrid}>
      {QUEUES.map((queue) => <Link key={queue.href} href={queue.href} className={styles.linkCard}>
        <h2>{queue.title}</h2>
        <p>{queue.body}</p>
        <span className={styles.linkCue}>Open →</span>
      </Link>)}
    </section>

    <StaffHubWorkspaceLinks heading="Operations workspaces" note="Cross-service queues and the service lines that do not have an exception queue of their own. Only the workspaces your role can open are listed." links={operationsWorkspaceLinks} />

    <footer className={styles.footnote}>UAT controlled. Live integrations and production credentials remain disabled.</footer>
  </OpsShell>;
}
