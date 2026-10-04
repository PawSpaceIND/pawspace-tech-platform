"use client";

import { useEffect, useState } from "react";
import { PLATFORM_THEME_STORAGE_KEY, THEME_STORAGE_KEY, isOfferedTheme, themes, type ThemeId } from "../mobile-app/theme-config";

function readStoredTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY) || localStorage.getItem(PLATFORM_THEME_STORAGE_KEY);
    if (isOfferedTheme(stored)) return stored;
  } catch { /* Session-only. */ }
  return "editorial";
}

const grid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 };
const card = (on: boolean): React.CSSProperties => ({
  display: "block",
  textAlign: "left",
  padding: 20,
  borderRadius: "calc(16px * var(--paw-radius-scale))",
  border: on ? "2px solid var(--paw-link)" : "1px solid var(--paw-raised)",
  background: on ? "var(--paw-surface)" : "var(--paw-surface)",
  cursor: "pointer",
  minHeight: 140,
});
const name: React.CSSProperties = { display: "block", fontSize: 18, fontWeight: 800, color: "var(--paw-link)", marginBottom: 6 };
const tag: React.CSSProperties = { display: "block", fontSize: 14, lineHeight: 1.45, color: "var(--paw-text)" };
const swatchRow: React.CSSProperties = { display: "flex", gap: 8, marginTop: 14 };
const swatch = (bg: string): React.CSSProperties => ({ width: 28, height: 28, borderRadius: "calc(8px * var(--paw-radius-scale))", background: bg, border: "1px solid var(--paw-raised)" });

/** Control-center default only. Does not touch bookings or payments.
    Writes the legacy device keys; the shared appearance record (see components/appearance-resolver.ts) treats them as migration
    metadata, so a true new-user default still needs server-side ownership. Only eligible appearances are listed. */
export default function AppearancePlatformPanel({ notify }: { notify: (message: string) => void }) {
  const [theme, setTheme] = useState<ThemeId>("editorial");
  useEffect(() => {
    const sync = () => setTheme(readStoredTheme());
    sync();
    window.addEventListener("pawspace-appearance-change", sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener("pawspace-appearance-change", sync); window.removeEventListener("storage", sync); };
  }, []);
  function choose(next: ThemeId) {
    if (!isOfferedTheme(next)) return;
    setTheme(next);
    try { localStorage.setItem(PLATFORM_THEME_STORAGE_KEY, next); localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* Session-only. */ }
    document.documentElement.setAttribute("data-paw-theme", next);
    window.dispatchEvent(new CustomEvent("pawspace-appearance-change", { detail: { theme: next } }));
    notify(`Appearance set to ${themes.find(option => option.id === next)?.label}.`);
  }
  return (
    <section aria-label="Platform appearance">
      <p style={{ fontSize: 15, lineHeight: 1.5, margin: "0 0 16px", color: "var(--paw-text)" }}>
        This device uses one shared appearance across customer, partner and staff modules. You can also change it from the main Appearance panel.
      </p>
      <div style={grid} role="radiogroup" aria-label="Colour kit">
        {themes.filter((option) => isOfferedTheme(option.id)).map((option) => {
          const on = theme === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => choose(option.id)}
              style={card(on)}
            >
              <span style={name}>{option.label}{on ? " · current" : ""}</span>
              <span style={tag}>{option.tagline}</span>
              <span style={swatchRow} aria-hidden>
                {option.swatches.map((color) => <span key={color} style={swatch(color)} />)}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
