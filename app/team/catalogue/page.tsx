"use client";
import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import StaffModule from "../../components/staff-workspace/StaffModule";

type Pkg = { id: string; serviceCode: string; packageCode: string; cityId: string; zoneId: string | null; name: string; basePrice: number; active: boolean; version: number };
const wrap = { minHeight: "100vh", background: "var(--staff-bg)", padding: 28, fontFamily: "inherit", color: "var(--staff-text)" } as const;
const card = { background: "var(--staff-surface)", border: "1px solid var(--staff-line)", borderRadius: 14 } as const;
const SERVICES = ["grooming", "dog_training", "boarding", "pet_sitting", "dog_walking", "pet_taxi"];

export default function CataloguePage() {
  const [rows, setRows] = useState<Pkg[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() { const r = await fetch("/api/catalogue", { cache: "no-store" }); const b = await r.json() as { data?: Pkg[]; error?: string }; if (!r.ok) throw new Error(b.error || "Catalogue unavailable"); setRows(b.data || []); }
  useEffect(() => { let on = true; void fetch("/api/catalogue", { cache: "no-store" }).then(async r => { const b = await r.json() as { data?: Pkg[]; error?: string }; if (!r.ok) throw new Error(b.error || "Catalogue unavailable"); if (on) setRows(b.data || []); }).catch(e => { if (on) setError(e instanceof Error ? e.message : "Catalogue unavailable"); }); return () => { on = false; }; }, []);
  async function create(e: FormEvent<HTMLFormElement>) { e.preventDefault(); const fd = new FormData(e.currentTarget); setBusy(true); setError(""); try { const r = await fetch("/api/catalogue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ serviceCode: String(fd.get("serviceCode")), packageCode: String(fd.get("packageCode")), cityId: String(fd.get("cityId") || "ALL"), zoneId: String(fd.get("zoneId") || "") || undefined, name: String(fd.get("name")), basePrice: Number(fd.get("basePrice")), slotMinutes: Number(fd.get("slotMinutes") || 60), reason: "New package via admin" }) }); const b = await r.json() as { error?: string }; if (!r.ok) throw new Error(b.error || "Create failed"); e.currentTarget.reset(); await load(); } catch (x) { setError(x instanceof Error ? x.message : "Create failed"); } finally { setBusy(false); } }
  return <StaffModule><main style={wrap}><div style={{ maxWidth: 1200, margin: "0 auto" }}>
    <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 18 }}><div><small style={{ fontWeight: 800, color: "var(--staff-primary)" }}>PAWSPACE TEAM · CATALOGUE</small><h1 style={{ margin: "7px 0" }}>Packages & prices</h1><p style={{ margin: 0, color: "var(--staff-muted)" }}>Create packages for any service, city- and zone-wise. Zone &gt; city &gt; global price precedence.</p></div><Link href="/team" style={{ padding: 10, background: "var(--staff-primary)", color: "var(--staff-on-primary)", borderRadius: 10, textDecoration: "none" }}>Team home</Link></header>
    {error && <div style={{ padding: 12, background: "var(--staff-danger-bg)", borderRadius: 10, marginBottom: 12 }}>{error}</div>}
    <form onSubmit={create} style={{ ...card, padding: 16, display: "grid", gridTemplateColumns: "1.3fr 1.3fr 2fr 1fr 1fr 1fr 1fr auto", gap: 8, marginBottom: 16 }} data-staff-grid="form">
      <select name="serviceCode" required>{SERVICES.map(s => <option key={s} value={s}>{s}</option>)}</select>
      <input name="packageCode" required placeholder="package-code" />
      <input name="name" required placeholder="Display name" />
      <input name="cityId" placeholder="city (blr / ALL)" />
      <input name="zoneId" placeholder="zone (opt)" />
      <input name="basePrice" type="number" min="0" required placeholder="₹ price" />
      <input name="slotMinutes" type="number" min="0" placeholder="mins" />
      <button disabled={busy} style={{ background: "var(--staff-gold)", color: "var(--staff-on-gold)", border: 0, borderRadius: 8, fontWeight: 800 }}>{busy ? "…" : "Add"}</button>
    </form>
    <div style={{ ...card, overflow: "hidden" }}>
      <div style={{ padding: 14, borderBottom: "1px solid var(--staff-line)" }}><b>{rows.length} package{rows.length === 1 ? "" : "s"}</b></div>
      {rows.length === 0 ? <p style={{ padding: 18, color: "var(--staff-muted)" }}>No packages yet — add one above.</p> : rows.map(p => <article key={p.id} style={{ padding: 14, borderBottom: "1px solid var(--staff-line)", display: "flex", justifyContent: "space-between", gap: 12 }}><div><strong>{p.name}</strong> <small style={{ color: "var(--staff-muted)" }}>· {p.serviceCode} · {p.packageCode}</small><small style={{ display: "block", marginTop: 3, color: "var(--staff-muted)" }}>{p.cityId}{p.zoneId ? ` / ${p.zoneId}` : ""} · v{p.version} · {p.active ? "active" : "inactive"}</small></div><div style={{ fontWeight: 800, fontSize: 17 }}>₹{Number(p.basePrice).toLocaleString("en-IN")}</div></article>)}
    </div>
  </div></main></StaffModule>;
}
