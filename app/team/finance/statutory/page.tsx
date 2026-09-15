"use client";
/*
 * GST, accounting and statutory control desk. [FIN-W2-G]
 *
 * This screen used to render registers and post NOTHING. /api/gst-accounting implements sixteen
 * actions and no .tsx in the repository posted a single one of them, so no GST return - GSTR-1,
 * GSTR-3B, GSTR-9C, the GSTR-9 annual return or the monthly statutory package - could be generated
 * or approved from the product, an invoice serial could not be voided, a credit note could not be
 * issued and input-tax credit could not be reviewed. None of it is machine driven: neither
 * lib/background-scheduler.ts nor worker/index.ts runs any of these, so every one of them is an
 * operator's work that had no operator surface. The controls below are ordered by statutory
 * consequence: the monthly returns with a filing due date first, the registers last.
 *
 * Maker/checker is enforced by the ROUTE, not by this screen. The screen simply refuses to offer an
 * approve control on a draft the signed-in operator prepared, and says why, so the two-person rule is
 * visible instead of being discovered as a refusal. Bypassing the screen still fails at the route.
 */
import Link from"next/link";
import{useEffect,useState}from"react";
import{StatCard}from"../../../components/ui";

type Row=Record<string,unknown>;
type Snapshot={entities:Row[];registrations:Row[];policies:Row[];invoices:Row[];adjustments:Row[];vendorReviews:Row[];packages:Row[];mappings:Row[];exports:Row[];closeEvidence:Row[];annualReturns?:Row[];productionReady:false;liveFilingEnabled:false;liveAccountingPostEnabled:false};
type ReturnsSnapshot={documents:Row[]};
type Actor={email:string;roleCode:string};
type Payload={data?:Snapshot;returns?:ReturnsSnapshot;actor?:Actor;canManage?:boolean;error?:string};

const label=(v:unknown)=>String(v??"—").replaceAll("_"," ");
const money=(v:unknown)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:2}).format(Number(v||0));
const LOAD_FAILED="Unable to load statutory finance";
const ACTION_FAILED="GST/accounting action failed";

/** Module scope on purpose: the load effect must not close over a component-scoped function. */
async function requestSnapshot():Promise<Payload>{
 const response=await fetch("/api/gst-accounting",{cache:"no-store"});
 const payload=await response.json() as Payload;
 if(!response.ok)throw new Error(payload.error||LOAD_FAILED);
 return payload;
}

const panel={background:"white",border:"1px solid #e5dcef",borderRadius:14,padding:18,marginTop:16} as const;
const fieldBox={padding:"8px 10px",borderRadius:8,border:"1px solid #d9cde8",fontSize:13,minWidth:150} as const;
const primary={padding:"9px 14px",borderRadius:9,border:"none",background:"#4b168c",color:"white",fontWeight:700,fontSize:13} as const;
const secondary={padding:"9px 14px",borderRadius:9,border:"1px solid #d9cde8",background:"white",fontWeight:700,fontSize:13} as const;
const rowBox={display:"flex",flexWrap:"wrap" as const,gap:8,alignItems:"center",marginTop:10};
const cell={padding:10,borderTop:"1px solid #f1edf5",fontSize:13} as const;
const head=(columns:string[])=><thead><tr>{columns.map(column=><th key={column} style={{textAlign:"left",padding:11,background:"#faf8fc"}}>{column}</th>)}</tr></thead>;

