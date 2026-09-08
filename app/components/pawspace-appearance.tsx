"use client";

import { useEffect, useRef, useState } from "react";
import { APPEARANCE_STORAGE_KEY, DEFAULT_APPEARANCE, DEFAULT_THEME, THEME_STORAGE_KEY, isAppearanceMode, isThemeId, themes, type ThemeId, type AppearanceMode } from "../mobile-app/theme-config";

/** Device-local presentation only. Never reads or writes account/service data. */
export default function PawSpaceAppearance() {
  const [theme, setTheme] = useState<ThemeId>(DEFAULT_THEME);
  const [mode, setMode] = useState<AppearanceMode>(DEFAULT_APPEARANCE);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const sync = () => {
      let chosen: ThemeId = DEFAULT_THEME, appearance: AppearanceMode = DEFAULT_APPEARANCE;
      try {
        const saved = localStorage.getItem(THEME_STORAGE_KEY), savedMode = localStorage.getItem(APPEARANCE_STORAGE_KEY);
        if (isThemeId(saved)) chosen = saved;
        if (isAppearanceMode(savedMode)) appearance = savedMode;
      } catch { /* Appearance remains usable when device storage is unavailable. */ }
      setTheme(chosen); setMode(appearance);
      document.documentElement.dataset.pawTheme = chosen;
      document.documentElement.dataset.pawMode = appearance === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : appearance;
    };
    const media = matchMedia("(prefers-color-scheme: dark)");
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener("pawspace-appearance-change", sync);
    media.addEventListener("change", sync);
    return () => { window.removeEventListener("storage", sync); window.removeEventListener("pawspace-appearance-change", sync); media.removeEventListener("change", sync); };
  }, []);
  function choose(next: ThemeId, appearance = mode) {
    setTheme(next); setMode(appearance);
    document.documentElement.setAttribute("data-paw-theme", next);
    document.documentElement.setAttribute("data-paw-mode", appearance === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : appearance);
    try { localStorage.setItem(THEME_STORAGE_KEY, next); localStorage.setItem(APPEARANCE_STORAGE_KEY, appearance); } catch { /* Session-only preference. */ }
    window.dispatchEvent(new CustomEvent("pawspace-appearance-change"));
  }
  return <>
    <button className="paw-appearance-trigger" aria-label="Change PawSpace appearance" onClick={() => dialog.current?.showModal()}><span aria-hidden="true">◐</span><span>Appearance</span></button>
    <dialog ref={dialog} className="paw-appearance-dialog" aria-labelledby="paw-appearance-title">
      <div className="paw-appearance-head"><img src="/assets/pawspace-icon.jpeg" alt="PawSpace"/><button aria-label="Close appearance settings" onClick={() => dialog.current?.close()}>×</button></div>
      <h2 id="paw-appearance-title">Make PawSpace yours.</h2><p>One look for your pet family, care team and workspaces.</p>
      <fieldset><legend>Colour collection</legend>{themes.map(option => <label key={option.id} className="paw-theme-choice"><input type="radio" name="paw-theme" value={option.id} checked={theme === option.id} onChange={() => choose(option.id)}/><span><b>{option.label}</b><small>{option.tagline}</small></span><span className="paw-swatches" aria-hidden="true">{option.swatches.map(colour => <i key={colour} style={{background:colour}}/>)}</span></label>)}</fieldset>
      <fieldset><legend>Display</legend><div className="paw-mode-choices">{(["light", "dark", "system"] as const).map(value => <label key={value}><input type="radio" name="paw-mode" checked={mode===value} onChange={() => choose(theme,value)}/>{value}</label>)}</div></fieldset>
      <button className="paw-appearance-done" onClick={() => dialog.current?.close()}>Done</button>
    </dialog>
  </>;
}
