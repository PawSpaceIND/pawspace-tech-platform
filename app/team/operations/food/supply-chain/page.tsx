"use client";
import Link from"next/link";
import{useEffect,useState}from"react";
import{StatCard}from"../../../../components/ui";

type Row=Record<string,unknown>;
type Snapshot={asOfDate:string;suppliers:Row[];kitchens:Row[];purchaseOrders:Row[];batches:Row[];wastage:Row[];reorderPolicies:Row[];reorderSuggestions:Array<{sku:string;zoneId:string;available:number;minAvailableUnits:number;suggestedQuantity:number}>;expiry:{expiringWithin48h:Array<{batchId:string;sku:string;zoneId:string;expiryDate:string;remaining:number}>;pastExpiryAwaitingSweep:number};metrics:{openPurchaseOrders:number;availableBatchUnits:number;wastedUnits:number;skusBelowReorderLevel:number}};

const label=(value:unknown)=>String(value||"—").replaceAll("_"," ").replace(/\b\w/g,letter=>letter.toUpperCase());

async function loadSnapshot():Promise<Snapshot>{const response=await fetch("/api/food-supply-chain",{cache:"no-store"});const body=await response.json();if(!response.ok)throw new Error(body.error||"Unable to load the supply chain");return body.data as Snapshot;}
async function act(input:Record<string,unknown>){const response=await fetch("/api/food-supply-chain",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});const body=await response.json();if(!response.ok)throw new Error(body.error||"Supply-chain action failed");return body.data as Row;}

