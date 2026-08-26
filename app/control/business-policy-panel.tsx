"use client";
import { useEffect, useState } from "react";

/*
 * Control Center: business policy by vertical and city.
 *
 * The rules shown here - the refund ladder, what a city status means for bookings, which verification a
 * service demands, who may reveal a customer's address, when quiet hours may be overridden - are
 * business decisions, not engineering ones. Until this panel they lived inside code paths: invisible to
 * the people who own them, identical in every city, and changeable only by a deploy.
 *
 * A row is (policy, service, city). `*` means "any", so a platform default and a Bengaluru-only Boarding
 * override sit side by side and the more specific one wins. Every change needs a reason, bumps the
 * version and is kept in the audit trail below.
 */
type PolicyRecord = {
  id: string; domain: string; serviceCode: string; cityId: string; config: Record<string, unknown>;
  notes: string; active: boolean; version: number; effectiveFrom: string; effectiveTo: string | null;
  updatedBy: string; updatedAt: number;
};
type AuditRow = { id: string; service_code: string; city_id: string; action: string; actor_id: string; reason: string; created_at: number };
type DomainSummary = { domain: string; label: string; managePermission: string; defaults: Record<string, unknown> };

const box: React.CSSProperties = { border: "1px solid #e4e4e7", borderRadius: 10, padding: 14, background: "#fff" };
const when = (value: number) => (value ? new Date(value).toLocaleString("en-IN") : "—");

