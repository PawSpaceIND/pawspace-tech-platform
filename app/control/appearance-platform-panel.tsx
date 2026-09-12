"use client";

import { useEffect, useState } from "react";
import { PLATFORM_THEME_STORAGE_KEY, isOfferedTheme, themes, type ThemeId } from "../mobile-app/theme-config";

/** Control-center default only. Does not touch bookings or payments. */
export default function AppearancePlatformPanel({ notify }: { notify: (message: string) => void }) {
  const [theme, setTheme] = useState<ThemeId>("emerald");
  useEffect(() => {
    let frame = 0;
    try {
      const stored = localStorage.getItem(PLATFORM_THEME_STORAGE_KEY);
      if (isOfferedTheme(stored)) frame = requestAnimationFrame(() => setTheme(stored));
    } catch { /* Session-only. */ }
    return () => { if (frame) cancelAnimationFrame(frame); };
  }, []);
  function choose(next: ThemeId) {
    if (!isOfferedTheme(next)) return;
    setTheme(next);
    try { localStorage.setItem(PLATFORM_THEME_STORAGE_KEY, next); } catch { /* Session-only. */ }
    window.dispatchEvent(new CustomEvent("pawspace-appearance-change"));
    notify(next === "signature" ? "Platform default set to Brand book (purple + gold)." : "Platform default set to Emerald kit.");
  }
  return <section aria-label="Platform appearance">
    <h2>Customer app appearance</h2>
    <p>Sets the default colour kit for this browser. Customers can still override in Appearance. No money or booking logic changes.</p>
    {themes.map((option) => <label key={option.id}>
      <input type="radio" name="platform-theme" checked={theme === option.id} onChange={() => choose(option.id)} />
      <span><b>{option.label}</b> — {option.tagline}</span>
    </label>)}
  </section>;
}
