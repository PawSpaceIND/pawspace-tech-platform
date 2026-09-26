"use client";

import { useState } from "react";
import { trainingBookingLinkMessage, trainingBookingWhatsAppUrl } from "../../lib/training-booking-link";

/**
 * Founder decision 26 Sep 2026: sales can't book Training for a lead in the staff console (assisted
 * booking is Grooming-only), so the lead gets the customer booking link instead and chooses the plan,
 * trainer and dates, and pays, themselves. Nothing is sent by PawSpace: staff copy the message or open
 * their own WhatsApp with it. The link is built at click time from the current origin.
 */
export default function TrainingBookingLink({ name, phone }: { name: string; phone: string }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const canWhatsApp = trainingBookingWhatsAppUrl(phone, "") !== null;
  async function copy() {
    try { await navigator.clipboard.writeText(trainingBookingLinkMessage(name, window.location.origin)); setCopied("copied"); } catch { setCopied("failed"); }
  }
  function whatsapp() {
    const url = trainingBookingWhatsAppUrl(phone, trainingBookingLinkMessage(name, window.location.origin));
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }
  return <span style={{ display: "inline-flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
    <button type="button" onClick={() => void copy()} style={{ fontWeight: 800, fontSize: 13 }}>{copied === "copied" ? "Training booking link copied" : copied === "failed" ? "Copy failed, select and copy manually" : "Copy Training booking link"}</button>
    {canWhatsApp && <button type="button" onClick={whatsapp} style={{ fontWeight: 800, fontSize: 13 }}>Send link on WhatsApp</button>}
  </span>;
}
