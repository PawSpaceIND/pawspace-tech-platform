import Link from "next/link";
import type { CustomerAccountRecord } from "../../lib/customer-account";
import type { V2ServiceAvailability } from "../../lib/v2/customer-experience-client";
import V2ServiceIcon from "./service-icon";
import styles from "./home-care-extras.module.css";
/** Read-only projections of existing account/availability data. No new booking or identity state. */
export function AdditionalCareTiles({ availability }: { availability: V2ServiceAvailability[] | null }) {
  return <>{[
    { code: "funeral_memorial", name: "Funeral care", note: "Sensitive support", href: "/v2/funeral-memorial" },
    { code: "vet_consult", name: "Vet help", note: "Ask PawSpace", href: "/v2/chat" },
  ].map(service => {
    const enabled = availability?.some(item => item.code === service.code && item.enabled) === true;
    const content = <><V2ServiceIcon code={service.code} /><strong>{service.name}</strong><small>{availability === null ? "Checking availability" : enabled ? service.note : "Not taking bookings"}</small></>;
    return enabled ? <Link key={service.code} className={styles.tile} data-home-care-tile={service.code} href={service.href}>{content}</Link>
      : <article key={service.code} className={styles.tile} data-home-care-tile={service.code} data-unavailable="true" aria-label={`${service.name}: ${availability === null ? "checking availability" : "not taking bookings"}`}>{content}</article>;
  })}</>;
}
export function HomePets({ account }: { account: CustomerAccountRecord | null }) {
  if (!account) return null;
  return <section className={styles.pets} aria-label="My pets"><header><h2>My pets</h2><Link href="/v2/account">Manage</Link></header><div className={styles.petRow}>
    {account.pets.map(pet => <Link className={styles.pet} key={pet.id} href="/v2/account" aria-label={`Manage ${pet.name}`}>
      {pet.profile?.photo ? <img src={pet.profile.photo} alt="" /> : <span aria-hidden="true">{pet.name.slice(0, 1).toUpperCase()}</span>}<b>{pet.name}</b>
    </Link>)}<Link className={styles.pet} href="/v2/account"><span aria-hidden="true">＋</span><b>Add pet</b></Link>
  </div></section>;
}
