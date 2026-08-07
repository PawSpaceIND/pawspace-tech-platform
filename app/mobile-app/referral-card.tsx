"use client";
import { useState } from "react";
import { readOfferConfig } from "../../lib/offer-engine";
import styles from "./referral-card.module.css";

export default function ReferralCard(){
  const [copied,setCopied]=useState(false);
  const policy=readOfferConfig().referral;
  const share=async()=>{try{await navigator.clipboard.writeText("KARTHIK");}catch{}setCopied(true);setTimeout(()=>setCopied(false),1800)};
  return <section className={styles.card}><header><div><span>REFER & EARN</span><h3>Give ₹{policy.friendDiscount}. Get ₹{policy.referrerReward}.</h3></div><i>₹</i></header><p>Your friend saves on their first completed booking. Your reward unlocks for your next PawSpace booking.</p><div className={styles.code}><span>KARTHIK</span><button onClick={share}>{copied?"Copied ✓":"Copy & share"}</button></div><footer><b>0 / {policy.rewardsPerMonth} rewards this month</b><span>Valid {policy.rewardValidityDays} days · no stacking</span></footer></section>;
}
