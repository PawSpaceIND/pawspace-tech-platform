"use client";
import { Button } from "../ui";
import type { InboxTemplate } from "../../../lib/staff-inbox-template";
import styles from "./inbox-tools.module.css";
export default function TemplateReply({ templates, selectedKey, busy, canQueue, onSelect, onQueue }: {
  templates: InboxTemplate[]; selectedKey: string; busy: boolean; canQueue: boolean;
  onSelect: (key: string) => void; onQueue: (template: InboxTemplate) => void;
}) {
  const template = templates.find(row => row.key === selectedKey);
  return <section className={styles.template} aria-label="Approved WhatsApp template reply">
    <strong>Restart with an approved template</strong>
    <p>Free text becomes available when the customer replies. Templates require an open conversation under human control.</p>
    <label>Template and language<select aria-label="Approved template and language" value={selectedKey} disabled={busy} onChange={event => onSelect(event.target.value)}><option value="">Select an approved template</option>{templates.map(row => <option key={row.key} value={row.key} disabled={!row.eligible}>{row.label} · {row.language}{row.eligible ? "" : " · unavailable"}</option>)}</select></label>
    {template?.eligible ? <><small>Approved language: {template.language}</small><div className={styles.preview} aria-label="Template preview">{template.body}</div><Button disabled={busy || !canQueue} onClick={() => onQueue(template)}>Queue approved template</Button></> : null}
    {!templates.some(row => row.eligible) ? <p>No supported approved template is available. Review the template catalogue or ask the team for help.</p> : null}
    {templates.some(row => !row.eligible) ? <details><summary>Unavailable templates</summary>{templates.filter(row => !row.eligible).map(row => <p key={row.key}>{row.label}: {row.unavailableReason}</p>)}</details> : null}
    <small>Utility templates without variables only. Consent, delivery and retry rules apply.</small>
  </section>;
}
