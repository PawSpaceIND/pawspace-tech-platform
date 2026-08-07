"use client";

import { useEffect, useMemo, useState } from "react";
import baseStyles from "./control.module.css";
import offerStyles from "./offers-control-panel.module.css";
import cityStyles from "./city-control-panel.module.css";
const styles = { ...baseStyles, ...offerStyles, ...cityStyles };

type ServicePrice = { enabled: boolean; price: number };
type CityConfig = {
  id: string;
  city: string;
  state: string;
  status: "Draft" | "Pilot" | "Live" | "Paused";
  centre: string;
  radiusKm: number;
  pincodes: string;
  gstIncluded: boolean;
  services: Record<"Grooming" | "Training" | "Boarding" | "Pet Sitting", ServicePrice>;
};

const storageKey = "pawspace-city-geofences-v1";
const serviceNames = ["Grooming", "Training", "Boarding", "Pet Sitting"] as const;
const seed: CityConfig[] = [{
  id: "bengaluru", city: "Bengaluru", state: "Karnataka", status: "Live",
  centre: "12.9716, 77.5946", radiusKm: 35, pincodes: "560001–560110", gstIncluded: true,
  services: {
    Grooming: { enabled: true, price: 1349 }, Training: { enabled: true, price: 3500 },
    Boarding: { enabled: true, price: 899 }, "Pet Sitting": { enabled: true, price: 699 },
  },
}];

const blankCity = (): CityConfig => ({
  id: `city-${Date.now()}`, city: "", state: "", status: "Draft", centre: "", radiusKm: 15, pincodes: "", gstIncluded: true,
  services: {
    Grooming: { enabled: true, price: 1349 }, Training: { enabled: true, price: 3500 },
    Boarding: { enabled: true, price: 899 }, "Pet Sitting": { enabled: true, price: 699 },
  },
});

