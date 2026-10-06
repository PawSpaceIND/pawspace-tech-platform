"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { isThemeId, type ThemeId } from "../mobile-app/theme-config";
import type { AppearanceSnapshot } from "./appearance-resolver";

/**
 * Exposes the server-resolved effective theme to client components that choose theme-specific decorative assets
 * (for example the home hero), so the first client render uses the same snapshot as the server HTML. After hydration
 * the value follows the appearance controller through its change event. Presentation only: no storage, no network.
 */
const AppearanceContext = createContext<ThemeId>("editorial");

export function AppearanceProvider({ initial, children }: { initial: AppearanceSnapshot; children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeId>(initial.effective);
  useEffect(() => {
    const follow = () => {
      const next = document.documentElement.dataset.pawTheme;
      if (isThemeId(next)) setTheme(next);
    };
    window.addEventListener("pawspace-appearance-change", follow);
    return () => window.removeEventListener("pawspace-appearance-change", follow);
  }, []);
  return <AppearanceContext.Provider value={theme}>{children}</AppearanceContext.Provider>;
}

export function useEffectiveTheme(): ThemeId {
  return useContext(AppearanceContext);
}
