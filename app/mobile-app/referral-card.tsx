"use client";
import { useEffect, useState } from "react";
import { ensureGovernedReferralCode, loadReferralDirectory } from "../../lib/referral-governance-client";
import type { ReferralProgramme } from "../../lib/referral-governance";
import type { LoggedInCustomer } from "./customer-login";
import styles from "./referral-card.module.css";

const monthStart = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
const amount = (value: number | null | undefined) => value == null ? "Configuration required" : `₹${value}`;

type Directory = { programmes: ReferralProgramme[]; rewards: Array<Record<string, unknown>> };

export default function ReferralCard({ customer }: { customer: LoggedInCustomer }){
  const [copied,setCopied]=useState(false);
  const [code,setCode]=useState("");
  const [programme,setProgramme]=useState<ReferralProgramme|null>(null);
  const [usedThisMonth,setUsedThisMonth]=useState(0);
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    let active=true;
    void Promise.all([
      ensureGovernedReferralCode(customer.customerId),
      loadReferralDirectory() as Promise<Directory>,
    ]).then(([codeResult,directory])=>{
      if(!active) return;
      setCode(codeResult.code);
      const active_programme=directory.programmes[0]??null;
      setProgramme(active_programme);
      if(active_programme){
        const since=monthStart();
        setUsedThisMonth(directory.rewards.filter(r=>String(r.referrer_customer_id)===customer.customerId && ["pending","released","uat_reserved"].includes(String(r.status)) && Number(r.created_at)>=since).length);
      }
    }).catch(err=>{ if(active) setError(err instanceof Error?err.message:"Unable to load referral programme"); })
      .finally(()=>{ if(active) setLoading(false); });
    return ()=>{ active=false; };
  },[customer.customerId]);

  const share=async()=>{ if(!code) return; try{await navigator.clipboard.writeText(code);}catch{} setCopied(true); setTimeout(()=>setCopied(false),1800); };

  if(loading) return <section className={styles.card}><header><div><span>REFER & EARN</span><h3>Loading your referral code…</h3></div><i>₹</i></header></section>;
  if(error || !programme) return <section className={styles.card}><header><div><span>REFER & EARN</span><h3>Referral programme unavailable</h3></div><i>₹</i></header><p>{error || "Unable to load canonical referral programme."}</p></section>;

  const isLive = programme.status === "active";
  return <section className={styles.card}>
    <header><div><span>REFER & EARN · {isLive ? "UAT" : "NOT LIVE"}</span><h3>Give {amount(programme.friendDiscount)}. Get {amount(programme.referrerReward)}.</h3></div><i>₹</i></header>
    <p>Your friend saves on their first completed booking. Your reward unlocks for your next PawSpace booking.{!isLive && " This programme is not active yet — codes work in UAT only."}</p>
    <div className={styles.code}><span>{code || "—"}</span><button disabled={!code} onClick={share}>{copied?"Copied ✓":"Copy & share"}</button></div>
    <footer><b>{usedThisMonth} / {programme.perReferrerMonthlyLimit ?? "Configuration required"} rewards this month</b><span>Valid {programme.rewardValidityDays ?? "configuration required"} days · no stacking</span></footer>
  </section>;
}
