"use client";
import Link from"next/link";
import{useEffect,useState}from"react";
import{StatCard}from"../../../components/ui";

type Row=Record<string,unknown>;
type Overview={modules:Array<Row&{id:string;title:string;service_code:string;status:string;version:number;pass_pct:number;required:number;quizQuestions:number;providersPassedCurrentVersion:number;totalAttempts:number}>;providers:Array<{providerId:string;name:string;trainingReady:boolean;requiredComplete:number;requiredTotal:number}>;metrics:{published:number;draft:number;providersNotReady:number}};

const label=(value:unknown)=>String(value||"—").replaceAll("_"," ").replace(/\b\w/g,letter=>letter.toUpperCase());

async function loadOverview():Promise<Overview>{const response=await fetch("/api/provider-lms",{cache:"no-store"});const body=await response.json();if(!response.ok)throw new Error(body.error||"Unable to load provider training");return body.data as Overview;}
async function act(input:Record<string,unknown>){const response=await fetch("/api/provider-lms",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});const body=await response.json();if(!response.ok)throw new Error(body.error||"Provider training action failed");return body.data as Row;}

export default function ProviderTrainingPage(){
 const[overview,setOverview]=useState<Overview|null>(null),[error,setError]=useState(""),[message,setMessage]=useState(""),[busy,setBusy]=useState(false);
 const[title,setTitle]=useState(""),[serviceCode,setServiceCode]=useState("all"),[summary,setSummary]=useState(""),[sections,setSections]=useState(""),[question,setQuestion]=useState(""),[options,setOptions]=useState(""),[answerIndex,setAnswerIndex]=useState("0"),[passPct,setPassPct]=useState("80");
 function refresh(){loadOverview().then(data=>{setOverview(data);setError("");}).catch(problem=>setError(problem instanceof Error?problem.message:"Unable to load provider training"));}
 useEffect(()=>{loadOverview().then(setOverview).catch(problem=>setError(problem instanceof Error?problem.message:"Unable to load provider training"));},[]);
 async function run(input:Record<string,unknown>,done:string){setBusy(true);setError("");setMessage("");try{await act(input);setMessage(done);refresh();}catch(problem){setError(problem instanceof Error?problem.message:"Provider training action failed");}finally{setBusy(false);}}
 function saveModule(){
  const quiz=[{question,options:options.split("|").map(option=>option.trim()).filter(Boolean),answerIndex:Number(answerIndex)}];
  void run({action:"save_module",title,serviceCode,summary,sections:sections.split("\n").map(section=>section.trim()).filter(Boolean),quiz,passPct:Number(passPct)},"Module saved as draft");
 }
 return <main style={{maxWidth:1400,margin:"0 auto",padding:24,fontFamily:"system-ui",display:"grid",gap:16}}>
  <header><Link href="/team/people">← People home</Link><p>TEAM OS · PEOPLE · PROVIDER TRAINING</p><h1>Provider training & SOP library</h1><p>Versioned SOP modules with a real pass mark. Republishing a module invalidates completions — retraining is the point of a content change.</p></header>
  {overview&&<section style={{display:"grid",gridTemplateColumns:"repeat(3,minmax(140px,1fr))",gap:12}}>
   {[["Published modules",overview.metrics.published],["Drafts",overview.metrics.draft],["Providers not ready",overview.metrics.providersNotReady]].map(([name,value])=><StatCard key={String(name)} label={String(name)} value={value as number}/>)}
  </section>}
  {error&&<p role="alert">{error}</p>}{message&&<p>{message}</p>}
  <section style={{display:"grid",gridTemplateColumns:"minmax(360px,.9fr) minmax(480px,1.1fr)",gap:16,alignItems:"start"}}>
   <article style={{border:"1px solid #dcece5",borderRadius:14,padding:16}}>
    <h2>Author a module</h2>
    <input placeholder="Title" value={title} onChange={event=>setTitle(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <select value={serviceCode} onChange={event=>setServiceCode(event.target.value)} style={{width:"100%",marginBottom:6}}>{["all","grooming","dog_training","boarding","pet_sitting","pet_taxi","dog_walking","pet_food","pet_relocation"].map(code=><option key={code} value={code}>{label(code)}</option>)}</select>
    <input placeholder="Summary" value={summary} onChange={event=>setSummary(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <textarea placeholder="Content sections (one per line)" value={sections} onChange={event=>setSections(event.target.value)} style={{width:"100%",minHeight:80,marginBottom:6}}/>
    <input placeholder="Quiz question" value={question} onChange={event=>setQuestion(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <input placeholder="Options separated by | (first is index 0)" value={options} onChange={event=>setOptions(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <div style={{display:"flex",gap:8,marginBottom:6}}>
     <label>Correct index <input value={answerIndex} onChange={event=>setAnswerIndex(event.target.value)} style={{width:60}}/></label>
     <label>Pass % <input value={passPct} onChange={event=>setPassPct(event.target.value)} style={{width:60}}/></label>
    </div>
    <button disabled={busy} onClick={saveModule}>Save draft</button>
   </article>
   <section style={{display:"grid",gap:12}}>
    <article style={{border:"1px solid #dcece5",borderRadius:14,padding:16}}>
     <h2>Modules</h2>
     {(overview?.modules??[]).map(module=><div key={module.id} style={{borderBottom:"1px solid #e9f1ee",padding:"8px 0"}}>
      <b>{module.title}</b> · {label(module.service_code)} · v{module.version} · {label(module.status)} · pass ≥{module.pass_pct}% · {module.quizQuestions} question(s)
      <br/><small>{module.providersPassedCurrentVersion} provider(s) passed the current version · {module.totalAttempts} attempt(s) · <code>{module.id}</code></small>
      <div style={{display:"flex",gap:8,marginTop:4}}>
       {String(module.status)==="draft"&&<button disabled={busy} onClick={()=>void run({action:"publish_module",moduleId:module.id},"Module published")}>Publish</button>}
       {String(module.status)!=="archived"&&<button disabled={busy} onClick={()=>void run({action:"archive_module",moduleId:module.id},"Module archived")}>Archive</button>}
      </div>
     </div>)}
    </article>
    <article style={{border:"1px solid #dcece5",borderRadius:14,padding:16}}>
     <h2>Provider compliance</h2>
     {(overview?.providers??[]).map(provider=><p key={provider.providerId}>{provider.trainingReady?"✅":"❌"} <b>{provider.name}</b> · {provider.requiredComplete}/{provider.requiredTotal} required modules · <code>{provider.providerId}</code></p>)}
    </article>
   </section>
  </section>
  <footer><small>Completion rule: pass the current version&#39;s quiz at or above the module pass mark. Providers complete modules from their own workspace via /api/provider-lms (ownership enforced).</small></footer>
 </main>;
}
