"use client";

import { useEffect, useMemo, useState } from "react";
import { loadCityLaunchConfigs, saveCityLaunchConfig } from "../../lib/city-governance-client";
import type { CityLaunchConfig, CityLaunchConfigInput, CityLaunchStatus, CityLaunchService } from "../../lib/city-governance";
import baseStyles from "./control.module.css";
import offerStyles from "./offers-control-panel.module.css";
import cityStyles from "./city-control-panel.module.css";
const styles = { ...baseStyles, ...offerStyles, ...cityStyles };

const serviceNames: CityLaunchService[] = ["Grooming", "Training", "Boarding", "Pet Sitting"];

const blankDraft = (): CityLaunchConfigInput => ({
  cityCode: "", city: "", state: "", status: "Draft", centre: "", radiusKm: 15, pincodes: "", gstIncluded: true,
  services: {
    Grooming: { enabled: true, price: 1349 }, Training: { enabled: true, price: 3500 },
    Boarding: { enabled: true, price: 899 }, "Pet Sitting": { enabled: true, price: 699 },
  },
});
const toDraft = (config: CityLaunchConfig): CityLaunchConfigInput => ({
  id: config.id, cityCode: config.cityCode, city: config.city, state: config.state, status: config.status, centre: config.centre,
  radiusKm: config.radiusKm, pincodes: config.pincodes, gstIncluded: config.gstIncluded, services: { ...config.services },
});

