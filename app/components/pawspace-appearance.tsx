"use client";

import { useEffect, useRef, useState } from "react";
import { APPEARANCE_STORAGE_KEY, DEFAULT_APPEARANCE, PLATFORM_THEME_STORAGE_KEY, THEME_STORAGE_KEY, isAppearanceMode, isOfferedTheme, isThemeId, readPlatformDefaultTheme, resolveBrandTheme, themes, type ThemeId, type AppearanceMode } from "../mobile-app/theme-config";

/** Device-local presentation only. Never reads or writes account/service data. */
export default function PawSpaceAppearance() {
  const [theme, setTheme] = useState<ThemeId>(readPlatformDefaultTheme());
  const [mode, setMode] = useState<AppearanceMode>(DEFAULT_APPEARANCE);
  const [visualStyle, setVisualStyle] = useState("cartoon");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const sync = () => {
      let chosen: ThemeId = readPlatformDefaultTheme(), appearance: AppearanceMode = DEFAULT_APPEARANCE;
      try {
        const saved = localStorage.getItem(THEME_STORAGE_KEY), savedMode = localStorage.getItem(APPEARANCE_STORAGE_KEY);
        const platform = localStorage.getItem(PLATFORM_THEME_STORAGE_KEY);
        if (isOfferedTheme(saved)) chosen = saved;
        else if (isOfferedTheme(platform)) chosen = platform;
        else if (isThemeId(saved)) chosen = resolveBrandTheme(saved);
        if (isAppearanceMode(savedMode)) appearance = savedMode;
      } catch { /* Appearance remains usable when device storage is unavailable. */ }
      setTheme(chosen); setMode(appearance);
      let style = "cartoon";
      try { if (localStorage.getItem("pawspace.visual-style") === "professional") style = "professional"; } catch { /* Device preference only. */ }
      setVisualStyle(style);
      document.documentElement.dataset.pawStyle = style;
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
    const brand = resolveBrandTheme(next);
    setTheme(brand); setMode(appearance);
    document.documentElement.setAttribute("data-paw-theme", brand);
    document.documentElement.setAttribute("data-paw-mode", appearance === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : appearance);
    try { localStorage.setItem(THEME_STORAGE_KEY, brand); localStorage.setItem(APPEARANCE_STORAGE_KEY, appearance); } catch { /* Session-only preference. */ }
    window.dispatchEvent(new CustomEvent("pawspace-appearance-change"));
  }
  return <>
    <button className="paw-appearance-trigger" aria-label="Change PawSpace appearance" onClick={() => dialog.current?.showModal()}><span aria-hidden="true">◐</span><span>Appearance</span></button>
    <dialog ref={dialog} className="paw-appearance-dialog" aria-labelledby="paw-appearance-title">
      <div className="paw-appearance-head"><img src="/assets/pawspace-icon.jpeg" alt="PawSpace"/><button aria-label="Close appearance settings" onClick={() => dialog.current?.close()}>×</button></div>
      <h2 id="paw-appearance-title">Make PawSpace yours.</h2><p>Pick Emerald kit or official Brand book colours. Same booking and payments either way.</p>
      <fieldset><legend>Visual style</legend>{["cartoon", "professional"].map(style => <label className="paw-theme-choice" key={style}><input type="radio" name="paw-style" checked={visualStyle === style} onChange={() => {
        setVisualStyle(style); document.documentElement.dataset.pawStyle = style;
        try { localStorage.setItem("pawspace.visual-style", style); } catch { /* Session-only choice. */ }
      }}/><span><b>{style === "cartoon" ? "Illustrated mascots" : "Professional"}</b><small>{style === "cartoon" ? "Cute breed art on every service · default" : "Compact icons only"}</small></span></label>)}</fieldset>
      <fieldset><legend>Brand colour</legend>{themes.map(option => <label key={option.id} className="paw-theme-choice"><input type="radio" name="paw-theme" value={option.id} checked={theme === option.id} onChange={() => choose(option.id)}/><span><b>{option.label}</b><small>{option.tagline}</small></span><span className="paw-swatches" aria-hidden="true">{option.swatches.map(colour => <i key={colour} style={{background:colour}}/>)}</span></label>)}</fieldset>
      <fieldset><legend>Display</legend><div className="paw-mode-choices">{(["light", "dark", "system"] as const).map(value => <label key={value}><input type="radio" name="paw-mode" checked={mode===value} onChange={() => choose(theme,value)}/>{value}</label>)}</div></fieldset>
      <button className="paw-appearance-done" onClick={() => dialog.current?.close()}>Done</button>
    </dialog>
  </>;
}
