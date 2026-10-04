"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { isOfferedTheme, themes, type ThemeId, type AppearanceMode } from "../mobile-app/theme-config";
import { applyAppearanceEvent, effectiveTheme, initialRecordFromLegacy, persistAppearanceRecord, type AppearanceChangeDetail, type AppearanceRecord, type AppearanceSnapshot } from "./appearance-resolver";
import { accountDiffersFromDevice, isPositiveRecordVersion, readAccountAppearance, syncAccountAppearance } from "./appearance-account-client";

/** Root-resolved account authority for this request (frozen contract): writes are enabled only by an authoritative read. */
export type AppearanceAccountHint = { recordVersion: number | null; accountAuthoritative: boolean };

/**
 * Device-local presentation only. Never reads or writes account/service data.
 * The server resolves the appearance record before the first themed HTML and passes that snapshot here, so the first
 * client render agrees with it. This component is the only runtime writer of the record and of the <html> attributes.
 */
export default function PawSpaceAppearance({ initial, account }: { initial: AppearanceSnapshot; account?: AppearanceAccountHint }) {
  const [record, setRecord] = useState<AppearanceRecord>({ version: "1", explicit: initial.explicit, assigned: initial.assigned, mode: initial.mode, legacy: initial.legacy });
  const conciergeAvailable = initial.conciergeAvailable;
  const theme = effectiveTheme(record, conciergeAvailable);
  const dialog = useRef<HTMLDialogElement>(null);
  const pathname = usePathname();
  const [utilitySlot, setUtilitySlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const locate = () => setUtilitySlot(document.querySelector<HTMLElement>('[data-paw-appearance-slot][data-paw-appearance-ready="true"]'));
    locate();
    const observer = new MutationObserver(locate);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-paw-appearance-ready"] });
    return () => observer.disconnect();
  }, [pathname]);
  const persist = (next: AppearanceRecord) => { persistAppearanceRecord(next); };
  // Account glue (UI only). The version is the CAS token of the last authoritative read or write; null means device path.
  // 503 keeps the current snapshot and disables account writes until a later GET succeeds. The root never writes cookies;
  // this controller stays the only cookie writer, also when the account record is applied to this device.
  // Every queued intent and every in-flight completion carries the identity epoch: a navigation or an identity change
  // (pawspace:identity-changed) bumps it, drops queued intents and ignores stale completions, so a new account never
  // receives an old device intent.
  const accountVersion = useRef<number | null>(account?.accountAuthoritative && isPositiveRecordVersion(account.recordVersion) ? account.recordVersion : null);
  const epoch = useRef(0);
  const queued = useRef<Array<{ epoch: number; run: () => Promise<void> }>>([]);
  const draining = useRef(false);
  const latest = useRef<AppearanceRecord>(record);
  const [accountNote, setAccountNote] = useState<{ text: string; retry: boolean } | null>(null);
  /** The explicit device choice whose account write failed visibly; the plain retry path re-applies exactly this intent. */
  const failedIntent = useRef<{ epoch: number; record: AppearanceRecord } | null>(null);
  const aborter = useRef<AbortController | null>(null);
  const queueAccount = (run: () => Promise<void>) => { queued.current.push({ epoch: epoch.current, run }); void drain(); };
  async function drain() {
    if (draining.current) return; draining.current = true;
    try { while (queued.current.length) { const job = queued.current.shift()!; if (job.epoch !== epoch.current) continue; try { await job.run(); } catch { /* every account outcome is plain; nothing escapes */ } } }
    finally { draining.current = false; }
  }
  const invalidate = () => { epoch.current++; queued.current = []; accountVersion.current = null; failedIntent.current = null; aborter.current?.abort(); aborter.current = null; };
  const guardFor = (started: number) => { if (!aborter.current) aborter.current = new AbortController(); return { shouldContinue: () => started === epoch.current, signal: aborter.current.signal }; };
  function apply(next: AppearanceRecord) {
    const root = document.documentElement;
    root.dataset.pawTheme = effectiveTheme(next, conciergeAvailable);
    // "system" stays server-rendered for the first paint; after hydration the resolved mode also drives legacy dark-mode rules.
    root.dataset.pawMode = next.mode === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : next.mode;
    root.dataset.pawStyle = "professional";
  }
  useEffect(() => {
    let current = record;
    // Every change, internal or external, flows through the pure reducer; a mode-only change never touches the explicit choice.
    const sync = (event?: Event) => {
      const detail = event instanceof CustomEvent ? (event.detail as AppearanceChangeDetail | null) : null;
      const next = applyAppearanceEvent(current, detail, conciergeAvailable);
      const external = Boolean(detail) && !(detail as AppearanceChangeDetail).record;
      current = next;
      latest.current = next;
      setRecord(next);
      apply(next);
      // Another writer (for example the staff control panel) announced a change: keep the record consistent with it.
      if (external) persist(next);
    };
    const media = matchMedia("(prefers-color-scheme: dark)");
    window.addEventListener("storage", sync);
    window.addEventListener("pawspace-appearance-change", sync);
    const open = () => dialog.current?.showModal();
    window.addEventListener("pawspace-open-appearance", open);
    media.addEventListener("change", sync);
    if (initial.recordPresent) apply(current);
    else {
      // First visit on the shared layout: assign once, carry legacy device values as inactive metadata, then announce it.
      let storage: Storage | null = null;
      try { storage = localStorage; } catch { storage = null; }
      const migrated = initialRecordFromLegacy(storage, initial);
      persist(migrated);
      window.dispatchEvent(new CustomEvent("pawspace-appearance-change", { detail: { record: migrated, theme: effectiveTheme(migrated, conciergeAvailable), mode: migrated.mode } }));
    }
    return () => { window.removeEventListener("pawspace-open-appearance", open); window.removeEventListener("storage", sync); window.removeEventListener("pawspace-appearance-change", sync); media.removeEventListener("change", sync); };
    // The initial snapshot is fixed for the life of the page; later changes flow through choose() and chooseMode().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** Persists the record and announces it with the full record, so listeners never infer a choice from the effective theme. */
  function announce(updated: AppearanceRecord, fromAccount = false) {
    latest.current = updated;
    persist(updated);
    window.dispatchEvent(new CustomEvent("pawspace-appearance-change", { detail: { record: updated, theme: effectiveTheme(updated, conciergeAvailable), mode: updated.mode } }));
    if (!fromAccount) queueAccount(() => writeAccount(updated));
  }
  function explain(result: { kind: string; status?: number; message?: string }) {
    if (result.kind === "account") { setAccountNote(null); return; }
    if (result.kind === "device") { setAccountNote(null); return; } // signed out: the device record is the whole story
    if (result.kind === "unavailable") { setAccountNote({ text: "Your account appearance service is unavailable right now. This device keeps your choice; nothing was changed on your account.", retry: true }); return; }
    if (result.kind === "refused") { setAccountNote({ text: `Your choice is saved on this device but was not saved to your account (${result.status}${result.message ? `: ${result.message}` : ""}).`, retry: true }); return; }
    if (result.kind === "conflict") { setAccountNote({ text: "Your account appearance changed elsewhere. The account choice is shown; choose again to change it.", retry: false }); return; }
    setAccountNote({ text: "Your choice is saved on this device; the account could not be reached.", retry: true });
  }
  /** GET first: an existing account wins across devices and is always written to the device cookie; 401 keeps the device path; 503 keeps the snapshot, no writes. */
  async function readAccount() {
    const started = epoch.current;
    const result = await readAccountAppearance(undefined, guardFor(started));
    if (started !== epoch.current) return; // stale completion after a navigation or identity change
    if (result.kind === "account") {
      accountVersion.current = result.data.recordVersion;
      // The SSR snapshot may already carry the account record while the device cookie is older: synchronise the cookie regardless.
      if (accountDiffersFromDevice(result.data.record, latest.current)) announce(result.data.record, true); else persist(result.data.record);
    } else accountVersion.current = null;
    explain(result);
  }
  /** The explicit user intent of this device, applied to the account with CAS; bounded retries live in the client module. */
  async function writeAccount(updated: AppearanceRecord) {
    const started = epoch.current;
    const version = accountVersion.current;
    if (!isPositiveRecordVersion(version)) return;
    // Every internal request of the sync (retry, 409 re-read, re-apply) is guarded by the starting epoch and aborted on change.
    const { result } = await syncAccountAppearance({ explicit: updated.explicit, mode: updated.mode }, version, undefined, undefined, guardFor(started));
    if (started !== epoch.current) return; // the account may have changed underneath; the new epoch's read decides
    if (result.kind === "account") {
      accountVersion.current = result.data.recordVersion; failedIntent.current = null;
      // An older successful retry receipt or a later account change carries the CURRENT account: apply it, do not overwrite it.
      if (accountDiffersFromDevice(result.data.record, latest.current)) announce(result.data.record, true);
    } else if (result.kind === "conflict") { failedIntent.current = null; await readAccount(); }
    else if (result.kind === "device") { accountVersion.current = null; failedIntent.current = null; }
    else { accountVersion.current = null; failedIntent.current = { epoch: started, record: updated }; } // unavailable / refused / error: account writes disabled until a fresh authoritative read; cookie and snapshot kept
    explain(result);
  }
  /** Plain retry path for a visible failure: read the account again and, when it is authoritative, re-apply this device's choice. */
  function retryAccount() {
    // Only a failed intent of the current epoch may be re-applied, captured before the re-read; invalidate() clears it.
    const intent = failedIntent.current && failedIntent.current.epoch === epoch.current ? failedIntent.current.record : null; setAccountNote(null); invalidate();
    queueAccount(async () => { await readAccount(); if (intent && isPositiveRecordVersion(accountVersion.current)) await writeAccount(intent); });
  }
  useEffect(() => {
    // On mount and on every navigation: drop queued intents, then read; logout and account switch are seen on that read.
    invalidate(); queueAccount(readAccount);
    const changed = () => { invalidate(); setAccountNote(null); queueAccount(readAccount); };
    window.addEventListener("pawspace:identity-changed", changed);
    return () => { window.removeEventListener("pawspace:identity-changed", changed); invalidate(); setAccountNote(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);
  function choose(next: ThemeId, mode: AppearanceMode = record.mode) {
    if (!isOfferedTheme(next, conciergeAvailable)) return;
    announce({ ...record, explicit: next, mode });
  }
  function chooseMode(mode: AppearanceMode) {
    announce({ ...record, mode });
  }
  const trigger = <button className="paw-appearance-trigger" aria-label="Change PawSpace appearance" onClick={() => dialog.current?.showModal()}><span aria-hidden="true">◐</span><span>Appearance</span></button>;
  const retainedConcierge = record.explicit === "concierge" && !conciergeAvailable;
  return <>
    {utilitySlot ? createPortal(trigger, utilitySlot) : trigger}
    <dialog ref={dialog} className="paw-appearance-dialog" aria-labelledby="paw-appearance-title">
      <div className="paw-appearance-head"><img src="/assets/pawspace-icon.jpeg" alt="PawSpace"/><button aria-label="Close appearance settings" onClick={() => dialog.current?.close()}>×</button></div>
      <h2 id="paw-appearance-title">Make PawSpace yours.</h2><p>One shared layout, two appearances. Choose the one that feels like you.</p>
      {initial.legacyMoved ? <p className="paw-appearance-note" role="status">Your previous style has moved to Editorial Sanctuary.</p> : null}
      {retainedConcierge ? <p className="paw-appearance-note" role="status">Modern Concierge is saved for this device and will apply once it is available.</p> : null}
      {accountNote ? <p className="paw-appearance-note" role="status" data-paw-account-note>{accountNote.text}{accountNote.retry ? <> <button type="button" onClick={retryAccount}>Retry</button></> : null}</p> : null}
      <fieldset><legend>Appearance</legend>{themes.map(option => {
        const available = isOfferedTheme(option.id, conciergeAvailable);
        return <label key={option.id} className="paw-theme-choice"><input type="radio" name="paw-theme" value={option.id} checked={theme === option.id} disabled={!available} onChange={() => choose(option.id)}/><span><b>{option.label}</b><small>{available ? option.tagline : "Available after validation"}</small></span><span className="paw-swatches" aria-hidden="true">{option.swatches.map(colour => <i key={colour} style={{background:colour}}/>)}</span></label>;
      })}</fieldset>
      <fieldset><legend>Display</legend><div className="paw-mode-choices">{(["light", "dark", "system"] as const).map(value => <label key={value}><input type="radio" name="paw-mode" checked={record.mode===value} onChange={() => chooseMode(value)}/>{value}</label>)}</div></fieldset>
      <button className="paw-appearance-done" onClick={() => dialog.current?.close()}>Done</button>
    </dialog>
  </>;
}