export default function FoodSupplyChainPage(){
 const[snapshot,setSnapshot]=useState<Snapshot|null>(null),[error,setError]=useState(""),[message,setMessage]=useState(""),[busy,setBusy]=useState(false);
 const[supplierName,setSupplierName]=useState(""),[supplierPhone,setSupplierPhone]=useState("");
 const[poSupplier,setPoSupplier]=useState(""),[poSku,setPoSku]=useState(""),[poZone,setPoZone]=useState("blr-east"),[poQty,setPoQty]=useState("10"),[poCost,setPoCost]=useState("100");
 const[receiveId,setReceiveId]=useState(""),[prepDate,setPrepDate]=useState(""),[expiryDate,setExpiryDate]=useState("");
 const[wasteBatch,setWasteBatch]=useState(""),[wasteQty,setWasteQty]=useState("1"),[wasteReason,setWasteReason]=useState("");
 const[kitchenName,setKitchenName]=useState(""),[kitchenZone,setKitchenZone]=useState("blr-east"),[poKitchen,setPoKitchen]=useState("");
 const[policySku,setPolicySku]=useState(""),[policyZone,setPolicyZone]=useState("blr-east"),[policyMin,setPolicyMin]=useState("10"),[policyQty,setPolicyQty]=useState("25");
 function refresh(){loadSnapshot().then(data=>{setSnapshot(data);setError("");}).catch(problem=>setError(problem instanceof Error?problem.message:"Unable to load the supply chain"));}
 useEffect(()=>{loadSnapshot().then(setSnapshot).catch(problem=>setError(problem instanceof Error?problem.message:"Unable to load the supply chain"));},[]);
 async function run(input:Record<string,unknown>,done:string){setBusy(true);setError("");setMessage("");try{await act(input);setMessage(done);refresh();}catch(problem){setError(problem instanceof Error?problem.message:"Supply-chain action failed");}finally{setBusy(false);}}
 return <main style={{maxWidth:1400,margin:"0 auto",padding:24,fontFamily:"system-ui",display:"grid",gap:16}}>
  <header><Link href="/team/operations/food">← Food operations</Link><p>TEAM OS · FOOD · SUPPLY CHAIN</p><h1>Fresh Food supply chain</h1><p>Supplier → purchase order → dated batch → sellable stock, with expiry, wastage and reorder governance. Receiving raises the same inventory the customer quote reads.</p></header>
  {snapshot&&<section style={{display:"grid",gridTemplateColumns:"repeat(4,minmax(140px,1fr))",gap:12}}>
   {[["Open POs",snapshot.metrics.openPurchaseOrders],["Available batch units",snapshot.metrics.availableBatchUnits],["Wasted units",snapshot.metrics.wastedUnits],["SKUs below reorder",snapshot.metrics.skusBelowReorderLevel]].map(([name,value])=><StatCard key={String(name)} label={String(name)} value={value as number}/>)}
  </section>}
  {error&&<p role="alert">{error}</p>}{message&&<p>{message}</p>}
  {snapshot&&snapshot.reorderSuggestions.length>0&&<section style={{border:"1px solid #e0a800",borderRadius:14,padding:16}}>
   <h2>Reorder suggested</h2>
   {snapshot.reorderSuggestions.map(item=><p key={`${item.sku}:${item.zoneId}`}><b>{item.sku}</b> in {item.zoneId}: {item.available} available &lt; minimum {item.minAvailableUnits} → order {item.suggestedQuantity} units (governed manual PO, never auto-purchased)</p>)}
  </section>}
  {snapshot&&snapshot.expiry.expiringWithin48h.length>0&&<section style={{border:"1px solid #cc4400",borderRadius:14,padding:16}}>
   <h2>Expiring within 48h</h2>
   {snapshot.expiry.expiringWithin48h.map(item=><p key={item.batchId}>{item.batchId} · {item.sku} · {item.remaining} units · expires {item.expiryDate}</p>)}
  </section>}
  <section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(320px,1fr))",gap:16}}>
   <article style={{border:"1px solid #ddd",borderRadius:14,padding:16}}>
    <h2>Supplier</h2>
    <input placeholder="Supplier name" value={supplierName} onChange={event=>setSupplierName(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <input placeholder="Contact phone" value={supplierPhone} onChange={event=>setSupplierPhone(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <button disabled={busy} onClick={()=>void run({action:"save_supplier",name:supplierName,contactPhone:supplierPhone},"Supplier saved")}>Save supplier</button>
    <ul>{(snapshot?.suppliers??[]).map(supplier=><li key={String(supplier.id)}>{String(supplier.name)} · {label(supplier.status)} · <code>{String(supplier.id)}</code></li>)}</ul>
   </article>
   <article style={{border:"1px solid #ddd",borderRadius:14,padding:16}}>
    <h2>Purchase order</h2>
    <input placeholder="Supplier ID" value={poSupplier} onChange={event=>setPoSupplier(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <input placeholder="SKU" value={poSku} onChange={event=>setPoSku(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <input placeholder="Zone" value={poZone} onChange={event=>setPoZone(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <input placeholder="Quantity" value={poQty} onChange={event=>setPoQty(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <input placeholder="Unit cost" value={poCost} onChange={event=>setPoCost(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <label style={{display:"block",marginBottom:6}}>Kitchen <select value={poKitchen} onChange={event=>setPoKitchen(event.target.value)}><option value="">No kitchen</option>{(snapshot?.kitchens??[]).map(kitchen=><option key={String(kitchen.id)} value={String(kitchen.id)}>{String(kitchen.name)} · {String(kitchen.zone_id)}</option>)}</select></label>
    <button disabled={busy} onClick={()=>void run({action:"create_po",supplierId:poSupplier,sku:poSku,zoneId:poZone,quantity:Number(poQty),unitCost:Number(poCost),...(poKitchen?{kitchenId:poKitchen}:{}),idempotencyKey:`po:${crypto.randomUUID()}`},"Purchase order created")}>Create PO</button>
   </article>
   <article style={{border:"1px solid #ddd",borderRadius:14,padding:16}}>
    <h2>Receive → batch</h2>
    <input placeholder="Purchase order ID" value={receiveId} onChange={event=>setReceiveId(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <label>Preparation <input type="date" value={prepDate} onChange={event=>setPrepDate(event.target.value)}/></label>
    <label style={{marginLeft:8}}>Expiry <input type="date" value={expiryDate} onChange={event=>setExpiryDate(event.target.value)}/></label>
    <div style={{marginTop:6}}><button disabled={busy} onClick={()=>void run({action:"receive_po",purchaseOrderId:receiveId,preparationDate:prepDate,expiryDate},"Stock received into a dated batch")}>Receive</button></div>
   </article>
   {/* The API has always implemented save_kitchen, and nothing in the app posted it. Without a
       kitchen no purchase order can name one, so food_kitchens stayed empty, createFoodPurchaseOrder's
       active-kitchen check was unreachable, and the Kitchen column in the batch table below read "—"
       on every row the platform could ever produce. */}
   <article style={{border:"1px solid #ddd",borderRadius:14,padding:16}}>
    <h2>Kitchen</h2>
    <input placeholder="Kitchen name" value={kitchenName} onChange={event=>setKitchenName(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <input placeholder="Delivery zone" value={kitchenZone} onChange={event=>setKitchenZone(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <button disabled={busy} onClick={()=>void run({action:"save_kitchen",name:kitchenName,zoneId:kitchenZone},"Kitchen saved")}>Save kitchen</button>
    <ul>{(snapshot?.kitchens??[]).map(kitchen=><li key={String(kitchen.id)}>{String(kitchen.name)} · {String(kitchen.zone_id)} · {label(kitchen.status)} · <code>{String(kitchen.id)}</code></li>)}</ul>
   </article>
   {/* "SKUs below reorder" and the whole "Reorder suggested" section are computed from
       food_reorder_policies, which is written ONLY by set_reorder_policy - an action the API
       implements and no control posted. With no policy row there is no threshold, so the metric was
       pinned at 0 and the section could never render, whatever the stock did. This is the input the
       screen was already reporting on. */}
   <article style={{border:"1px solid #ddd",borderRadius:14,padding:16}}>
    <h2>Reorder policy</h2>
    <input placeholder="SKU" value={policySku} onChange={event=>setPolicySku(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <input placeholder="Zone" value={policyZone} onChange={event=>setPolicyZone(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <input placeholder="Minimum available units" value={policyMin} onChange={event=>setPolicyMin(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <input placeholder="Reorder quantity" value={policyQty} onChange={event=>setPolicyQty(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <button disabled={busy} onClick={()=>void run({action:"set_reorder_policy",sku:policySku,zoneId:policyZone,minAvailableUnits:Number(policyMin),reorderQuantity:Number(policyQty)},"Reorder policy saved")}>Save reorder policy</button>
    <ul>{(snapshot?.reorderPolicies??[]).map(policy=><li key={`${String(policy.sku)}:${String(policy.zone_id)}`}>{String(policy.sku)} in {String(policy.zone_id)}: reorder {Number(policy.reorder_quantity)} when available &lt; {Number(policy.min_available_units)}</li>)}</ul>
    {snapshot&&snapshot.reorderPolicies.length===0&&<p><small>No reorder thresholds are set, so “SKUs below reorder” counts nothing and no reorder can be suggested. It is a policy that has not been written, not a stock level that is healthy.</small></p>}
   </article>
   <article style={{border:"1px solid #ddd",borderRadius:14,padding:16}}>
    <h2>Wastage</h2>
    <input placeholder="Batch ID" value={wasteBatch} onChange={event=>setWasteBatch(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <input placeholder="Quantity" value={wasteQty} onChange={event=>setWasteQty(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <input placeholder="Reason" value={wasteReason} onChange={event=>setWasteReason(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <button disabled={busy} onClick={()=>void run({action:"record_wastage",batchId:wasteBatch,quantity:Number(wasteQty),reason:wasteReason,idempotencyKey:`waste:${crypto.randomUUID()}`},"Wastage recorded")}>Record wastage</button>
    <div style={{marginTop:6}}><button disabled={busy} onClick={()=>void run({action:"expiry_sweep"},"Expiry sweep completed")}>Run expiry sweep</button></div>
   </article>
  </section>
  {snapshot&&<section style={{overflowX:"auto"}}>
   <h2>Batches</h2>
   <table style={{borderCollapse:"collapse",width:"100%"}}>
    <thead><tr>{["Batch","SKU","Zone","Kitchen","Received","Remaining","Prepared","Expiry","Status"].map(header=><th key={header} style={{textAlign:"left",borderBottom:"2px solid #ddd",padding:"6px 10px"}}>{header}</th>)}</tr></thead>
    <tbody>{snapshot.batches.map(batch=><tr key={String(batch.id)}>
     <td style={{padding:"6px 10px",borderBottom:"1px solid #eee"}}><code>{String(batch.id)}</code></td>
     <td style={{padding:"6px 10px",borderBottom:"1px solid #eee"}}>{String(batch.sku)}</td>
     <td style={{padding:"6px 10px",borderBottom:"1px solid #eee"}}>{String(batch.zone_id)}</td>
     <td style={{padding:"6px 10px",borderBottom:"1px solid #eee"}}>{String(batch.kitchen_id||"—")}</td>
     <td style={{padding:"6px 10px",borderBottom:"1px solid #eee"}}>{Number(batch.quantity_received)}</td>
     <td style={{padding:"6px 10px",borderBottom:"1px solid #eee"}}>{Number(batch.quantity_remaining)}</td>
     <td style={{padding:"6px 10px",borderBottom:"1px solid #eee"}}>{String(batch.preparation_date)}</td>
     <td style={{padding:"6px 10px",borderBottom:"1px solid #eee"}}>{String(batch.expiry_date)}</td>
     <td style={{padding:"6px 10px",borderBottom:"1px solid #eee"}}>{label(batch.status)}</td>
    </tr>)}</tbody>
   </table>
  </section>}
  <footer><small>Sandbox supply chain: no auto-purchasing, no live money. Receiving is the only path from procurement to sellable stock; wastage and expiry are guarded so stock never goes negative.</small></footer>
 </main>;
}
