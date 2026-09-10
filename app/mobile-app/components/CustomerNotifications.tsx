"use client";
import { useEffect, useRef, useState } from "react";

import styles from "./customer-notifications.module.css";

type Notice = { id: string; title: string; message: string; bookingId: string; deliveredAt: number };
type Cursor = { at: number; id: string };
async function requestInbox(url: string, signal?: AbortSignal) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(cancel, 10000);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error("Notification request failed");
    const body = await response.json();
    if (!Array.isArray(body.data?.items)) throw new Error("Invalid notification response");
    return body;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
}

export function CustomerNotifications(props: { customerId: string; onClose: () => void }) {
  return <CustomerNotificationsDialog key={props.customerId} {...props} />;
}

function CustomerNotificationsDialog({ customerId, onClose }: { customerId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  const [items, setItems] = useState<Notice[]>([]);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    requestInbox(`/api/customer-notifications?customerId=${encodeURIComponent(customerId)}`, controller.signal)
      .then(body => { if (!controller.signal.aborted) { setItems(body.data.items); setCursor(body.data.nextCursor); } })
      .catch(() => { if (!controller.signal.aborted) setError("Unable to load notifications. Please retry."); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [customerId, reload]);
  async function loadMore() {
    const controller = lifetime.current;
    if (!cursor || busy || !controller || controller.signal.aborted) return;
    setBusy(true); setError("");
    try {
      const body = await requestInbox(`/api/customer-notifications?customerId=${encodeURIComponent(customerId)}&cursor=${encodeURIComponent(JSON.stringify(cursor))}`, controller.signal);
      if (controller.signal.aborted) return;
      setItems(previous => [...previous, ...body.data.items.filter((item: Notice) => !previous.some(existing => existing.id === item.id))]);
      setCursor(body.data.nextCursor);
    } catch { if (!controller.signal.aborted) setError("Unable to load more notifications. Please retry."); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  function retry() {
    if (cursor && items.length) { void loadMore(); return; }
    setBusy(true); setError(""); setItems([]); setCursor(null);
    setReload(value => value + 1);
  }
  return <dialog ref={dialog} onCancel={onClose} aria-modal="true" aria-labelledby="customer-notifications-title" className={styles.panel}>
    <button className={styles.close} onClick={onClose} aria-label="Close notifications">Close</button>
    <h2 className={styles.title} id="customer-notifications-title">Notifications & reminders</h2>
    <p className={styles.subtitle}>Support updates for your bookings.</p>
    {busy && <p className={styles.state} role="status">Loading notifications…</p>}
    {error && <div className={styles.error} role="alert"><p>{error}</p><button className={styles.action} disabled={busy} onClick={retry}>Retry notifications</button></div>}
    {!busy && !error && items.length === 0 && <p className={styles.state}>No support notifications yet.</p>}
    {items.map(item => <article key={item.id} className={styles.notice}><h3>{item.title}</h3><p>{item.message}</p><p className={styles.booking}>Booking: {item.bookingId}</p><time dateTime={new Date(item.deliveredAt).toISOString()}>{new Date(item.deliveredAt).toLocaleString()}</time></article>)}
    {cursor && !error && <button className={styles.action} disabled={busy} onClick={() => void loadMore()}>Load older notifications</button>}
  </dialog>;
}