export default function BusinessPolicyPanel({ notify }: { notify?: (message: string) => void }) {
  const [domains, setDomains] = useState<DomainSummary[]>([]);
  const [domain, setDomain] = useState("");
  const [detail, setDetail] = useState<{ label: string; managePermission: string; defaults: Record<string, unknown>; policies: PolicyRecord[]; audit: AuditRow[] } | null>(null);
  const [serviceCode, setServiceCode] = useState("*");
  const [cityId, setCityId] = useState("*");
  // `null` means "showing what is in force". Typing takes a local copy; changing scope drops it again,
  // so switching service or city can never carry an unsaved edit onto a different policy row.
  const [draft, setDraft] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { void (async () => {
    const response = await fetch("/api/service-policy-control", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) { setError(body.error || "Unable to load policy domains"); return; }
    setDomains(body.data.domains);
    if (body.data.domains.length && !domain) setDomain(body.data.domains[0].domain);
  })(); }, [domain]);

  useEffect(() => { if (!domain) return; void (async () => {
    const response = await fetch(`/api/service-policy-control?domain=${encodeURIComponent(domain)}`, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) { setError(body.error || "Unable to load this policy"); return; }
    setError("");
    setDetail(body.data);
  })(); }, [domain, reloadKey]);

  // The editor shows what is ACTUALLY in force at the chosen scope, falling back to the platform default,
  // so an operator narrowing one field cannot silently reset the rest. Derived on render rather than
  // synced through an effect, so no edit is ever one render behind the row it belongs to.
  const inForce = detail?.policies.find((policy) => policy.serviceCode === serviceCode && policy.cityId === cityId)
    ?? detail?.policies.find((policy) => policy.serviceCode === "*" && policy.cityId === "*");
  const shown = draft ?? JSON.stringify(inForce?.config ?? detail?.defaults ?? {}, null, 2);
  const retarget = (next: () => void) => { setDraft(null); next(); };

  async function save() {
    setError("");
    let config: unknown;
    try { config = JSON.parse(shown); } catch { setError("The policy must be valid JSON"); return; }
    if (reason.trim().length < 5) { setError("A clear change reason is required"); return; }
    setBusy(true);
    try {
      const response = await fetch("/api/service-policy-control", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain, serviceCode, cityId, config, reason }),
      });
      const body = await response.json();
      if (!response.ok) { setError(body.error || "The change was refused"); return; }
      setReason("");
      setDraft(null);
      notify?.(`${detail?.label ?? domain} saved for ${serviceCode}/${cityId} (v${body.data.version})`);
      setReloadKey((key) => key + 1);
    } finally { setBusy(false); }
  }

  return (
    <section style={{ display: "grid", gap: 14 }}>
      <header>
        <h2 style={{ margin: 0 }}>Business policy</h2>
        <p style={{ margin: "6px 0 0", color: "#52525b" }}>
          Rules the business owns, by service and by city. A row of <code>*</code> / <code>*</code> is the platform default;
          a more specific row overrides it. Every change is versioned, needs a reason, and is kept below.
        </p>
      </header>

      {error && <p role="alert" style={{ ...box, borderColor: "#dc2626", color: "#b91c1c" }}>{error}</p>}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {domains.map((item) => (
          <button key={item.domain} onClick={() => retarget(() => setDomain(item.domain))} aria-pressed={domain === item.domain}
            style={{ ...box, cursor: "pointer", outline: domain === item.domain ? "2px solid #222" : "none" }}>
            <strong>{item.label}</strong>
            <div style={{ color: "#71717a", fontSize: 12 }}>changed by {item.managePermission}</div>
          </button>
        ))}
      </div>

      {detail && (
        <div style={box}>
          <h3 style={{ marginTop: 0 }}>{detail.label}</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 10 }}>
            <label>Service<input value={serviceCode} onChange={(event) => retarget(() => setServiceCode(event.target.value.trim() || "*"))} placeholder="* for any service" style={{ display: "block", width: "100%", padding: 8 }} /></label>
            <label>City<input value={cityId} onChange={(event) => retarget(() => setCityId(event.target.value.trim() || "*"))} placeholder="* for any city" style={{ display: "block", width: "100%", padding: 8 }} /></label>
          </div>
          <p style={{ color: "#52525b", fontSize: 13 }}>
            {inForce
              ? `Editing ${inForce.serviceCode}/${inForce.cityId} v${inForce.version}, last changed by ${inForce.updatedBy} on ${when(inForce.updatedAt)}.`
              : "No row exists at this scope yet — saving creates one."}
          </p>
          <textarea value={shown} onChange={(event) => setDraft(event.target.value)} rows={18}
            style={{ width: "100%", fontFamily: "ui-monospace, monospace", fontSize: 12, padding: 10 }} />
          <label style={{ display: "block", marginTop: 8 }}>Why this change
            <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. Boarding is an advance commitment in Bengaluru" style={{ display: "block", width: "100%", padding: 8 }} />
          </label>
          <button disabled={busy} onClick={() => void save()} style={{ marginTop: 10, padding: "10px 16px", cursor: "pointer" }}>
            {busy ? "Saving…" : "Save policy"}
          </button>
        </div>
      )}

      {detail && (
        <div style={box}>
          <h3 style={{ marginTop: 0 }}>Rows in force</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr><th align="left">Service</th><th align="left">City</th><th align="left">Version</th><th align="left">Effective</th><th align="left">Changed by</th><th align="left">When</th></tr></thead>
              <tbody>{detail.policies.map((policy) => (
                <tr key={policy.id} style={{ borderTop: "1px solid #f4f4f5" }}>
                  <td>{policy.serviceCode}</td><td>{policy.cityId}</td><td>v{policy.version}{policy.active ? "" : " (inactive)"}</td>
                  <td>{policy.effectiveFrom}{policy.effectiveTo ? ` → ${policy.effectiveTo}` : ""}</td>
                  <td>{policy.updatedBy}</td><td>{when(policy.updatedAt)}</td>
                </tr>))}</tbody>
            </table>
          </div>
        </div>
      )}

      {detail && detail.audit.length > 0 && (
        <div style={box}>
          <h3 style={{ marginTop: 0 }}>Change history</h3>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {detail.audit.map((row) => (
              <li key={row.id} style={{ marginBottom: 6 }}>
                <strong>{row.action}</strong> {row.service_code}/{row.city_id} — {row.actor_id} — “{row.reason}” — {when(row.created_at)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
