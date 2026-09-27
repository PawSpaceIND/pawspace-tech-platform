"use client";

import { useState } from "react";
import styles from "./assisted.module.css";
import { STAY_BOOKING_LINKS, stayBookingLinkMessage, stayBookingWhatsAppUrl, type StayBookingService } from "../../lib/stay-booking-link";

/**
 * Boarding and Pet Sitting from a lead: staff cannot book a stay here, so they send the customer's booking link
 * (the Training pattern). The customer signs in with the number on this record, so the stay is booked on this
 * customer and converts the open lead once it is paid. Nothing is sent by PawSpace: staff copy the message or open
 * their own WhatsApp with it, and the link is built at click time from the current origin.
 */
export default function StayBookingLinks({ name, phone }: { name: string; phone: string }) {
  const [copied, setCopied] = useState<{ service: StayBookingService; ok: boolean } | null>(null);
  const canWhatsApp = stayBookingWhatsAppUrl(phone, "") !== null;
  async function copy(service: StayBookingService) {
    try { await navigator.clipboard.writeText(stayBookingLinkMessage(service, name, window.location.origin)); setCopied({ service, ok: true }); } catch { setCopied({ service, ok: false }); }
  }
  function whatsapp(service: StayBookingService) {
    const url = stayBookingWhatsAppUrl(phone, stayBookingLinkMessage(service, name, window.location.origin));
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }
  return <div className={styles.stage}><small>BOARDING · PET SITTING · BOOKING LINK</small><h3>Send the customer their stay booking link</h3>
    <div className={styles.info}>Boarding and Pet Sitting are booked by the customer in the PawSpace app. When they sign in with the mobile number on this record, the stay is booked on this customer and the open lead converts once it is paid. PawSpace sends nothing itself.</div>
    <div className={styles.serviceGrid}>{STAY_BOOKING_LINKS.map((link) => <button type="button" key={link.service} onClick={() => void copy(link.service)}><b>{copied?.service === link.service ? (copied.ok ? `${link.label} booking link copied` : "Copy failed, select and copy manually") : `Copy ${link.label} booking link`}</b><small>{link.path}</small></button>)}
      {canWhatsApp && STAY_BOOKING_LINKS.map((link) => <button type="button" key={`whatsapp-${link.service}`} onClick={() => whatsapp(link.service)}><b>Send {link.label} link on WhatsApp</b><small>Opens your own WhatsApp</small></button>)}</div>
  </div>;
}
