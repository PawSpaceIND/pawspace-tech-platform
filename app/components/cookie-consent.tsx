"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "pawspace.cookie-consent.v1";
const CONSENT_EVENT = "pawspace:cookie-consent";

type ConsentChoice = "essential" | "all";

function subscribe(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(CONSENT_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(CONSENT_EVENT, onStoreChange);
  };
}

function getSnapshot() {
  return window.localStorage.getItem(STORAGE_KEY) === null;
}

function getServerSnapshot() {
  return false;
}

export default function CookieConsent() {
  const visible = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const save = (choice: ConsentChoice) => {
    window.localStorage.setItem(STORAGE_KEY, choice);
    window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: { choice } }));
  };

  if (!visible) return null;

  return (
    <aside className="cookie-consent" role="dialog" aria-live="polite" aria-label="Cookie consent">
      <div>
        <strong>Privacy choices</strong>
        <p>
          PawSpace uses essential storage to keep the service secure and working. Optional analytics or similar technologies are used only after consent.
          Read our <Link href="/legal/privacy">Privacy Policy</Link>.
        </p>
      </div>
      <div className="cookie-consent__actions">
        <button type="button" onClick={() => save("essential")}>Essential only</button>
        <button type="button" onClick={() => save("all")}>Accept optional</button>
      </div>
    </aside>
  );
}
