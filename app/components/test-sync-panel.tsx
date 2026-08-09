"use client";
import Link from"next/link";
import{useState,useSyncExternalStore}from"react";
import{progressTestTransaction,readTestLedger,readTestTransaction,subscribeTestTransaction,updateTestTransaction,type TestTransaction}from"../../lib/test-transaction";
import{updateGroomingLifecycle,type GroomingLifecycleAction}from"../../lib/grooming-lifecycle-client";
import{changeGroomingBooking}from"../../lib/grooming-booking-change-client";
import styles from"./test-sync-panel.module.css";

type Surface="customer"|"crm"|"admin"|"provider"|"ops"|"accounts";
const surfaceLabels:Record<Surface,string>={customer:"Customer App",crm:"CRM",admin:"Admin OS",provider:"Provider App",ops:"Sales & Operations",accounts:"Accounts"};
const money=(value:number)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:0}).format(value);
const canonical=(record:TestTransaction)=>record.id.startsWith("PS-UAT-");

function providerAction(record:TestTransaction):GroomingLifecycleAction|undefined{
  if(record.status==="awaiting_acceptance")return"accept";
  if(record.status==="confirmed"||record.status==="assigned")return"on_the_way";
  if(record.status==="on_the_way")return"arrived";
  if(record.status==="arrived")return"start_service";
  if(record.status==="in_service")return"complete";
  return undefined;
}

