"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { createAssistedOrder, loadAssistedOrderConfig, type AssistedOrderConfig, type AssistedOrderResult } from "../../lib/assisted-orders-client";
import styles from "./assisted.module.css";

function localInput(days:number,hour:number){const date=new Date();date.setDate(date.getDate()+days);date.setHours(hour,0,0,0);const pad=(value:number)=>String(value).padStart(2,"0");return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;}
const money=(value:number)=>`₹${value.toLocaleString("en-IN")}`;

export default function AssistedBooking(){
  const [config,setConfig]=useState<AssistedOrderConfig|null>(null);
  const [selected,setSelected]=useState(0);
  const [packageCode,setPackageCode]=useState("");
  const [scheduledStart,setScheduledStart]=useState(()=>localInput(1,10));
  const [scheduledEnd,setScheduledEnd]=useState(()=>localInput(1,12));
  const [consentMethod,setConsentMethod]=useState<"recorded_call"|"whatsapp"|"email"|"in_person">("recorded_call");
  const [consentReference,setConsentReference]=useState("UAT-CALL-REF-001");
  const [consentCaptured,setConsentCaptured]=useState(true);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState("");
  const [error,setError]=useState("");
  const [result,setResult]=useState<AssistedOrderResult|null>(null);

  useEffect(()=>{let active=true;void loadAssistedOrderConfig().then(data=>{if(!active)return;setConfig(data);setPackageCode(data.packages[0]?.code??"");}).catch(err=>{if(active)setError(err instanceof Error?err.message:"Unable to load Assisted Orders UAT")});return()=>{active=false};},[]);
  const customer=config?.customers[selected]??null;
  const eligiblePackages=useMemo(()=>{const species=customer?.pets[0]?.species;return config?.packages.filter(item=>!species||item.eligiblePetTypes.includes(species))??[];},[config,customer]);
  const selectedPackage=eligiblePackages.find(item=>item.code===packageCode)??eligiblePackages[0];
  const effectivePackageCode=selectedPackage?.code??"";

  async function submit(event:FormEvent){event.preventDefault();if(!customer||!selectedPackage)return;setBusy(true);setError("");setNotice("");setResult(null);try{
    const idempotencyKey=`uat-${customer.id}-${selectedPackage.code}-${scheduledStart}`.replace(/[^A-Za-z0-9:_-]/g,"-");
    const created=await createAssistedOrder({idempotencyKey,customer:{id:customer.id,name:customer.name,primaryPhone:customer.primaryPhone,secondaryPhone:customer.secondaryPhone,email:customer.email},pets:customer.pets,cityId:"blr",zoneId:"blr-east",packageCode:selectedPackage.code,scheduledStart:new Date(scheduledStart).toISOString(),scheduledEnd:new Date(scheduledEnd).toISOString(),consent:{captured:consentCaptured,method:consentMethod,reference:consentReference}});
    setResult(created);setNotice(created.duplicatePrevented?"Existing UAT assisted order returned safely":"Canonical UAT assisted order created");
  }catch(err){setError(err instanceof Error?err.message:"Unable to create Assisted Order UAT");}finally{setBusy(false);}}

  return <div className={styles.shell}>
    <aside>
      <Link href="/admin" className={styles.brand}><span>paw</span>space <small>OPS</small></Link>
      <nav><Link href="/admin">Overview</Link><Link href="/crm">Customer 360</Link><Link className={styles.active} href="/assisted-booking">Assisted orders</Link><Link href="/ops">Finance & People</Link><Link href="/control">Platform control</Link><Link href="/partner-app">Partner app</Link></nav>
      <div className={styles.access}><b>UAT ONLY</b><small>Staff identity required</small><small>Canonical booking + scheduler</small><small>No live money</small></div>
    </aside>
    <main>
      {notice&&<div className={styles.toast}>✓ {notice}</div>}
      <header><div><small>ASSISTED ORDERS · TESTING GATE</small><h1>Create an order for a customer</h1><p>Staff-assisted Grooming orders now use the same canonical scheduler and booking ledger as the governed customer flow. This page is for testing only.</p></div><div className={styles.headerMeta}><span>⌾ Bengaluru UAT</span><button disabled>{config?.environment??"Loading"}</button></div></header>
      <section className={styles.stats}><article><small>Live money</small><b>OFF</b><em>Pay-after-service test state</em></article><article><small>Commercial truth</small><b>SERVER</b><em>Browser does not set final price</em></article><article><small>Assignment</small><b>CANONICAL</b><em>Existing UAT scheduler</em></article><article><small>Audit</small><b>ON</b><em>Staff + consent evidence</em></article></section>
      <div className={styles.grid}>
        <section className={styles.customerPanel}>
          <div className={styles.panelHead}><div><small>STEP 1</small><h2>Select UAT customer</h2></div></div>
          <div className={styles.security}>Synthetic test identities only. Production customer migration is not part of this gate.</div>
          <div className={styles.customerList}>{config?.customers.map((item,index)=><button key={item.id} className={selected===index?styles.selected:""} onClick={()=>{setSelected(index);setPackageCode("");setResult(null)}}><span>{item.name.split(" ").map(part=>part[0]).join("")}</span><div><b>{item.name}</b><small>{item.primaryPhone.replace(/(\d{5})\d{3}(\d{2})$/, "$1•••$2")} · {item.pets.map(p=>p.name).join(", ")}</small><em className={styles.repeat}>UAT fixture</em></div><strong>{item.id}</strong></button>)}</div>
        </section>
        <section className={styles.workspace}>
          <div className={styles.customerHead}><div className={styles.avatar}>{customer?.name.split(" ").map(part=>part[0]).join("")||"UAT"}</div><div><small>CANONICAL ASSISTED ORDER · GROOMING ONLY</small><h2>{customer?.name??"Loading test customer…"}</h2><p>{customer?.pets.map(p=>`${p.name} · ${p.species}`).join(" · ")}</p></div><span className={styles.health}>Test only</span></div>
          <form className={styles.builder} onSubmit={submit}>
            <div className={styles.stage}><small>SERVER-GOVERNED PACKAGE</small><h3>Choose the Grooming service to test</h3><div className={styles.serviceGrid}>{eligiblePackages.map(item=><button type="button" className={effectivePackageCode===item.code?styles.chosen:""} key={item.code} onClick={()=>setPackageCode(item.code)}><span>✂</span><b>{item.name}</b><small>{money(item.singlePrice)} single · {money(item.multiPetPrice)} multi-pet</small></button>)}</div><div className={styles.info}>Displayed catalogue values come from the server. The server recomputes the final governed amount when the assisted order is created.</div></div>
            <div className={styles.stage}><small>CANONICAL SCHEDULE</small><h3>Choose the UAT service window</h3><div className={styles.two}><label>Start<input type="datetime-local" value={scheduledStart} onChange={e=>setScheduledStart(e.target.value)} required/></label><label>End<input type="datetime-local" value={scheduledEnd} onChange={e=>setScheduledEnd(e.target.value)} required/></label></div><div className={styles.assignment}><div><b>Assignment rule</b><p>The staff member does not choose or fabricate a provider. The existing canonical UAT scheduler selects and reserves the eligible provider.</p></div><span>Auto</span></div></div>
            <div className={styles.stage}><small>CUSTOMER AUTHORITY</small><h3>Capture consent evidence</h3><div className={styles.two}><label>Consent method<select value={consentMethod} onChange={e=>setConsentMethod(e.target.value as typeof consentMethod)}><option value="recorded_call">Recorded call</option><option value="whatsapp">WhatsApp</option><option value="email">Email</option><option value="in_person">In person</option></select></label><label>Evidence reference<input value={consentReference} onChange={e=>setConsentReference(e.target.value)} required minLength={5}/></label></div><label className={styles.consent}><input type="checkbox" checked={consentCaptured} onChange={e=>setConsentCaptured(e.target.checked)}/> Customer explicitly authorized PawSpace staff to create this test booking.</label></div>
            <div className={styles.stage}><small>FINAL TEST BOUNDARY</small><h3>Create canonical UAT order</h3><div className={styles.review}><div><small>Service</small><b>Grooming · {selectedPackage?.name??"—"}</b></div><div><small>Customer</small><b>{customer?.name??"—"}</b></div><div><small>Payment</small><b>Pay after service · ₹0 due now</b></div><div><small>Channel</small><b>assisted_staff</b></div><div><small>Pricing</small><b>Server governed</b></div><div><small>Environment</small><b>UAT only</b></div></div><div className={styles.confirmActions}><button className={styles.primary} disabled={busy||!customer||!selectedPackage||!consentCaptured}>{busy?"Creating canonical test order…":"Create UAT assisted order"}</button></div>{error&&<div className={styles.security}>{error}</div>}</div>
          </form>
          {result&&<div className={styles.stage}><small>CANONICAL RESULT</small><h3>{result.bookingId}</h3><div className={styles.review}><div><small>Assisted order</small><b>{result.assistedOrderId}</b></div><div><small>Provider</small><b>{result.provider.name}</b></div><div><small>Governed total</small><b>{money(result.totalAmount)}</b></div><div><small>Due now</small><b>{money(result.amountDueNow)}</b></div><div><small>Duplicate safe</small><b>{result.duplicatePrevented?"Existing order reused":"New order"}</b></div><div><small>Live money</small><b>{result.liveMoney?"Unexpected":"No"}</b></div></div></div>}
        </section>
      </div>
      <section className={styles.truth}><div><small>TEST-FIRST RULE</small><h2>This module is built to be tested, not launched.</h2><p>After CI is green we still require staff UAT, permission-negative tests, booking/retry/idempotency checks and controlled test evidence before the Assisted Orders gate can be called closed.</p></div><div className={styles.truthGrid}><span>Staff-only boundary</span><span>Consent evidence</span><span>Canonical scheduler</span><span>Canonical booking</span><span>Server pricing</span><span>No live money</span><span>Idempotency</span><span>Security audit</span></div></section>
    </main>
  </div>;
}
