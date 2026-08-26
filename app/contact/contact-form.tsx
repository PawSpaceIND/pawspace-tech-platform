"use client";
import{useState}from"react";
import styles from"../components/marketing/premium-marketing.module.css";

export default function ContactForm(){
  const[status,setStatus]=useState<"idle"|"sending"|"sent"|"error">("idle");
  const[error,setError]=useState("");

  async function onSubmit(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();
    setStatus("sending");setError("");
    const form=event.currentTarget,data=new FormData(form);
    const body={name:String(data.get("name")||""),phone:String(data.get("phone")||""),email:String(data.get("email")||""),service:String(data.get("service")||""),message:String(data.get("message")||""),whatsappConsent:data.get("whatsappConsent")==="yes"};
    try{
      const response=await fetch("/api/public-contact",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
      const result=await response.json() as{error?:string};
      if(!response.ok){setError(result.error||"Something went wrong - please try again.");setStatus("error");return;}
      setStatus("sent");form.reset();
    }catch{setError("Something went wrong - please check your connection and try again.");setStatus("error");}
  }

  if(status==="sent")return <div className={styles.card} style={{padding:28,textAlign:"center"}}>
    <h3>Thanks — we&apos;ve got it.</h3>
    <p>Our team will reach out within a couple of hours.</p>
  </div>;

  return <form onSubmit={onSubmit} style={{display:"grid",gap:14}}>
    <div style={{display:"grid",gap:14,gridTemplateColumns:"1fr 1fr"}}>
      <label>Your name<input name="name" required minLength={2} placeholder="e.g. Ananya Rao" style={inputStyle}/></label>
      <label>Phone number<input name="phone" type="tel" required pattern="[0-9+\s-]{10,15}" placeholder="98765 43210" style={inputStyle}/></label>
    </div>
    <div style={{display:"grid",gap:14,gridTemplateColumns:"1fr 1fr"}}>
      <label>Email (optional)<input name="email" type="email" placeholder="you@example.com" style={inputStyle}/></label>
      <label>Service you&apos;re asking about<select name="service" style={inputStyle}>
        <option>General enquiry</option><option>Grooming</option><option>Dog Training</option><option>Boarding</option>
        <option>Pet Sitting</option><option>Dog Walking</option><option>Pet Taxi</option><option>Fresh Food</option>
        <option>Relocation</option><option>Doorstep Vet</option><option>Pet Farewell Support</option>
      </select></label>
    </div>
    <label>Message (optional)<textarea name="message" rows={4} placeholder="Tell us a bit more about what you need" style={{...inputStyle,resize:"vertical" as const}}/></label>
    <label style={{display:"flex",alignItems:"flex-start",gap:9,fontSize:13,lineHeight:1.45}}><input name="whatsappConsent" value="yes" type="checkbox" style={{marginTop:3}}/> I agree that PawSpace may send one WhatsApp response about this enquiry. This is not marketing, and I can reply STOP at any time.</label>
    {error?<p style={{color:"#b3261e",fontSize:13,margin:0}}>{error}</p>:null}
    <button type="submit" disabled={status==="sending"} className={styles.primary} style={{justifySelf:"start",border:0,cursor:"pointer"}}>
      {status==="sending"?"Sending…":"Send message"}
    </button>
  </form>;
}

const inputStyle:React.CSSProperties={display:"block",width:"100%",marginTop:6,padding:"11px 13px",borderRadius:10,border:"1px solid var(--ps-border)",font:"inherit",background:"#fff"};