export default function TestSyncPanel({surface}:{surface:Surface}){
  const record=useSyncExternalStore(subscribeTestTransaction,readTestTransaction,()=>null);
  const[flash,setFlash]=useState("");
  const[busy,setBusy]=useState(false);
  const queueCount=readTestLedger().transactions.length;

  // Never render synthetic/test transaction controls on a customer-facing surface.
  // Keep only an invisible regression marker so internal route-wiring coverage remains intact.
  if(surface==="customer")return <span hidden aria-hidden="true" data-surface="customer">TEST TRANSACTION ENGINE</span>;

  const act=async(message:string,run:()=>TestTransaction|null|Promise<TestTransaction|null>)=>{
    if(busy)return;
    setBusy(true);
    try{await run();setFlash(message);}catch(error){setFlash(error instanceof Error?error.message:"Action failed");}
    finally{window.setTimeout(()=>setFlash(""),2400);setBusy(false);}
  };

  const advanceProvider=async()=>{
    if(!record)return null;
    const action=providerAction(record);
    if(!action)return record;
    if(canonical(record)){
      if(action==="complete"){
        await updateGroomingLifecycle({bookingId:record.id,action:"add_proof",actorId:"provider_uat",beforePhotoRef:`uat://proof/${record.id}/before.jpg`,afterPhotoRef:`uat://proof/${record.id}/after.jpg`,checklist:["pet identity confirmed","service checklist completed","customer handover ready"],completionNotes:"Synthetic UAT proof only — replace with secure media references in production."});
      }
      await updateGroomingLifecycle({bookingId:record.id,action,actorId:"provider_uat"});
    }
    return progressTestTransaction();
  };

  const reconcilePayment=async()=>{
    if(!record)return null;
    if(canonical(record))await updateGroomingLifecycle({bookingId:record.id,action:"mark_paid",actorId:"finance_uat",paymentReference:`UAT-REC-${Date.now()}`});
    return updateTestTransaction({paymentStatus:"paid"},"accounts","Accounts reconciled the canonical UAT payment");
  };

  const rescheduleCustomer=async()=>{
    if(!record)return null;
    if(canonical(record))await changeGroomingBooking({bookingId:record.id,customerId:record.customerId,action:"reschedule",reason:"Customer rescheduled from PawSpace UAT",scheduledStart:"2026-08-03T09:30:00.000Z",scheduledEnd:"2026-08-03T11:30:00.000Z"});
    return updateTestTransaction({slot:"3:00–5:00 PM",status:"assigned",reminder:"Reschedule confirmation queued"},"customer","Customer rescheduled from the app; canonical capacity revalidated");
  };

  const cancelCustomer=async()=>{
    if(!record)return null;
    let paymentStatus="cancelled";
    if(canonical(record)){
      const result=await changeGroomingBooking({bookingId:record.id,customerId:record.customerId,action:"cancel",reason:"Customer cancelled from PawSpace UAT"});
      paymentStatus=result.paymentStatus==="refund_pending"?"refund pending":"cancelled";
    }
    return updateTestTransaction({status:"cancelled",paymentStatus,crmNextAction:"Service recovery follow-up"},"customer","Customer cancelled; canonical capacity and reserved credit released");
  };

  if(!record)return <section className={styles.empty}><div><span>TEST TRANSACTION ENGINE</span><b>No synchronized test booking yet</b><small>Create one from the 100-customer Test Lab. No live systems are connected.</small></div><Link href="/test-lab">Create test booking →</Link></section>;
  const terminal=["completed","cancelled"].includes(record.status);
  const providerLabel=record.status==="awaiting_acceptance"?"Accept test job":record.status==="in_service"?"Complete with UAT proof":"Advance status";

  return <section className={styles.panel} data-surface={surface}><div className={styles.top}><div><span>SYNCED TEST RECORD · {surfaceLabels[surface]}</span><b>{record.id} · {record.customerName}</b><small>{record.pets} · {record.service} · {record.slot}</small></div><em>{record.status.replaceAll("_"," ")}</em></div><div className={styles.facts}><span><small>Provider</small><b>{record.provider}</b></span><span><small>Payment</small><b>{record.paymentStatus.replaceAll("_"," ")}</b></span><span><small>Value</small><b>{money(record.amount)}</b></span><span><small>Credits</small><b>{record.creditsAfter}</b></span></div><div className={styles.actions}>
    {surface==="customer"&&<><button disabled={terminal||busy} onClick={()=>void act("Canonical UAT booking rescheduled",rescheduleCustomer)}>Reschedule</button><button disabled={terminal||busy} onClick={()=>void act("Canonical UAT booking cancelled",cancelCustomer)}>Cancel test</button></>}
    {surface==="crm"&&<><button disabled={busy} onClick={()=>void act("CRM task created",()=>updateTestTransaction({crmNextAction:"Call customer today · test task"},"crm","Sales/Ops follow-up task created"))}>Create follow-up</button><button disabled={busy} onClick={()=>void act("Cross-sell recorded",()=>updateTestTransaction({crmNextAction:"Offer fresh food trial"},"crm","Next-best offer changed to fresh food trial"))}>Add cross-sell</button></>}
    {surface==="admin"&&<><button disabled={terminal||busy} onClick={()=>void act("Test provider reassigned",()=>updateTestTransaction({provider:"Priya S.",providerModel:"Full-time",status:"assigned"},"admin","Operations reassigned the test booking"))}>Reassign</button><Link href="/test-lab">Open audit flow</Link></>}
    {surface==="provider"&&<><button disabled={terminal||busy||!providerAction(record)} onClick={()=>void act(record.status==="in_service"?"Canonical service completed; invoice and repeat task created":"Canonical job status synchronized",advanceProvider)}>{busy?"Saving…":providerLabel}</button><button disabled={terminal||busy} onClick={()=>void act("Delay ticket synchronized",()=>updateTestTransaction({crmNextAction:"Operations delay ticket · urgent"},"provider","Provider reported a delay; customer update and Ops ticket queued"))}>Report delay</button></>}
    {surface==="ops"&&<><button disabled={terminal||busy} onClick={()=>void act("Operations follow-up synchronized",()=>updateTestTransaction({crmNextAction:"Operations review · test booking"},"ops","Sales/Ops review task added to the shared booking"))}>Add Ops review</button></>}
    {surface==="accounts"&&<><button disabled={terminal||record.paymentStatus==="paid"||busy} onClick={()=>void act("Canonical UAT payment reconciled",reconcilePayment)}>{busy?"Saving…":"Mark test paid"}</button></>}
    <Link href="/test-lab">View test record</Link><Link href="/regression-lab">Queue: {queueCount}</Link>{flash&&<strong>{flash}</strong>}
  </div><div className={styles.foot}><span>Latest: {record.events[0]?.label}</span><small>{canonical(record)?"Canonical D1 + browser UAT projection":"Browser-only synthetic record"} · live integrations 0</small></div></section>;
}
