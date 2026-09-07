"use client";
import{useState}from"react";
import{useQueryParameter}from"../../lib/use-query-parameter";
import styles from"./landing-pages.module.css";

const adParam=(value:string|null,max=180)=>String(value||"").trim().slice(0,max);

export default function LandingLeadForm({service,pet,formTitle,formCta}:{service:string;pet:string;formTitle:string;formCta:string}){
  const[status,setStatus]=useState<"idle"|"sending"|"sent"|"error">("idle");
  const[error,setError]=useState("");
  const gclid=useQueryParameter("gclid"),fbclid=useQueryParameter("fbclid"),wbraid=useQueryParameter("wbraid"),utmSource=useQueryParameter("utm_source"),utmMedium=useQueryParameter("utm_medium"),utmCampaign=useQueryParameter("utm_campaign"),campaignId=useQueryParameter("campaign_id"),adId=useQueryParameter("ad_id");

  async function onSubmit(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();
    setStatus("sending");setError("");
    const form=event.currentTarget,data=new FormData(form);
    const body={
      name:String(data.get("name")||""),
      phone:String(data.get("phone")||""),
      area:String(data.get("area")||""),
      petNames:pet,
      service,
      whatsappConsent:data.get("whatsappConsent")==="yes",
      gclid:adParam(gclid),
      fbclid:adParam(fbclid),
      wbraid:adParam(wbraid),
      utmSource:adParam(utmSource,120),
      utmMedium:adParam(utmMedium,120),
      utmCampaign:adParam(utmCampaign),
      campaignId:adParam(campaignId),
      adId:adParam(adId),
      landingUrl:window.location.href.slice(0,500),
    };
    try{
      const response=await fetch("/api/public-contact",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
      const result=await response.json() as{error?:string};
      if(!response.ok){setError(result.error||"Something went wrong - please try again.");setStatus("error");return;}
      setStatus("sent");form.reset();
    }catch{setError("Something went wrong - please check your connection and try again.");setStatus("error");}
  }

  if(status==="sent")return <div className={styles.formCard} style={{textAlign:"center"}}>
    <h2>Thanks — we&apos;ve got it.</h2>
    <p>Our team will call you within a couple of hours to confirm availability and next steps.</p>
  </div>;

  return <div className={styles.formCard}>
    <h2>{formTitle}</h2>
    <p>Share your number and we&apos;ll call to confirm availability, pricing and your booking.</p>
    <form className={styles.formGrid} onSubmit={onSubmit}>
      <input aria-label="Your name" name="name" required minLength={2} placeholder="Your name"/>
      <input aria-label="Phone number" name="phone" type="tel" required pattern="[0-9+\s-]{10,15}" placeholder="Phone number"/>
      <input aria-label="Area or location" name="area" placeholder="Area / location"/>
      <select aria-label="Pet type" name="pet" disabled><option>{pet}</option></select>
      <label style={{gridColumn:"1 / -1",display:"flex",gap:8,alignItems:"flex-start",fontSize:12,lineHeight:1.4}}><input name="whatsappConsent" value="yes" type="checkbox"/> I agree that PawSpace may send one WhatsApp response about this enquiry. This is not marketing, and I can reply STOP at any time.</label>
      {error?<p style={{color:"#b3261e",fontSize:13,margin:0,gridColumn:"1 / -1"}}>{error}</p>:null}
      <button type="submit" disabled={status==="sending"}>{status==="sending"?"Sending…":formCta}</button>
    </form>
    <p>🔒 Your details go straight to our real booking team — the same pipeline as pawspace.in/contact.</p>
  </div>;
}