"use client";

import { useState } from "react";
import { PLATFORM_THEME_STORAGE_KEY, isOfferedTheme, themes, type ThemeId } from "../mobile-app/theme-config";

function readStoredTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(PLATFORM_THEME_STORAGE_KEY);
    if (isOfferedTheme(stored)) return stored;
  } catch { /* Session-only. */ }
  return "emerald";
}

const grid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 };
const card = (on: boolean): React.CSSProperties => ({
  display: "block",
  textAlign: "left",
  padding: 20,
  borderRadius: 16,
  border: on ? "2px solid #01261F" : "1px solid #D9D1C4",
  background: on ? "#FFF8EE" : "#FFFFFF",
  cursor: "pointer",
  minHeight: 140,
});
const name: React.CSSProperties = { display: "block", fontSize: 18, fontWeight: 800, color: "#01261F", marginBottom: 6 };
const tag: React.CSSProperties = { display: "block", fontSize: 14, lineHeight: 1.45, color: "#3D4A46" };
const swatchRow: React.CSSProperties = { display: "flex", gap: 8, marginTop: 14 };
const swatch = (bg: string): React.CSSProperties => ({ width: 28, height: 28, borderRadius: 8, background: bg, border: "1px solid #E6DED2" });

/** Control-center default only. Does not touch bookings or payments. */
export default function AppearancePlatformPanel({ notify }: { notify: (message: string) => void }) {
  const [theme, setTheme] = useState<ThemeId>(readStoredTheme);
  function choose(next: ThemeId) {
    if (!isOfferedTheme(next)) return;
    setTheme(next);
    try { localStorage.setItem(PLATFORM_THEME_STORAGE_KEY, next); } catch { /* Session-only. */ }
    document.documentElement.setAttribute("data-paw-theme", next);
    window.dispatchEvent(new CustomEvent("pawspace-appearance-change"));
    notify(next === "signature" ? "Platform default set to Brand book (purple + gold)." : "Platform default set to Emerald kit.");
  }
  const swatches: Record<ThemeId, string[]> = {
    emerald: ["#01261F", "#E6B34E", "#FFF8EE"],
    signature: ["#894AED", "#FFAF00", "#F7F3FF"],
  };
  return (
    <section aria-label="Platform appearance">
      <p style={{ fontSize: 15, lineHeight: 1.5, margin: "0 0 16px", color: "#3D4A46" }}>
        Customers can still pick a kit in the customer app Appearance panel. This only sets the starting kit on this device.
      </p>
      <div style={grid} role="radiogroup" aria-label="Colour kit">
        {themes.map((option) => {
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
                {(swatches[option.id] || swatches.emerald).map((color) => <span key={color} style={swatch(color)} />)}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
