"use client";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { Badge, Button, EmptyState, StatCard } from "../../components/ui";
import OpsShell from"../../components/ops-shell/OpsShell";
import styles from "../team-console.module.css";

type Plan = { id: string; serviceCode: string; planCode: string; cityId: string; name: string; price: number; sessionCount: number; validityValue: number; validityUnit: string; active: boolean };

const SERVICES = ["grooming", "dog_training", "boarding", "pet_sitting", "dog_walking", "pet_taxi"];
const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value || 0);

export default function SubscriptionPlansPage() {
  const [rows, setRows] = useState<Plan[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [service, setService] = useState("all");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/subscription-plans", { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as { data?: Plan[]; error?: string };
      if (!response.ok) throw new Error(body.error || `Plans unavailable (HTTP ${response.status})`);
      setRows(body.data || []); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);
  useEffect(() => { const timer = setTimeout(() => { void load(); }, 0); return () => clearTimeout(timer); }, [load]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/subscription-plans", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serviceCode: String(data.get("serviceCode")), planCode: String(data.get("planCode")), cityId: String(data.get("cityId")),
          name: String(data.get("name")), price: Number(data.get("price")), sessionCount: Number(data.get("sessionCount")),
          validityValue: Number(data.get("validityValue")), validityUnit: String(data.get("validityUnit")),
          servicePackageCode: String(data.get("servicePackageCode")), reason: "New plan via admin",
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error || `Create failed (HTTP ${response.status})`);
      form.reset();
      setNotice(`${String(data.get("name"))} added for ${String(data.get("cityId"))}.`);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  const shown = service === "all" ? rows : rows.filter((plan) => plan.serviceCode === service);
  const activeCount = rows.filter((plan) => plan.active).length;
  const cities = new Set(rows.map((plan) => plan.cityId)).size;

  return <OpsShell
      eyebrow="PAWSPACE TEAM · SUBSCRIPTION PLANS"
      title="Plans for every service"
      description="Per city, with a validity window in days or months that sets each customer’s expiry from the booked date."
      actions={<Badge tone={activeCount ? "success" : "warning"} dot>{activeCount} active</Badge>}
      >

    {error ? <div className={`${styles.panel} ${styles.panelError}`}><b>{error}</b></div> : null}
    {notice ? <div className={styles.panel}>{notice}</div> : null}

    <section className={styles.tiles}>
      <StatCard label="Plans" value={rows.length} />
      <StatCard label="Active" value={activeCount} />
      <StatCard label="Cities covered" value={cities} />
      <StatCard label="Services covered" value={new Set(rows.map((plan) => plan.serviceCode)).size} meta={`of ${SERVICES.length}`} />
    </section>

    <section className={styles.panel}>
      <div className={styles.panelHead}><h2>Add a plan</h2></div>
      <p className={styles.panelNote}>The validity window is what a customer’s expiry is calculated from, so it belongs to the plan rather than to any single booking.</p>
      <form onSubmit={create}>
        <div className={styles.fieldRow}>
          <label className={styles.field}>Service<select name="serviceCode" required>{SERVICES.map((code) => <option key={code} value={code}>{code.replaceAll("_", " ")}</option>)}</select></label>
          <label className={styles.field}>Plan code<input name="planCode" required placeholder="grooming-6" /></label>
          <label className={styles.field}>Plan name<input name="name" required placeholder="Grooming · 6 sessions" /></label>
          <label className={styles.field}>City<input name="cityId" required placeholder="blr" /></label>
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.field}>Price (₹)<input name="price" type="number" min="0" required placeholder="6594" /></label>
          <label className={styles.field}>Sessions<input name="sessionCount" type="number" min="1" required placeholder="6" /></label>
          <label className={styles.field}>Validity<input name="validityValue" type="number" min="1" required placeholder="8" /></label>
          <label className={styles.field}>Validity unit<select name="validityUnit" required><option value="months">months</option><option value="days">days</option></select></label>
          <label className={styles.field}>Package code<input name="servicePackageCode" required placeholder="grooming-full" /></label>
        </div>
        <div className={styles.actions}><Button size="sm" type="submit" disabled={busy}>{busy ? "Adding…" : "Add plan"}</Button></div>
      </form>
    </section>

    <section className={styles.controls}>
      <Button size="sm" variant={service === "all" ? "primary" : "secondary"} onClick={() => setService("all")}>All services</Button>
      {SERVICES.map((code) => <Button key={code} size="sm" variant={service === code ? "primary" : "secondary"} onClick={() => setService(code)}>{code.replaceAll("_", " ")}</Button>)}
    </section>

    {shown.length === 0 ? <EmptyState
      title={rows.length ? `No ${service.replaceAll("_", " ")} plans yet` : "No subscription plans yet"}
      body={rows.length ? "Pick another service, or add a plan for this one above." : "Add the first plan above — service, city, price, sessions and the validity window."}
    /> : <div className={styles.tableWrap}><table className={styles.table}>
      <thead><tr><th>Plan</th><th>Service · city</th><th className={styles.numeric}>Sessions</th><th>Validity</th><th>Status</th><th className={styles.numeric}>Price</th></tr></thead>
      <tbody>{shown.map((plan) => <tr key={plan.id}>
        <td><div className={styles.stack}><b>{plan.name}</b><small>{plan.planCode}</small></div></td>
        <td><div className={styles.stack}><span>{plan.serviceCode.replaceAll("_", " ")}</span><small>{plan.cityId}</small></div></td>
        <td className={styles.numeric}>{plan.sessionCount}</td>
        <td>{plan.validityValue} {plan.validityUnit}</td>
        <td><Badge tone={plan.active ? "success" : "neutral"}>{plan.active ? "active" : "inactive"}</Badge></td>
        <td className={styles.numeric}><b>{money(plan.price)}</b></td>
      </tr>)}</tbody>
    </table></div>}
  </OpsShell>;
}
