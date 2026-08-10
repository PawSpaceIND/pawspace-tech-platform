import { useState } from "react";
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
  const [toast, setToast] = useState("");
  const flash = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  };
  return (
    <article className={styles.card} data-provider-tracking={role.toLowerCase()}>
      {toast && <div className={styles.toast}>{toast}</div>}
      <div className={styles.map} aria-label={`${role} live GPS route preview`}>
        <span>A</span>
        <i>{role === "Groomer" ? "✦" : role === "Trainer" ? "⌁" : "♡"}</i>
        <span>B</span>
      </div>
      <div className={styles.copy}>
        <small>LIVE GPS & ETA · TEST MODE</small>
        <b>{name} is travelling to the service address</b>
        <span>{eta} away · route refreshed just now</span>
        <p>
          Tracking starts when the {role.toLowerCase()} marks “On the way” and
          ends at verified arrival. Primary and secondary contacts can follow
          the ETA while PawSpace Ops monitors delays and safety alerts.
        </p>
        <em>
          {role === "Sitter"
            ? "Sitter check-in and check-out are GPS verified; continuous home-location tracking is not shown during care."
            : "Continuous location is not shown after the provider arrives and the service begins."}
        </em>
      </div>
      <div className={styles.actions}>
        <button onClick={() => flash("Live route map is not connected in UAT yet.")}>Open live route</button>
        <button onClick={() => flash(`Opening secure chat with your ${role.toLowerCase()}. UAT does not deliver a live message yet.`)}>Message {role.toLowerCase()}</button>
        <button className={styles.help} onClick={() => flash("Safety help logged. In production this connects you to PawSpace Ops immediately.")}>Safety help</button>
      </div>
    </article>
  );
}
