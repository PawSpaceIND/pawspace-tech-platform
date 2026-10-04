"use client";
import { useState } from "react";
import { Button } from "../ui";
import type { StaffInboxView } from "../../../lib/staff-inbox-contract";
import styles from "./inbox-tools.module.css";
export type SavedInboxView = { name: string; view: StaffInboxView };
export default function InboxFilters({ view, saved, busy, onChange, onSave, onDelete }: {
  view: StaffInboxView; saved: SavedInboxView[]; busy: boolean;
  onChange: (view: StaffInboxView) => void; onSave: (name: string) => Promise<boolean>; onDelete: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [selectedView, setSelectedView] = useState("");
  return <section className={styles.tools} aria-label="Inbox views">
    <div className={styles.quick} aria-label="Assignment filters">
      {([["all", "All owners"], ["me", "Assigned to me"], ["unassigned", "Unassigned"], ["human", "Human owned"]] as const).map(([key, label]) => <Button key={key} size="sm" variant={view.ownership === key ? "primary" : "secondary"} aria-pressed={view.ownership === key} disabled={busy} onClick={() => { setSelectedView(""); onChange({ ...view, ownership: key }); }}>{label}</Button>)}
    </div>
    <div className={styles.quick} aria-label="Priority filters">
      {([["all", "All messages"], ["unread", "Unread"], ["favourite", "Favourites"]] as const).map(([key, label]) => <Button key={key} size="sm" variant={view.priority === key ? "primary" : "secondary"} aria-pressed={view.priority === key} disabled={busy} onClick={() => { setSelectedView(""); onChange({ ...view, priority: key }); }}>{label}</Button>)}
    </div>
    <label>Channel<select aria-label="Inbox channel" value={view.channel} disabled={busy} onChange={event => { setSelectedView(""); onChange({ ...view, channel: event.target.value as StaffInboxView["channel"] }); }}><option value="all">All channels</option><option value="whatsapp">WhatsApp</option><option value="chat">Web chat</option></select></label>
    <label>Saved views<select aria-label="Saved inbox views" value={selectedView} disabled={busy} onChange={event => { const name = event.target.value; setSelectedView(name); const found = saved.find(row => row.name === name); if (found) onChange(found.view); }}><option value="">Choose a saved view</option>{saved.map(row => <option key={row.name} value={row.name}>{row.name}</option>)}</select></label>
    <div className={styles.quick}><input aria-label="New saved view name" placeholder="Name this view" maxLength={60} value={name} disabled={busy} onChange={event => setName(event.target.value)} /><Button size="sm" disabled={busy || !name.trim()} onClick={async () => { if (await onSave(name.trim())) { setSelectedView(name.trim()); setName(""); } }}>Save view</Button>{selectedView ? <Button size="sm" variant="secondary" disabled={busy} onClick={async () => { if (await onDelete(selectedView)) setSelectedView(""); }}>Delete view</Button> : null}</div>
    <small>Unread and favourites are personal. Saved views keep your filters.</small>
  </section>;
}