export default function CityControlPanel({ notify }: { notify: (message: string) => void }) {
  const [cities, setCities] = useState<CityConfig[]>(seed);
  const [selectedId, setSelectedId] = useState(seed[0].id);
  const [draft, setDraft] = useState<CityConfig>(seed[0]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem(storageKey);
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved) as CityConfig[];
      if (parsed.length) {
        const timer = window.setTimeout(() => { setCities(parsed); setSelectedId(parsed[0].id); setDraft(parsed[0]); }, 0);
        return () => window.clearTimeout(timer);
      }
    } catch { /* Keep safe test defaults. */ }
  }, []);

  const selected = useMemo(() => cities.find(city => city.id === selectedId) ?? cities[0], [cities, selectedId]);
  const choose = (city: CityConfig) => { setSelectedId(city.id); setDraft(structuredClone(city)); setCreating(false); };
  const newCity = () => { const city = blankCity(); setDraft(city); setSelectedId(city.id); setCreating(true); };
  const updateService = (name: typeof serviceNames[number], patch: Partial<ServicePrice>) =>
    setDraft(current => ({ ...current, services: { ...current.services, [name]: { ...current.services[name], ...patch } } }));
  const save = () => {
    if (!draft.city.trim() || !draft.state.trim()) return notify("City and state are required");
    if (!draft.centre.trim() && !draft.pincodes.trim()) return notify("Add centre coordinates or serviceable pincodes");
    if (draft.radiusKm < 1) return notify("Service radius must be at least 1 km");
    const next = creating ? [...cities, draft] : cities.map(city => city.id === draft.id ? draft : city);
    setCities(next); window.localStorage.setItem(storageKey, JSON.stringify(next)); setCreating(false);
    notify(`${draft.city} city configuration saved as ${draft.status}`);
  };

  return <>
    <section className={styles.offerHero}><div><span>CITY & GEOFENCE MANAGEMENT · TEST MODE</span><h2>Launch a city with its own coverage and prices.</h2><p>Create the service boundary, enable only launch-ready services and assign GST-inclusive starting prices before publishing.</p></div><button onClick={newCity}>＋ Add new city</button></section>
    <section className={styles.metrics}>{[
      ["Configured cities", String(cities.length), `${cities.filter(city=>city.status==="Live").length} live`],
      ["Live geofences", String(cities.filter(city=>city.status==="Live").length), "Radius/pincode rules"],
      ["Services enabled", String(cities.reduce((n,city)=>n+serviceNames.filter(service=>city.services[service].enabled).length,0)), "Across all cities"],
      ["Approval state", "Draft first", "Validate → approve → publish"],
    ].map(item=><article key={item[0]}><span>{item[0]}</span><strong>{item[1]}</strong><small>{item[2]}</small></article>)}</section>
    <section className={styles.cityLayout}>
      <aside className={styles.cityList}><div className={styles.head}><div><span>CITY DIRECTORY</span><h2>Launch markets</h2></div></div>{cities.map(city=><button key={city.id} className={selectedId===city.id&&!creating?styles.citySelected:""} onClick={()=>choose(city)}><div><strong>{city.city}</strong><small>{city.state} · {city.radiusKm} km geofence</small></div><b>{city.status}</b></button>)}</aside>
      <section className={styles.cityEditor}>
        <div className={styles.head}><div><span>{creating?"NEW CITY DRAFT":"CITY CONFIGURATION"}</span><h2>{creating?"Add launch city":selected?.city}</h2></div><b className={styles.testBadge}>No live Maps connection</b></div>
        <div className={styles.cityFields}>
          <label>City<input value={draft.city} placeholder="e.g. Chennai" onChange={e=>setDraft({...draft,city:e.target.value})}/></label>
          <label>State<input value={draft.state} placeholder="e.g. Tamil Nadu" onChange={e=>setDraft({...draft,state:e.target.value})}/></label>
          <label>Launch status<select value={draft.status} onChange={e=>setDraft({...draft,status:e.target.value as CityConfig["status"]})}><option>Draft</option><option>Pilot</option><option>Live</option><option>Paused</option></select></label>
          <label>Coverage radius (km)<input type="number" min="1" value={draft.radiusKm} onChange={e=>setDraft({...draft,radiusKm:Number(e.target.value)})}/></label>
          <label className={styles.wideField}>Geofence centre · latitude, longitude<input value={draft.centre} placeholder="13.0827, 80.2707" onChange={e=>setDraft({...draft,centre:e.target.value})}/></label>
          <label className={styles.wideField}>Serviceable pincodes / clusters<input value={draft.pincodes} placeholder="600001, 600002, OMR, Anna Nagar" onChange={e=>setDraft({...draft,pincodes:e.target.value})}/></label>
        </div>
        <div className={styles.geofencePreview}><i></i><b>●</b><div><strong>{draft.city||"New city"} geofence</strong><span>{draft.radiusKm} km around {draft.centre||"selected centre"}</span><small>Customer address must fall inside the active radius or approved pincodes.</small></div></div>
        <div className={styles.servicePriceHead}><div><span>CITY PRICE BOOK</span><h3>Services and starting prices</h3></div><label><input type="checkbox" checked={draft.gstIncluded} onChange={e=>setDraft({...draft,gstIncluded:e.target.checked})}/> Prices include GST</label></div>
        <div className={styles.servicePrices}>{serviceNames.map(service=><article key={service} className={draft.services[service].enabled?styles.serviceEnabled:""}><button aria-label={`Toggle ${service}`} onClick={()=>updateService(service,{enabled:!draft.services[service].enabled})}><i></i></button><div><strong>{service}</strong><small>{draft.services[service].enabled?"Bookable in this city":"Not launched"}</small></div><label>Starting at ₹<input type="number" min="0" value={draft.services[service].price} disabled={!draft.services[service].enabled} onChange={e=>updateService(service,{price:Number(e.target.value)})}/></label></article>)}</div>
        <div className={styles.cityFooter}><div><span>Publish protection</span><strong>Draft → validate coverage & prices → owner approval → city goes live</strong></div><button onClick={save}>{creating?"Save city draft":"Save configuration"}</button></div>
      </section>
    </section>
  </>;
}