export default function GstAccountingUat(){
 const[data,setData]=useState<Snapshot|null>(null);
 const[returns,setReturns]=useState<ReturnsSnapshot|null>(null);
 const[actor,setActor]=useState<Actor|null>(null);
 const[canManage,setCanManage]=useState(false);
 const[error,setError]=useState("");
 const[notice,setNotice]=useState("");
 const[busy,setBusy]=useState(false);
 const[loading,setLoading]=useState(true);
 const[form,setForm]=useState<Record<string,string>>({});

 useEffect(()=>{
  let active=true;
  void(async()=>{
   try{
    const payload=await requestSnapshot();
    if(!active)return;
    setData(payload.data||null);setReturns(payload.returns||null);setActor(payload.actor||null);setCanManage(Boolean(payload.canManage));
   }catch(problem){if(active)setError(problem instanceof Error?problem.message:LOAD_FAILED);}
   finally{if(active)setLoading(false);}
  })();
  return()=>{active=false;};
 },[]);

 const apply=(payload:Payload)=>{setData(payload.data||null);setReturns(payload.returns||null);setActor(payload.actor||null);setCanManage(Boolean(payload.canManage));};
 const load=async()=>{setBusy(true);setError("");try{apply(await requestSnapshot());}catch(problem){setError(problem instanceof Error?problem.message:LOAD_FAILED);}finally{setBusy(false);setLoading(false);}};

 /** Every write goes through here, so a governed refusal always lands in the same alert panel. */
 async function act(body:Record<string,unknown>,success:string){
  setBusy(true);setError("");setNotice("");
  try{
   const response=await fetch("/api/gst-accounting",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
   const payload=await response.json() as Payload;
   if(!response.ok)throw new Error(payload.error||ACTION_FAILED);
   setNotice(success);
   apply(await requestSnapshot());
  }catch(problem){setError(problem instanceof Error?problem.message:ACTION_FAILED);}
  finally{setBusy(false);}
 }

 const set=(key:string,next:string)=>setForm(current=>({...current,[key]:next}));
 const value=(key:string,fallback="")=>form[key]??fallback;
 const field=(key:string,aria:string,placeholder:string,fallback="",type="text")=>
  <input aria-label={aria} type={type} placeholder={placeholder} value={value(key,fallback)} onChange={event=>set(key,event.target.value)} style={fieldBox} />;
 const picker=(key:string,aria:string,rows:Row[],idKey:string,textKey:string,fallback="")=>
  <select aria-label={aria} value={value(key,fallback)} onChange={event=>set(key,event.target.value)} style={fieldBox}>
   <option value="">—</option>
   {rows.map(row=><option key={String(row[idKey])} value={String(row[idKey])}>{String(row[textKey]??row[idKey])}</option>)}
  </select>;
 const button=(text:string,onClick:()=>void,style:Record<string,unknown>=primary)=>
  <button onClick={onClick} disabled={busy} style={style}>{text}</button>;

 const entities=data?.entities??[],registrations=data?.registrations??[];
 const entityId=value("entityId",String(entities[0]?.id??""));
 const registrationId=value("registrationId",String(registrations[0]?.id??""));
 const gstin=value("gstin",String(registrations[0]?.registration_reference??""));
 const period=value("periodCode",new Date().toISOString().slice(0,7));
 const financialYear=value("financialYear",String(new Date().getUTCFullYear()));
 const documents=returns?.documents??[];
 const annualReturns=data?.annualReturns??[];
 const card=(name:string,figure:unknown,sub:string)=><StatCard label={name} value={String(figure)} meta={sub} />;

 /** The screen never offers an approve control to the operator who prepared the draft. */
 const mine=(row:Row)=>Boolean(actor?.email)&&String(row.prepared_by??"")===String(actor?.email);
 function approvalCell(row:Row,action:string,buttonText:string,what:string){
  const id=String(row.id);
  if(String(row.status)!=="draft")return <small style={{color:"#746b7d"}}>signed off by {label(row.reviewed_by)} · {label(row.approval_reference)}</small>;
  if(!canManage)return <small style={{color:"#746b7d"}}>finance.manage is required to sign off a {what}</small>;
  if(mine(row))return <small data-testid="maker-checker-hold" style={{color:"#8a5a00"}}>Two-person rule: you prepared this draft, so you cannot approve it. A different Finance/CA approver must sign it off.</small>;
  return <span style={{display:"flex",gap:6,flexWrap:"wrap"}}>
   {field(`approval:${id}`,`Approval reference for ${id}`,"CA sign-off reference")}
   {button(buttonText,()=>void act({action,id,approvalReference:value(`approval:${id}`),reason:`Approve ${what} ${id}`},`${what} signed off — draft only, nothing was filed.`))}
  </span>;
 }

 return <main style={{minHeight:"100vh",background:"#f7f4fb",padding:32,fontFamily:"Arial, sans-serif",color:"#24133f"}}><div style={{maxWidth:1420,margin:"0 auto"}}>
 <header style={{display:"flex",justifyContent:"space-between",gap:20,alignItems:"center",marginBottom:20}}><div><small style={{fontWeight:800,letterSpacing:1.4,color:"#6c39a8"}}>PAWSPACE FINANCE · UAT</small><h1 style={{fontSize:34,margin:"8px 0"}}>GST, Accounting & Statutory Control</h1><p style={{margin:0,color:"#6d6379"}}>Effective-dated policy, immutable documents, tax review, accounting exports and FIN-01 evidence. No live filing or production accounting post.</p></div><div style={{display:"flex",gap:10}}>{button("Refresh",()=>void load(),secondary)}<Link href="/team/finance" style={{padding:"11px 16px",borderRadius:10,background:"#4b168c",color:"white",textDecoration:"none",fontWeight:700}}>Finance home</Link></div></header>
 <section style={{padding:16,borderRadius:12,background:"#fff7e8",border:"1px solid #efd4a5",marginBottom:18}}><b>PRODUCTION READY = FALSE</b><div style={{fontSize:13,marginTop:5}}>Tax rates, registrations, SAC/HSN classification, place-of-supply, numbering, ITC, TDS, chart of accounts and mappings are Finance/CA-approved configuration. Missing policy must fail as <code>configuration_required</code>.</div></section>
 {error&&<section role="alert" style={{padding:16,borderRadius:12,background:"#fff1f1",border:"1px solid #efc2c2",marginBottom:18}}>{error}</section>}
 {notice&&!error&&<section role="status" style={{padding:16,borderRadius:12,background:"#eefaf1",border:"1px solid #bfe3ca",marginBottom:18}}>{notice}</section>}
 {loading&&<section style={{background:"white",padding:24,borderRadius:14}}>Loading statutory finance controls…</section>}
 {data&&!loading&&<><section style={{display:"grid",gridTemplateColumns:"repeat(4,minmax(0,1fr))",gap:12,marginBottom:18}}>{card("Entities",data.entities.length,"Legal entity master")}{card("Issued invoices",data.invoices.length,"Immutable canonical invoices")}{card("Adjustments",data.adjustments.length,"Credit/debit notes")}{card("Close evidence",data.closeEvidence.length,"FIN-01 reconciliation inputs")}</section>

 <section data-testid="filing-scope" style={panel}>
  <h2 style={{marginTop:0}}>Filing scope</h2>
  <p style={{margin:0,color:"#6d6379",fontSize:13}}>Every return, package and export below is generated for this legal entity, GST registration and period. Signed in as <b>{actor?.email??"—"}</b>{canManage?"":" — read only, finance.manage is required to prepare or sign off a return."}</p>
  <div style={rowBox}>
   {picker("entityId","Filing entity",entities,"id","legal_name",entityId)}
   {picker("registrationId","GST registration",registrations,"id","registration_reference",registrationId)}
   {field("periodCode","Return period","YYYY-MM",period,"month")}
   {field("financialYear","Financial year","2026-27",financialYear)}
  </div>
 </section>

 <section data-testid="gst-returns" style={panel}>
  <h2 style={{marginTop:0}}>GST returns — GSTR-1, GSTR-3B, GSTR-9C</h2>
  <p style={{margin:0,color:"#6d6379",fontSize:13}}>GSTR-1 is due the 11th and GSTR-3B the 20th of the following month; GSTR-9C is the annual reconciliation statement. Generating prepares a versioned draft with a payload checksum; a second Finance/CA approver signs it off. Nothing here files to the GST portal.</p>
  {canManage&&<div style={rowBox}>
   {button("Generate GSTR-1",()=>void act({action:"generate_gstr1",entityId,registrationId,periodCode:period,reason:`Generate GSTR-1 for ${period}`},`GSTR-1 draft prepared for ${period}.`))}
   {button("Generate GSTR-3B",()=>void act({action:"generate_gstr3b",entityId,registrationId,periodCode:period,reason:`Generate GSTR-3B for ${period}`},`GSTR-3B draft prepared for ${period}.`))}
   {button("Generate GSTR-9C",()=>void act({action:"generate_gstr9c",entityId,registrationId,financialYear,reason:`Generate GSTR-9C for ${financialYear}`},`GSTR-9C reconciliation draft prepared for ${financialYear}.`),secondary)}
  </div>}
  <div style={{overflowX:"auto",marginTop:12}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
   {head(["Return","Period","Version","Status","Prepared by","Sign-off"])}
   <tbody>{documents.length===0
    ?<tr><td colSpan={6} style={{padding:24,textAlign:"center",color:"#746b7d"}}>No GST return drafts yet for any period.</td></tr>
    :documents.map(row=><tr key={String(row.id)}>
     <td style={cell}>{label(row.return_type)}</td><td style={cell}>{label(row.period_code)}</td><td style={cell}>v{label(row.version)}</td>
     <td style={cell}>{label(row.status)}</td><td style={cell}>{label(row.prepared_by)}</td>
     <td style={cell}>{approvalCell(row,"approve_gst_return","Approve return","GST return")}</td>
    </tr>)}</tbody>
  </table></div>
 </section>

 <section data-testid="statutory-package" style={panel}>
  <h2 style={{marginTop:0}}>Monthly statutory package</h2>
  <p style={{margin:0,color:"#6d6379",fontSize:13}}>The month&apos;s output tax, eligible input credit and adjustments, versioned. Every month of a financial year needs an approved package before the GSTR-9 annual return can be approved.</p>
  {canManage&&<div style={rowBox}>{button("Generate statutory package",()=>void act({action:"generate_statutory_package",entityId,registrationId,periodCode:period,reason:`Generate statutory package for ${period}`},`Statutory package prepared for ${period}.`))}</div>}
  <div style={{overflowX:"auto",marginTop:12}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
   {head(["Period","Version","Status","Prepared by","Sign-off"])}
   <tbody>{data.packages.length===0
    ?<tr><td colSpan={5} style={{padding:24,textAlign:"center",color:"#746b7d"}}>No statutory packages prepared yet.</td></tr>
    :data.packages.map(row=><tr key={String(row.id)}>
     <td style={cell}>{label(row.period_code)}</td><td style={cell}>v{label(row.version)}</td><td style={cell}>{label(row.status)}</td><td style={cell}>{label(row.prepared_by)}</td>
     <td style={cell}>{approvalCell(row,"approve_statutory_package","Approve statutory package","statutory package")}</td>
    </tr>)}</tbody>
  </table></div>
 </section>

 <section data-testid="annual-return" style={panel}>
  <h2 style={{marginTop:0}}>GSTR-9 annual return</h2>
  <p style={{margin:0,color:"#6d6379",fontSize:13}}>Due 31 December following the financial year. Approval fails closed until all twelve monthly packages are approved.</p>
  {canManage&&<div style={rowBox}>{button("Generate annual return",()=>void act({action:"generate_annual_return",entityId,registrationId,financialYear,reason:`Generate GSTR-9 for ${financialYear}`},`GSTR-9 annual return draft prepared for ${financialYear}.`))}</div>}
  <div style={{overflowX:"auto",marginTop:12}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
   {head(["Financial year","Version","Status","Prepared by","Sign-off"])}
   <tbody>{annualReturns.length===0
    ?<tr><td colSpan={5} style={{padding:24,textAlign:"center",color:"#746b7d"}}>No annual returns prepared yet.</td></tr>
    :annualReturns.map(row=><tr key={String(row.id)}>
     <td style={cell}>{label(row.financial_year)}</td><td style={cell}>v{label(row.version)}</td><td style={cell}>{label(row.status)}</td><td style={cell}>{label(row.prepared_by)}</td>
     <td style={cell}>{approvalCell(row,"approve_annual_return","Approve annual return","annual return")}</td>
    </tr>)}</tbody>
  </table></div>
 </section>

 {canManage&&<section data-testid="invoice-documents" style={panel}>
  <h2 style={{marginTop:0}}>Invoice series, serials and adjustment notes</h2>
  <p style={{margin:0,color:"#6d6379",fontSize:13}}>Rule 46(b) numbering is per GSTIN, document type and financial year. A serial that was allocated but never issued must be recorded as void, not silently skipped; a correction to an issued invoice is a credit or debit note, never an edit.</p>
  <div style={rowBox}>
   {field("gstin","Series GSTIN","29AABCP1234A1Z5",gstin)}
   {field("documentType","Document type","invoice",value("documentType","invoice"))}
   {field("seriesFy","Series financial year","2026-27",value("seriesFy","2026-27"))}
   {field("prefix","Series prefix","PS/26-27/")}
   {field("padding","Series padding","6",value("padding","6"))}
   {picker("policyId","Series tax policy",data.policies,"id","id")}
   {button("Save invoice series",()=>void act({action:"save_statutory_series",entityId,gstin,documentType:value("documentType","invoice"),financialYear:value("seriesFy","2026-27"),prefix:value("prefix"),padding:Number(value("padding","6")),policyId:value("policyId"),nextNumber:Number(value("nextNumber","1"))},`Invoice series active for ${value("seriesFy","2026-27")}.`))}
  </div>
  <div style={rowBox}>
   {field("voidNumber","Invoice number to void","PS/26-27/000007")}
   {field("voidSerial","Serial number to void","7","","number")}
   {field("voidReason","Void reason","Why this serial was never issued")}
   {button("Void invoice serial",()=>void act({action:"void_invoice_serial",entityId,gstin,documentType:value("documentType","invoice"),financialYear:value("seriesFy","2026-27"),invoiceNumber:value("voidNumber"),serialNumber:Number(value("voidSerial","0")),reason:value("voidReason"),sourceReference:value("voidReference")},`Serial ${value("voidNumber")} recorded as void.`),secondary)}
  </div>
  <div style={rowBox}>
   {picker("adjustInvoiceId","Invoice to adjust",data.invoices,"id","invoice_number")}
   <select aria-label="Adjustment kind" value={value("adjustKind","credit_note")} onChange={event=>set("adjustKind",event.target.value)} style={fieldBox}><option value="credit_note">credit note</option><option value="debit_note">debit note</option></select>
   {field("adjustAmount","Adjustment taxable amount","0","","number")}
   {field("adjustTax","Adjustment tax amount","0","","number")}
   {field("adjustReason","Adjustment reason","Why this note is being issued")}
   {button("Issue adjustment note",()=>void act({action:"issue_adjustment",invoiceId:value("adjustInvoiceId"),kind:value("adjustKind","credit_note"),amount:Number(value("adjustAmount","0")),taxAmount:Number(value("adjustTax","0")),reason:value("adjustReason"),sourceEventKey:`adjustment:${value("adjustInvoiceId")}:${value("adjustReason")}`},"Adjustment note issued against the invoice."),secondary)}
  </div>
 </section>}

 {canManage&&<section data-testid="vendor-tax" style={panel}>
  <h2 style={{marginTop:0}}>Input-tax credit review</h2>
  <p style={{margin:0,color:"#6d6379",fontSize:13}}>Only a reviewed, eligible vendor bill contributes input credit to GSTR-3B, the monthly package and GSTR-9/9C. Unreviewed credit is never claimed.</p>
  <div style={rowBox}>
   {field("billId","Vendor bill id","bill id")}
   {field("supplierInvoiceNumber","Supplier invoice number","supplier invoice no.")}
   {field("supplierRegistration","Supplier GSTIN","29AAAAA0000A1Z5")}
   <select aria-label="Review status" value={value("reviewStatus","eligible")} onChange={event=>set("reviewStatus",event.target.value)} style={fieldBox}>{["eligible","ineligible","held","review_required"].map(status=><option key={status} value={status}>{status.replaceAll("_"," ")}</option>)}</select>
   {field("eligibleTax","Eligible tax amount","0","","number")}
   {field("reviewReason","Review reason","Why this credit is eligible or held")}
   {button("Record vendor tax review",()=>void act({action:"review_vendor_tax",billId:value("billId"),supplierInvoiceNumber:value("supplierInvoiceNumber"),supplierRegistrationReference:value("supplierRegistration"),reviewStatus:value("reviewStatus","eligible"),eligibleTaxAmount:Number(value("eligibleTax","0")),reason:value("reviewReason")},"Vendor tax review recorded."))}
  </div>
  <div style={{marginTop:10,fontSize:13,color:"#746b7d"}}>{data.vendorReviews.length} review(s) on record.{data.vendorReviews.slice(0,4).map((row,index)=><small key={index} style={{display:"block",marginTop:4}}>{label(row.supplier_invoice_number)} · {label(row.review_status)} · {money(row.eligible_tax_amount)}</small>)}</div>
 </section>}

 {canManage&&<section data-testid="accounting-exports" style={panel}>
  <h2 style={{marginTop:0}}>Accounting export & FIN-01 close evidence</h2>
  <p style={{margin:0,color:"#6d6379",fontSize:13}}>Exports carry a reproducible checksum of the posted journals only. An acknowledgement is evidence that a human received the file; it is never canonical accounting truth.</p>
  <div style={rowBox}>
   {field("exportTarget","Export target","tally",value("exportTarget","tally"))}
   {button("Generate accounting export",()=>void act({action:"generate_accounting_export",entityId,periodCode:period,target:value("exportTarget","tally"),reason:`Export ${period} journals`},`Accounting export generated for ${period}.`))}
  </div>
  <div style={{overflowX:"auto",marginTop:12}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
   {head(["Period","Target","Status","Acknowledgement"])}
   <tbody>{data.exports.length===0
    ?<tr><td colSpan={4} style={{padding:24,textAlign:"center",color:"#746b7d"}}>No accounting exports generated yet.</td></tr>
    :data.exports.map(row=><tr key={String(row.id)}>
     <td style={cell}>{label(row.period_code)}</td><td style={cell}>{label(row.target)}</td><td style={cell}>{label(row.status)}</td>
     <td style={cell}>{String(row.status)==="acknowledged"?label(row.ack_reference):<span style={{display:"flex",gap:6,flexWrap:"wrap"}}>{field(`ack:${String(row.id)}`,`Acknowledgement reference for ${String(row.id)}`,"received-by reference")}{button("Acknowledge export",()=>void act({action:"acknowledge_accounting_export",id:String(row.id),ackReference:value(`ack:${String(row.id)}`),reason:"Export received"},"Export acknowledgement recorded."),secondary)}</span>}</td>
    </tr>)}</tbody>
  </table></div>
  <div style={rowBox}>
   {field("evidenceType","Close evidence type","bank_reconciliation")}
   {field("evidenceReference","Close evidence reference","statement or ticket reference")}
   {field("evidenceVariance","Close evidence variance","0","","number")}
   {field("evidenceReason","Close evidence reason","What this evidence proves")}
   {button("Record close evidence",()=>void act({action:"record_close_evidence",periodCode:period,evidenceType:value("evidenceType"),sourceReference:value("evidenceReference"),varianceAmount:Number(value("evidenceVariance","0")),reason:value("evidenceReason")},`FIN-01 close evidence recorded for ${period}.`),secondary)}
  </div>
 </section>}

 <section style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginTop:16}}><section style={{background:"white",border:"1px solid #e5dcef",borderRadius:14,padding:18}}><h2 style={{marginTop:0}}>Configuration readiness</h2>{[["Registrations",data.registrations],["Tax policies",data.policies],["Accounting mappings",data.mappings]].map(([name,rows])=><div key={String(name)} style={{borderTop:"1px solid #eee6f5",padding:"12px 0"}}><b>{String(name)}</b><span style={{float:"right"}}>{(rows as Row[]).length}</span>{(rows as Row[]).slice(0,3).map((r,i)=><small key={i} style={{display:"block",marginTop:5,color:"#746b7d"}}>{label(r.id)} · {label(r.status)} · {label(r.approval_reference)}</small>)}</div>)}</section>
 <section style={{background:"white",border:"1px solid #e5dcef",borderRadius:14,padding:18}}><h2 style={{marginTop:0}}>Statutory review & exports</h2><div><b>Review packages</b><span style={{float:"right"}}>{data.packages.length}</span>{data.packages.slice(0,4).map((r,i)=><small key={i} style={{display:"block",marginTop:5,color:"#746b7d"}}>{label(r.period_code)} · v{label(r.version)} · {label(r.status)}</small>)}</div><div style={{borderTop:"1px solid #eee6f5",paddingTop:12,marginTop:12}}><b>Accounting exports</b><span style={{float:"right"}}>{data.exports.length}</span>{data.exports.slice(0,4).map((r,i)=><small key={i} style={{display:"block",marginTop:5,color:"#746b7d"}}>{label(r.period_code)} · {label(r.target)} · {label(r.status)}</small>)}</div></section></section>

 <section data-testid="issued-invoices" style={{background:"white",border:"1px solid #e5dcef",borderRadius:14,overflow:"hidden",marginTop:16}}><div style={{padding:16,borderBottom:"1px solid #eee6f5"}}><b>Issued invoice truth</b></div>
 {canManage&&<div style={{...rowBox,padding:"0 16px 12px"}}>
  {field("invoiceCustomerId","Invoice customer","customer id")}
  {field("invoiceSourceType","Invoice source type","booking",value("invoiceSourceType","booking"))}
  {field("invoiceSourceId","Invoice source id","source id")}
  {field("invoiceDate","Invoice issue date","YYYY-MM-DD",value("invoiceDate",`${period}-01`))}
  {field("invoiceServiceCode","Invoice service code","pet_grooming")}
  {field("invoiceTaxable","Invoice taxable amount","0","","number")}
  {field("invoiceReason","Invoice reason","Why this invoice is being issued")}
  {button("Issue canonical invoice",()=>void act({action:"issue_invoice",entityId,customerId:value("invoiceCustomerId"),sourceType:value("invoiceSourceType","booking"),sourceId:value("invoiceSourceId"),sourceEventKey:`${value("invoiceSourceType","booking")}:${value("invoiceSourceId")}:invoice`,issueDate:value("invoiceDate",`${period}-01`),currency:"INR",reason:value("invoiceReason"),lines:[{lineKey:"1",description:value("invoiceReason")||"Service",serviceCode:value("invoiceServiceCode"),taxableAmount:Number(value("invoiceTaxable","0"))}]},"Canonical invoice issued."))}
 </div>}
 <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}><thead><tr>{["Invoice","Customer","Source","Date","Subtotal","Tax","Total","Status"].map(h=><th key={h} style={{textAlign:"left",padding:11,background:"#faf8fc"}}>{h}</th>)}</tr></thead><tbody>{data.invoices.length===0?<tr><td colSpan={8} style={{padding:24,textAlign:"center",color:"#746b7d"}}>No issued UAT invoices yet. Configure approved entity/registration/policy/classifications/series before issuing.</td></tr>:data.invoices.map(r=><tr key={String(r.id)}>{[r.invoice_number,r.customer_id,`${label(r.source_type)}:${label(r.source_id)}`,r.issue_date,money(r.subtotal),money(r.tax_total),money(r.total),label(r.status)].map((v,i)=><td key={i} style={cell}>{String(v)}</td>)}</tr>)}</tbody></table></div></section>
 <footer style={{fontSize:12,color:"#746b7d",marginTop:16}}>No production GST filing, tax payment, bank instruction or Tally/Zoho production post is enabled by this workspace. Export acknowledgement is evidence only, never canonical accounting truth.</footer></>}
 </div></main>;
}
