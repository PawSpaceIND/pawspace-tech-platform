"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import styles from "./assisted.module.css";

const customers = [
  { name:"Meera Shah", phone:"+91 98••• ••418", type:"Subscription", pets:"Bruno, Misty", city:"Bengaluru", due:"Session due today", value:"₹26,440" },
  { name:"Rohan Rao", phone:"+91 99••• ••072", type:"Repeat", pets:"Oreo", city:"Bengaluru", due:"Last service 31 days ago", value:"₹9,594" },
  { name:"Ananya Iyer", phone:"+91 97••• ••622", type:"New", pets:"New pet", city:"Bengaluru", due:"Google Ads lead · 8 min", value:"₹0" },
];

const services = ["Grooming","Dog Training","Boarding","Pet Sitting","Dog Walking","Pet Taxi","Fresh Food"];
const slots = ["9–11 AM","11 AM–1 PM","1–3 PM","3–5 PM","5–7 PM"];

export default function AssistedBooking(){
  const [query,setQuery]=useState("");
  const [selected,setSelected]=useState(0);
  const [step,setStep]=useState(1);
  const [service,setService]=useState("Grooming");
  const [petCount,setPetCount]=useState(1);
  const [slot,setSlot]=useState("9–11 AM");
  const [notice,setNotice]=useState("");
  const [mask,setMask]=useState(true);
  const customer=customers[selected] ?? customers[0];
  const filtered=useMemo(()=>customers.filter(c=>`${c.name} ${c.phone} ${c.pets}`.toLowerCase().includes(query.toLowerCase())),[query]);
  const action=(message:string)=>{setNotice(message);setTimeout(()=>setNotice(""),2400)};
  return <div className={styles.shell}>
    <aside>
      <Link href="/admin" className={styles.brand}><span>paw</span>space <small>OPS</small></Link>
      <nav><Link href="/admin">Overview</Link><Link href="/crm">Customer 360</Link><Link className={styles.active} href="/assisted-booking">Assisted booking</Link><Link href="/ops">Finance & People</Link><Link href="/control">Platform control</Link><Link href="/partner-app">Partner app</Link></nav>
      <div className={styles.access}><b>Role: Sales Executive</b><small>Can create bookings</small><small>Cannot export customer data</small><small>Cannot view full phone numbers</small></div>
    </aside>
    <main>
      {notice&&<div className={styles.toast}>✓ {notice}</div>}
      <header><div><small>SALES & OPERATIONS WORKSPACE</small><h1>Book for a customer</h1><p>One assisted flow for new, repeat and subscription customers.</p></div><div className={styles.headerMeta}><span>⌾ Bengaluru</span><button onClick={()=>setMask(!mask)}>{mask?"Masked data on":"Supervisor reveal"}</button></div></header>
      <section className={styles.stats}><article><small>Due today</small><b>48</b><em>Subscription sessions</em></article><article><small>Repeat overdue</small><b>126</b><em>30+ days since service</em></article><article><small>New leads</small><b>31</b><em>Median response 6 min</em></article><article><small>Today’s assisted GMV</small><b>₹1.42L</b><em>74 bookings</em></article></section>
      <div className={styles.grid}>
        <section className={styles.customerPanel}>
          <div className={styles.panelHead}><div><small>STEP 1</small><h2>Find or create customer</h2></div><button onClick={()=>action("Quick customer creation opened")}>+ New customer</button></div>
          <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search name, primary number or pet…" />
          <div className={styles.filters}><button className={styles.on}>All</button><button>New</button><button>Repeat</button><button>Subscription</button><button>Renewal due</button></div>
          <div className={styles.customerList}>{filtered.map((c)=><button key={c.name} className={customers[selected]?.name===c.name?styles.selected:""} onClick={()=>setSelected(customers.indexOf(c))}><span>{c.name.split(" ").map(x=>x[0]).join("")}</span><div><b>{c.name}</b><small>{mask?c.phone:c.phone.replace("••• ••","876 54")} · {c.pets}</small><em className={styles[c.type.toLowerCase()]}>{c.type}</em></div><strong>{c.due}</strong></button>)}</div>
          <div className={styles.security}>⌾ Every view, search, reveal and booking action is written to the audit log.</div>
        </section>
        <section className={styles.workspace}>
          <div className={styles.customerHead}><div className={styles.avatar}>MS</div><div><small>CUSTOMER 360 · PS-C-10428</small><h2>{customer?.name}</h2><p>{customer?.phone} · {customer?.city} · Lifetime value {customer?.value}</p></div><span className={styles.health}>Healthy account</span></div>
          <div className={styles.customerTabs}><button className={styles.on}>Create booking</button><button>History 18</button><button>Subscriptions 1</button><button>Communication</button><button>Tickets</button></div>
          <div className={styles.builder}>
            <div className={styles.steps}>{["Service","Pets & package","Schedule","Confirm"].map((s,i)=><button key={s} className={step>=i+1?styles.done:""} onClick={()=>setStep(i+1)}><span>{step>i+1?"✓":i+1}</span>{s}</button>)}</div>
            {step===1&&<div className={styles.stage}><small>CHOOSE VERTICAL</small><h3>What does the customer need?</h3><div className={styles.serviceGrid}>{services.map((s,i)=><button className={service===s?styles.chosen:""} key={s} onClick={()=>setService(s)}><span>{["✂","⌁","⌂","♡","♟","↗","♨"][i]}</span><b>{s}</b><small>Live availability</small></button>)}</div><button className={styles.primary} onClick={()=>setStep(2)}>Continue with {service}</button></div>}
            {step===2&&<div className={styles.stage}><small>PETS & PACKAGE</small><h3>Build the service</h3><div className={styles.two}><label>Number of pets<select value={petCount} onChange={e=>setPetCount(Number(e.target.value))}><option>1</option><option>2</option><option>3</option><option>4</option><option value="5">5+ · Create enquiry</option></select></label><label>Customer type<select><option>{customer?.type}</option><option>One-time</option><option>Subscription</option></select></label><label>Package<select><option>Bath & Basic · ₹1,899</option><option>Essential Bath · ₹1,349</option><option>Complete Makeover · ₹2,399</option><option>Just Trim · ₹1,399</option></select></label><label>Sessions<select><option>1 session</option><option>3 sessions</option><option>6 sessions</option><option>12 sessions</option></select></label></div><div className={styles.info}>Pricing engine applied Bengaluru rates, {petCount}-pet rules, active subscription credits and eligible coupons.</div><button className={styles.primary} onClick={()=>setStep(3)}>Check live calendar</button></div>}
            {step===3&&<div className={styles.stage}><small>LIVE AVAILABILITY</small><h3>Select one or all subscription sessions</h3><div className={styles.scheduleMode}><button className={styles.on}>Book this session</button><button>Schedule every 15 days</button><button>Plan all sessions</button><button>Reminder only</button></div><div className={styles.dates}>{["Thu 6","Fri 7","Sat 8","Sun 9","Mon 10","Tue 11","Wed 12"].map((d,i)=><button className={i===2?styles.dateOn:""} key={d}>{d}<small>{i===2?"Selected":"3–8 slots"}</small></button>)}</div><div className={styles.slots}>{slots.map((s,i)=><button disabled={i===1} className={slot===s?styles.slotOn:""} key={s} onClick={()=>setSlot(s)}>{s}<small>{i===1?"Full":i===3?"2 groomers":"Available"}</small></button>)}</div><div className={styles.assignment}><div><b>Assignment preview</b><p>Full-time groomer: auto-assigned without acceptance. Commission groomer: offer expires in 3 minutes, then auto-routes to the next eligible partner.</p></div><span>3 eligible</span></div><button className={styles.primary} onClick={()=>setStep(4)}>Review booking</button></div>}
            {step===4&&<div className={styles.stage}><small>FINAL REVIEW</small><h3>Confirm on behalf of {customer?.name}</h3><div className={styles.review}><div><small>Service</small><b>{service} · Bath & Basic</b></div><div><small>Pets</small><b>{petCount} · Bruno</b></div><div><small>Slot</small><b>8 Aug · {slot}</b></div><div><small>Channel</small><b>Assisted · Sales</b></div><div><small>Payment</small><b>Pay after service</b></div><div><small>Total</small><b>₹{(1899*petCount).toLocaleString("en-IN")}</b></div></div><label className={styles.consent}><input type="checkbox" defaultChecked/> Customer consent captured on recorded call; confirmation goes to the primary number.</label><div className={styles.confirmActions}><button className={styles.primary} onClick={()=>action("Booking PS-GR-8518 confirmed; customer and provider notified")}>Confirm & send</button><button onClick={()=>action("Secure payment link sent to primary number")}>Send payment link</button><button onClick={()=>action("Booking saved as draft")}>Save draft</button></div></div>}
          </div>
        </section>
      </div>
      <section className={styles.automation}><div className={styles.panelHead}><div><small>AUTOMATION & GROWTH</small><h2>Customer lifecycle running in the background</h2></div><Link href="/crm">Open CRM automation →</Link></div><div className={styles.automationGrid}>{[["15-day care reminder","App + WhatsApp + optional call","8,420 enrolled"],["Subscription session due","Calendar deep-link","1,126 due"],["Renewal journey","15, 7, 1 days before expiry","284 active"],["App adoption","Assisted customers without app","63% opportunity"],["Cross-sell engine","Pet, history and lifecycle based","12 live journeys"],["Service recovery","Delay, cancellation and low rating","24×7 routing"]].map(x=><article key={x[0]}><span>⚡</span><b>{x[0]}</b><p>{x[1]}</p><small>{x[2]}</small></article>)}</div></section>
      <section className={styles.truth}><div><small>ONE SOURCE OF TRUTH</small><h2>MongoDB continuity and future-ready integration layer</h2><p>Existing customers, pets, subscriptions and bookings are migrated with immutable legacy IDs. New apps use versioned APIs so mobile, web, CRM, partner, finance and reporting always read the same record.</p></div><div className={styles.truthGrid}><span>Customer 360</span><span>Pet health timeline</span><span>Booking ledger</span><span>Subscription wallet</span><span>Provider & payout ledger</span><span>Consent & audit log</span><span>City pricing rules</span><span>Communication events</span></div></section>
    </main>
  </div>
}
