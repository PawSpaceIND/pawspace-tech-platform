"use client";

import { useMemo, useState } from "react";
import {
  readOfferConfig,
  saveOfferConfig,
  type CouponRule,
  type CustomerKind,
  type OfferChannel,
  type PawspaceCity,
  type PawspaceService,
} from "../../lib/offer-engine";
import baseStyles from "./control.module.css";
import offerStyles from "./offers-control-panel.module.css";

const styles = { ...baseStyles, ...offerStyles };
const money = (value:number) => `₹${value.toLocaleString("en-IN")}`;
const services:PawspaceService[] = ["Grooming","Dog Training","Boarding","Pet Sitting"];
const cities:PawspaceCity[] = ["Bengaluru","Mumbai","Delhi NCR","Hyderabad","Chennai","Pune"];
const channels:OfferChannel[] = ["Customer app","Website","CRM assisted","WhatsApp","Partner app"];
const customers:{id:CustomerKind;label:string}[] = [{id:"new",label:"New"},{id:"existing",label:"Existing"},{id:"subscriber",label:"Subscriber"}];

function blankCoupon():CouponRule {
  return {
    id:`coupon-${Date.now()}`,code:"",name:"",active:false,customerKinds:["new","existing"],services:["Grooming"],cities:["Bengaluru"],channels:["Customer app","Website","CRM assisted"],packageScope:"all",packageNames:[],crossSellFromServices:[],firstOrderOnly:false,orderNumberFrom:null,orderNumberTo:null,minOrder:999,maxOrder:null,subscriptionEligible:false,fullPaymentOnly:false,discountType:"fixed",discountValue:200,maxDiscount:200,perCustomerLimit:1,totalLimit:1000,used:0,validUntil:"2026-12-31",
  };
}

