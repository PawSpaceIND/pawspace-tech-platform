import styles from "./provider-tracking-card.module.css";

type ProviderRole = "Groomer" | "Trainer" | "Sitter";

export default function ProviderTrackingCard({
  role,
  name,
  eta = "18 min",
}: {
  role: ProviderRole;
  name: string;
  eta?: string;
}) {
  return (
    <article className={styles.card} data-provider-tracking={role.toLowerCase()}>
      <div className={styles.map} aria-label={`${role} UAT tracking placeholder`}>
        <span>A</span>
        <i>{role === "Groomer" ? "✦" : role === "Trainer" ? "⌁" : "♡"}</i>
        <span>B</span>
      </div>
      <div className={styles.copy}>
        <small>LOCATION SHARING · NOT CONNECTED IN UAT</small>
        <b>{name} is assigned to this booking</b>
        <span>{eta}</span>
        <p>
          The booking lifecycle can record “On the way” and arrival. A live map,
          background GPS, ETA calculation and external safety escalation require
          the production location and communications integrations.
        </p>
        <em>No location is collected or displayed by this UAT placeholder.</em>
      </div>
      <div className={styles.actions}>
        <button disabled title="Live location is not connected">Live route unavailable</button>
        <button disabled title="Secure provider chat is not connected">Message unavailable</button>
        <button className={styles.help} disabled title="Production safety escalation is not connected">Safety help unavailable</button>
      </div>
    </article>
  );
}
