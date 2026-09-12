"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const STORAGE_KEY = "pawspace.cookie-consent.v1";

type ConsentChoice = "essential" | "all";

export default function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(window.localStorage.getItem(STORAGE_KEY) === null);
  }, []);

  const save = (choice: ConsentChoice) => {
    window.localStorage.setItem(STORAGE_KEY, choice);
    window.dispatchEvent(new CustomEvent("pawspace:cookie-consent", { detail: { choice } }));
    setVisible(false);
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