export default function CityControlPanel({ notify }: { notify: (message: string) => void }) {
  const [cities, setCities] = useState<CityLaunchConfig[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CityLaunchConfigInput>(() => blankDraft());
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const applyLoaded = (data: CityLaunchConfig[]) => {
    setCities(data);
    if (!creating && data.length) {
      const current = data.find(city => city.id === selectedId) ?? data[0];
      setSelectedId(current.id);
      setDraft(toDraft(current));
    }
  };
  const refresh = async () => {
    try {
      setError("");
      applyLoaded(await loadCityLaunchConfigs());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load city launch governance");
    }
  };
  useEffect(() => {
    let active = true;
    void loadCityLaunchConfigs()
      .then(data => { if (active) { setError(""); applyLoaded(data); } })
      .catch(err => { if (active) setError(err instanceof Error ? err.message : "Unable to load city launch governance"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const selected = useMemo(() => cities.find(city => city.id === selectedId) ?? cities[0], [cities, selectedId]);
  const choose = (city: CityLaunchConfig) => { setSelectedId(city.id); setDraft(toDraft(city)); setCreating(false); };
  const newCity = () => { setDraft(blankDraft()); setSelectedId(null); setCreating(true); };
  const updateService = (name: CityLaunchService, patch: Partial<{ enabled: boolean; price: number }>) =>
    setDraft(current => ({ ...current, services: { ...current.services, [name]: { ...current.services[name], ...patch } } }));

  const save = async () => {
    setSaving(true);
    try {
      const saved = await saveCityLaunchConfig(draft);
      setCreating(false);
      setSelectedId(saved.id);
      notify(`${saved.city} city configuration saved as ${saved.status}`);
      await refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Unable to save city configuration");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <section className={styles.offerHero}><div><span>CITY & GEOFENCE MANAGEMENT · UAT ONLY</span><h2>Loading server-governed cities…</h2></div></section>;

  return <>
    <section className={styles.offerHero}><div><span>CITY & GEOFENCE MANAGEMENT · UAT ONLY</span><h2>Launch a city with its own coverage and prices.</h2><p>Create the service boundary, enable only launch-ready services and assign GST-inclusive starting prices before publishing. Saved to the canonical server, not this browser.</p></div><button onClick={newCity}>＋ Add new city</button></section>
    {error && <section className={styles.panel}><b>Configuration / validation</b><p>{error}</p></section>}
    <section className={styles.metrics}>{[
      ["Configured cities", String(cities.length), `${cities.filter(city => city.status === "Live").length} live`],
      ["Live geofences", String(cities.filter(city => city.status === "Live").length), "Radius/pincode rules"],
      ["Services enabled", String(cities.reduce((n, city) => n + serviceNames.filter(service => city.services[service]?.enabled).length, 0)), "Across all cities"],
      ["Production ready", "NO", "UAT governance only"],
    ].map(item => <article key={item[0]}><span>{item[0]}</span><strong>{item[1]}</strong><small>{item[2]}</small></article>)}</section>
    <section className={styles.cityLayout}>
      <aside className={styles.cityList}><div className={styles.head}><div><span>CITY DIRECTORY</span><h2>Launch markets</h2></div></div>{cities.map(city => <button key={city.id} className={selectedId === city.id && !creating ? styles.citySelected : ""} onClick={() => choose(city)}><div><strong>{city.city}</strong><small>{city.cityCode} · {city.state} · {city.radiusKm} km geofence</small></div><b>{city.status}</b></button>)}</aside>
      <section className={styles.cityEditor}>
        <div className={styles.head}><div><span>{creating ? "NEW CITY DRAFT" : "CITY CONFIGURATION"}</span><h2>{creating ? "Add launch city" : selected?.city}</h2></div><b className={styles.testBadge}>No live Maps connection</b></div>
        <div className={styles.cityFields}>
          <label>City<input value={draft.city} placeholder="e.g. Chennai" onChange={e => setDraft({ ...draft, city: e.target.value })} /></label>
          <label>City code · used across pricing, tax &amp; coupons<input value={draft.cityCode} placeholder="e.g. chn" onChange={e => setDraft({ ...draft, cityCode: e.target.value.toLowerCase() })} /></label>
          <label>State<input value={draft.state} placeholder="e.g. Tamil Nadu" onChange={e => setDraft({ ...draft, state: e.target.value })} /></label>
          <label>Launch status<select value={draft.status} onChange={e => setDraft({ ...draft, status: e.target.value as CityLaunchStatus })}><option>Draft</option><option>Pilot</option><option>Live</option><option>Paused</option></select></label>
          <label>Coverage radius (km)<input type="number" min="1" value={draft.radiusKm} onChange={e => setDraft({ ...draft, radiusKm: Number(e.target.value) })} /></label>
          <label className={styles.wideField}>Geofence centre · latitude, longitude<input value={draft.centre} placeholder="13.0827, 80.2707" onChange={e => setDraft({ ...draft, centre: e.target.value })} /></label>
          <label className={styles.wideField}>Serviceable pincodes / clusters<input value={draft.pincodes} placeholder="600001, 600002, OMR, Anna Nagar" onChange={e => setDraft({ ...draft, pincodes: e.target.value })} /></label>
        </div>
        <div className={styles.geofencePreview}><i></i><b>●</b><div><strong>{draft.city || "New city"} geofence</strong><span>{draft.radiusKm} km around {draft.centre || "selected centre"}</span><small>Customer address must fall inside the active radius or approved pincodes.</small></div></div>
        <div className={styles.servicePriceHead}><div><span>CITY PRICE BOOK</span><h3>Services and starting prices</h3></div><label><input type="checkbox" checked={draft.gstIncluded} onChange={e => setDraft({ ...draft, gstIncluded: e.target.checked })} /> Prices include GST</label></div>
        <div className={styles.servicePrices}>{serviceNames.map(service => <article key={service} className={draft.services[service]?.enabled ? styles.serviceEnabled : ""}><button aria-label={`Toggle ${service}`} onClick={() => updateService(service, { enabled: !draft.services[service]?.enabled })}><i></i></button><div><strong>{service}</strong><small>{draft.services[service]?.enabled ? "Bookable in this city" : "Not launched"}</small></div><label>Starting at ₹<input type="number" min="0" value={draft.services[service]?.price ?? 0} disabled={!draft.services[service]?.enabled} onChange={e => updateService(service, { price: Number(e.target.value) })} /></label></article>)}</div>
        <div className={styles.cityFooter}><div><span>Publish protection</span><strong>Draft → validate coverage & prices → owner approval → city goes live</strong></div><button disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : creating ? "Save city draft" : "Save configuration"}</button></div>
      </section>
    </section>
  </>;
}
