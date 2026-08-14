"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

type Loc = { locale: string; name: string; published: number; draft: number; coveragePct: number };
type Cov = { baseKeyCount?: number; locales?: Loc[] };
const wrap = { minHeight: "100vh", background: "#f2f7f5", padding: 28, fontFamily: "Arial,sans-serif", color: "#06231c" } as const;
const card = { background: "white", border: "1px solid #dcece5", borderRadius: 14 } as const;

export default function I18nPage() {
  const [cov, setCov] = useState<Cov>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  async function load() { const r = await fetch("/api/i18n?mode=coverage", { cache: "no-store" }); const b = await r.json() as { data?: Cov; error?: string }; if (!r.ok) throw new Error(b.error || "i18n unavailable"); setCov(b.data || {}); }
  useEffect(() => { let on = true; void fetch("/api/i18n?mode=coverage", { cache: "no-store" }).then(async r => { const b = await r.json() as { data?: Cov; error?: string }; if (!r.ok) throw new Error(b.error || "i18n unavailable"); if (on) setCov(b.data || {}); }).catch(e => { if (on) setError(e instanceof Error ? e.message : "i18n unavailable"); }); return () => { on = false; }; }, []);
  async function aiTranslate(locale: string) { setBusy(locale); setError(""); setNote(""); try { const r = await fetch("/api/i18n", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "ai_translate", locale }) }); const b = await r.json() as { data?: { connected: boolean; drafted: number; note?: string }; error?: string }; if (!r.ok) throw new Error(b.error || "AI translate failed"); setNote(b.data?.note || `Drafted ${b.data?.drafted ?? 0}`); await load(); } catch (e) { setError(e instanceof Error ? e.message : "AI translate failed"); } finally { setBusy(""); } }
  const base = cov.baseKeyCount || 0;
  return <main style={wrap}><div style={{ maxWidth: 900, margin: "0 auto" }}>
    <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 18 }}><div><small style={{ fontWeight: 800, color: "#1f6b57" }}>PAWSPACE TEAM · LANGUAGES</small><h1 style={{ margin: "7px 0" }}>Multi-language coverage</h1><p style={{ margin: 0, color: "#6c7c78" }}>8 locales · English is the always-present fallback · AI drafts translations you review &amp; publish.</p></div><Link href="/team" style={{ padding: 10, background: "#01261F", color: "white", borderRadius: 10, textDecoration: "none" }}>Team home</Link></header>
    {error && <div style={{ padding: 12, background: "#fff1f1", borderRadius: 10, marginBottom: 12 }}>{error}</div>}
    {note && <div style={{ padding: 12, background: "#f0fff6", border: "1px solid #b9e7cd", borderRadius: 10, marginBottom: 12 }}>{note}</div>}
    <div style={{ ...card, overflow: "hidden" }}>
      <div style={{ padding: 14, borderBottom: "1px solid #e9f1ee" }}><b>{base} base keys (English)</b></div>
      {(cov.locales || []).map(l => <div key={l.locale} style={{ padding: 14, borderBottom: "1px solid #e9f1ee", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 130 }}><strong>{l.name}</strong> <small style={{ color: "#6c7c78" }}>{l.locale}</small></div>
        <div style={{ flex: 1, background: "#e9f1ee", borderRadius: 8, height: 10, overflow: "hidden" }}><div style={{ width: `${l.coveragePct}%`, height: "100%", background: "#F6920A" }} /></div>
        <div style={{ width: 130, textAlign: "right", fontSize: 13, color: "#6c7c78" }}>{l.published} pub · {l.draft} draft · {l.coveragePct}%</div>
        {l.locale !== "en" && <button disabled={Boolean(busy)} onClick={() => aiTranslate(l.locale)} style={{ background: "#01261F", color: "white", border: 0, borderRadius: 8, fontWeight: 800, padding: "8px 12px" }}>{busy === l.locale ? "…" : "AI draft"}</button>}
      </div>)}
    </div>
    <p style={{ fontSize: 12, color: "#6c7c78", marginTop: 14 }}>AI translation is fail-closed — with no AI key set it drafts nothing. Drafts never auto-publish; a human publishes before they go live.</p>
  </div></main>;
}
