"use client";
import { useEffect, useState } from "react";
import ServiceFeedbackCard, { type PendingFeedback } from "../mobile-app/service-feedback-card";

/**
 * QA (M12) / owner decision 7: nothing asked V2 customers to rate a completed service, although groomer matching
 * ranks by rating. Shows the same governed feedback cards as the in-app flow, from /api/service-review.
 */
export default function V2PendingFeedback({ customerId }: { customerId: string }) {
  const [pending, setPending] = useState<PendingFeedback[]>([]);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void fetch(`/api/service-review?customerId=${encodeURIComponent(customerId)}`, { cache: "no-store" })
      .then(response => response.ok ? response.json() : null)
      .then((body: { data?: { pending?: PendingFeedback[] } } | null) => { if (active) setPending(body?.data?.pending ?? []); })
      .catch(() => { /* rating prompts are optional; Activity still loads */ });
    return () => { active = false; };
  }, [customerId]);
  if (!pending.length && !message) return null;
  return <section aria-label="Rate your recent care">
    <h2>Rate your recent care</h2>
    {message && <p role="status">{message}</p>}
    {pending.map(item => <ServiceFeedbackCard key={item.requestId} item={item} customerId={customerId} onDone={(requestId, done) => { setMessage(done); setPending(current => current.filter(row => row.requestId !== requestId)); }} />)}
  </section>;
}