export default function CouponsControlPanel({notify}:{notify:(message:string)=>void}) {
  const [config,setConfig] = useState(()=>readOfferConfig());
  const [query,setQuery] = useState("");
  const [status,setStatus] = useState<"all"|"active"|"paused">("all");
  const [editing,setEditing] = useState<CouponRule|null>(null);
  const [draft,setDraft] = useState<CouponRule>(()=>blankCoupon());
  const persist = (next:typeof config,message:string) => {setConfig(next);saveOfferConfig(next);notify(message);};
  const filtered = useMemo(()=>config.coupons.filter(c=>(!query||`${c.code} ${c.name}`.toLowerCase().includes(query.toLowerCase()))&&(status==="all"||(status==="active"?c.active:!c.active))),[config.coupons,query,status]);
  const toggle = <T,>(list:T[],value:T)=>list.includes(value)?list.filter(item=>item!==value):[...list,value];
  const openCreate=()=>{setEditing(null);setDraft(blankCoupon());};
  const openEdit=(coupon:CouponRule)=>{setEditing(coupon);setDraft({...coupon,customerKinds:[...coupon.customerKinds],services:[...coupon.services],cities:[...coupon.cities],channels:[...coupon.channels],packageNames:[...coupon.packageNames],crossSellFromServices:[...coupon.crossSellFromServices]});};
  const save=()=>{
    const code=draft.code.trim().toUpperCase().replace(/\s+/g,"");
    if(!code||!draft.name.trim()) return notify("Add a coupon code and campaign name");
    if(!draft.services.length||!draft.cities.length||!draft.customerKinds.length) return notify("Select at least one service, city and customer type");
    if(config.coupons.some(c=>c.code===code&&c.id!==editing?.id)) return notify("That coupon code already exists");
    const next={...draft,code,name:draft.name.trim(),active:true};
    const coupons=editing?config.coupons.map(c=>c.id===editing.id?next:c):[next,...config.coupons];
    persist({...config,coupons},editing?"Coupon changes published to test rules":"New coupon created in test mode");setEditing(null);setDraft(blankCoupon());
  };
  const clone=(coupon:CouponRule)=>{setEditing(null);setDraft({...coupon,id:`coupon-${Date.now()}`,code:`${coupon.code}COPY`,name:`${coupon.name} copy`,active:false,used:0});};
  const changeStatus=(coupon:CouponRule)=>persist({...config,coupons:config.coupons.map(c=>c.id===coupon.id?{...c,active:!c.active}:c)},coupon.active?"Coupon paused":"Coupon activated");
  const redemptions=config.coupons.reduce((sum,c)=>sum+c.used,0);
  return <>
    <section className={styles.offerHero}><div><span>COUPON MANAGEMENT · TEST MODE</span><h2>Create, target and control every PawSpace offer.</h2><p>Run acquisition, retention, subscription and cross-sell coupons by service, city, customer, order, package, channel and payment rule.</p></div><button onClick={openCreate}>＋ Create coupon</button></section>
    <section className={styles.metrics}>{[["Active coupons",String(config.coupons.filter(c=>c.active).length),`${config.coupons.length} total campaigns`],["Redemptions",redemptions.toLocaleString("en-IN"),"Test usage across services"],["Cross-sell rules",String(config.coupons.filter(c=>c.crossSellFromServices.length).length),"Previous service → next service"],["Cities enabled",String(new Set(config.coupons.flatMap(c=>c.cities)).size),"Location-level eligibility"]].map(x=><article key={x[0]}><span>{x[0]}</span><strong>{x[1]}</strong><small>{x[2]}</small></article>)}</section>
    <section className={styles.couponWorkspace}>
      <div className={styles.panel}>
        <div className={styles.toolbar}><div><span>COUPON DIRECTORY</span><h2>Campaigns and rules</h2></div><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search code or campaign" aria-label="Search coupons"/><select value={status} onChange={e=>setStatus(e.target.value as typeof status)}><option value="all">All statuses</option><option value="active">Active</option><option value="paused">Paused</option></select></div>
        <div className={styles.couponHead}><span>Campaign</span><span>Offer</span><span>Eligibility</span><span>Usage</span><span>Status</span><span>Actions</span></div>
        {filtered.map(c=><article className={styles.couponRow} key={c.id}>
          <div><b>{c.code}</b><strong>{c.name}</strong><small>Until {new Date(`${c.validUntil}T00:00:00`).toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"})}</small></div>
          <div><strong>{c.discountType==="fixed"?money(c.discountValue):`${c.discountValue}% off`}</strong><small>{c.maxDiscount?`Cap ${money(c.maxDiscount)}`:"No cap"} · Min {money(c.minOrder)}</small></div>
          <div><strong>{c.services.length===services.length?"All services":c.services.join(", ")}</strong><small>{c.cities.length===cities.length?"All cities":c.cities.join(", ")} · {c.customerKinds.map(k=>customers.find(x=>x.id===k)?.label).join(" / ")}</small>{c.crossSellFromServices.length>0&&<em>Cross-sell from {c.crossSellFromServices.join(", ")}</em>}</div>
          <div><strong>{c.used.toLocaleString("en-IN")} / {c.totalLimit.toLocaleString("en-IN")}</strong><i><span style={{width:`${Math.min(100,c.used/c.totalLimit*100)}%`}}/></i><small>{Math.round(c.used/c.totalLimit*100)}% consumed</small></div>
          <button className={c.active?styles.liveStatus:styles.pausedStatus} onClick={()=>changeStatus(c)}>{c.active?"● Active":"Paused"}</button>
          <div className={styles.rowActions}><button onClick={()=>openEdit(c)}>Edit</button><button onClick={()=>clone(c)}>Duplicate</button></div>
        </article>)}
        {!filtered.length&&<div className={styles.empty}>No coupons match these filters.</div>}
      </div>
      <aside className={styles.panel}>
        <div className={styles.builderHead}><div><span>{editing?"EDIT COUPON":"COUPON BUILDER"}</span><h2>{editing?editing.code:"New campaign"}</h2></div>{(editing||draft.code||draft.name)&&<button onClick={()=>{setEditing(null);setDraft(blankCoupon())}}>Clear</button>}</div>
        <div className={styles.builderScroll}>
          <div className={styles.formPair}><label>Coupon code<input value={draft.code} onChange={e=>setDraft({...draft,code:e.target.value.toUpperCase()})} placeholder="E.g. BNGGROOM300"/></label><label>Campaign name<input value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})} placeholder="Bengaluru grooming win-back"/></label></div>
          <h3>Discount and order</h3><div className={styles.formPair}><label>Discount type<select value={draft.discountType} onChange={e=>setDraft({...draft,discountType:e.target.value as "fixed"|"percent"})}><option value="fixed">Fixed ₹ off</option><option value="percent">Percentage off</option></select></label><label>Discount value<input type="number" min="1" value={draft.discountValue} onChange={e=>setDraft({...draft,discountValue:Number(e.target.value)})}/></label><label>Maximum discount<input type="number" min="0" value={draft.maxDiscount??""} onChange={e=>setDraft({...draft,maxDiscount:e.target.value?Number(e.target.value):null})}/></label><label>Minimum order<input type="number" min="0" value={draft.minOrder} onChange={e=>setDraft({...draft,minOrder:Number(e.target.value)})}/></label></div>
          <h3>Customer eligibility</h3><div className={styles.choiceGrid}>{customers.map(x=><button key={x.id} className={draft.customerKinds.includes(x.id)?styles.selectedChoice:""} onClick={()=>setDraft({...draft,customerKinds:toggle(draft.customerKinds,x.id)})}>{x.label} customer</button>)}</div>
          <div className={styles.checkRows}><label><input type="checkbox" checked={draft.firstOrderOnly} onChange={e=>setDraft({...draft,firstOrderOnly:e.target.checked})}/> First order only</label><label><input type="checkbox" checked={draft.subscriptionEligible} onChange={e=>setDraft({...draft,subscriptionEligible:e.target.checked})}/> Allow on subscriptions</label><label><input type="checkbox" checked={draft.fullPaymentOnly} onChange={e=>setDraft({...draft,fullPaymentOnly:e.target.checked})}/> 100% payment only</label></div>
          <h3>Service receiving the coupon</h3><div className={styles.choiceGrid}>{services.map(x=><button key={x} className={draft.services.includes(x)?styles.selectedChoice:""} onClick={()=>setDraft({...draft,services:toggle(draft.services,x)})}>{x}</button>)}</div>
          <h3>Cross-sell source <small>Optional</small></h3><p className={styles.help}>Example: choose Grooming here and Dog Training above to reward a grooming customer who books training.</p><div className={styles.choiceGrid}>{services.map(x=><button key={x} className={draft.crossSellFromServices.includes(x)?styles.crossChoice:""} onClick={()=>setDraft({...draft,crossSellFromServices:toggle(draft.crossSellFromServices,x)})}>{x}</button>)}</div>
          <h3>City availability</h3><div className={styles.choiceGrid}>{cities.map(x=><button key={x} className={draft.cities.includes(x)?styles.selectedChoice:""} onClick={()=>setDraft({...draft,cities:toggle(draft.cities,x)})}>{x}</button>)}</div>
          <h3>Booking channels</h3><div className={styles.choiceGrid}>{channels.map(x=><button key={x} className={draft.channels.includes(x)?styles.selectedChoice:""} onClick={()=>setDraft({...draft,channels:toggle(draft.channels,x)})}>{x}</button>)}</div>
          <h3>Package scope</h3><label className={styles.fullField}>Applies to<select value={draft.packageScope} onChange={e=>setDraft({...draft,packageScope:e.target.value as CouponRule["packageScope"]})}><option value="all">All eligible packages</option><option value="single_session">Single sessions only</option><option value="subscription">Subscriptions only</option><option value="selected">Selected package names</option></select></label>{draft.packageScope==="selected"&&<label className={styles.fullField}>Package names<input value={draft.packageNames.join(", ")} onChange={e=>setDraft({...draft,packageNames:e.target.value.split(",").map(x=>x.trim()).filter(Boolean)})} placeholder="Bath & Basic, Foundation Training"/></label>}
          <h3>Limits and schedule</h3><div className={styles.formPair}><label>Per customer<input type="number" min="1" value={draft.perCustomerLimit} onChange={e=>setDraft({...draft,perCustomerLimit:Number(e.target.value)})}/></label><label>Overall uses<input type="number" min="1" value={draft.totalLimit} onChange={e=>setDraft({...draft,totalLimit:Number(e.target.value)})}/></label><label>Valid until<input type="date" value={draft.validUntil} onChange={e=>setDraft({...draft,validUntil:e.target.value})}/></label><label>Maximum order<input type="number" value={draft.maxOrder??""} onChange={e=>setDraft({...draft,maxOrder:e.target.value?Number(e.target.value):null})} placeholder="No maximum"/></label></div>
        </div>
        <div className={styles.builderFooter}><div><span>Test impact</span><strong>{draft.services.length} services · {draft.cities.length} cities · {draft.customerKinds.length} segments</strong></div><button onClick={save}>{editing?"Save changes":"Create coupon"}</button></div>
      </aside>
    </section>
  </>;
}
