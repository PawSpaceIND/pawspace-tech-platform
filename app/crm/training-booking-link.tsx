"use client";

import { useState } from "react";

/**
 * Founder decision 26 Sep 2026: sales can't book Training for a lead in the staff console (assisted
 * booking is Grooming-only), so the lead gets the customer booking link instead and chooses the plan,
 * trainer and dates, and pays, themselves. Nothing is sent by PawSpace: staff copy the message or open
 * their own WhatsApp with it. The link is built at click time from the current origin.
 */
function bookingMessage(name: string) {
  const first = name.trim().split(/\s+/)[0] || "there";
  return `Hi ${first}, here is your PawSpace Dog Training booking link: ${window.location.origin}/v2/training?source=crm\nChoose a plan, your trainer and dates, then pay in full or 50% now.`;
}

export default function TrainingBookingLink({ name, phone }: { name: string; phone: string }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const digits = phone.replace(/\D/g, "").slice(-10);
  async function copy() {
    try { await navigator.clipboard.writeText(bookingMessage(name)); setCopied("copied"); } catch { setCopied("failed"); }
  }
  function whatsapp() {
    window.open(`https://wa.me/91${digits}?text=${encodeURIComponent(bookingMessage(name))}`, "_blank", "noopener,noreferrer");
  }
  return <span style={{ display: "inline-flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
    <button type="button" onClick={() => void copy()} style={{ fontWeight: 800, fontSize: 13 }}>{copied === "copied" ? "Training booking link copied" : copied === "failed" ? "Copy failed, select and copy manually" : "Copy Training booking link"}</button>
    {digits.length === 10 && <button type="button" onClick={whatsapp} style={{ fontWeight: 800, fontSize: 13 }}>Send link on WhatsApp</button>}
  </span>;
}
