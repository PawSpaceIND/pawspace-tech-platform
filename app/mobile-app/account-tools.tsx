'use client';
import{useState}from'react';
import{openMobileRazorpayCheckout}from'../../lib/mobile/razorpay';
import type{CustomerBilling}from'../../lib/customer-billing';
import styles from'./account-tools.module.css';

type Notification={id:string;title:string;body:string;status:string;created_at:number};
type Points={balance:number;history:Array<{entryType:string;points:number;reason:string|null;createdAt:number}>};
type Wallet={balance:number;bonusRate:number;history:Array<{entryType:string;amount:number;bonus:number;appliedValue:number;createdAt:number}>};
type Offers={coupons:Array<{code:string;name:string;description:string}>};
type Panel='notifications'|'billing'|'rewards'|'privacy';
type State={loading?:boolean;error?:string;notifications?:Notification[];billing?:CustomerBilling;points?:Points;wallet?:Wallet;offers?:Offers};

async function read<T>(url:string):Promise<T>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);try{const response=await fetch(url,{cache:'no-store',signal:controller.signal}),body=await response.json() as{data?:T;error?:string};if(!response.ok||body.data===undefined)throw new Error(body.error||'Unable to load this information. Please try again.');return body.data}finally{clearTimeout(timer)}}
const money=(value:unknown,currency:unknown='INR')=>new Intl.NumberFormat('en-IN',{style:'currency',currency:String(currency||'INR')}).format(Number(value||0));

export default function AccountTools({customerId,onSupport}:{customerId:string;onSupport:()=>void}){
 const[state,setState]=useState<Partial<Record<Panel,State>>>({});
 const[busy,setBusy]=useState('');
 const[paymentNotice,setPaymentNotice]=useState('');

 async function load(panel:Panel){
  if(panel==='privacy')return;
  setState(current=>({...current,[panel]:{loading:true}}));
  try{
   let data:State={};
   if(panel==='notifications')data={notifications:(await read<{items:Notification[]}>(`/api/order-notifications?customerId=${encodeURIComponent(customerId)}&limit=50`)).items};
   if(panel==='billing')data={billing:await read<CustomerBilling>('/api/customer-billing')};
   if(panel==='rewards'){
    const[points,wallet,offers]=await Promise.all([read<Points>('/api/paw-points'),read<Wallet>('/api/pawspace-wallet'),read<Offers>('/api/customer-offers')]);
    data={points,wallet,offers};
   }
   setState(current=>({...current,[panel]:data}));
  }catch(error){setState(current=>({...current,[panel]:{error:error instanceof Error?error.message:'Unable to load this information.'}}));}
 }

 async function refreshBillingAndRewards(){
  const[billing,wallet,points,offers]=await Promise.all([read<CustomerBilling>('/api/customer-billing'),read<Wallet>('/api/pawspace-wallet'),read<Points>('/api/paw-points'),read<Offers>('/api/customer-offers')]);
  setState(current=>({...current,billing:{billing},rewards:{wallet,points,offers}}));
 }

 async function markRead(item:Notification){
  setBusy(item.id);
  try{const response=await fetch('/api/order-notifications',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({customerId,notificationId:item.id,action:'mark_read'})});if(!response.ok)throw new Error('Unable to mark this update as read.');setState(current=>({...current,notifications:{...current.notifications,notifications:current.notifications?.notifications?.map(value=>value.id===item.id?{...value,status:'read'}:value)}}));}
  catch(error){setState(current=>({...current,notifications:{...current.notifications,error:error instanceof Error?error.message:'Unable to update notification.'}}));}
  finally{setBusy('');}
 }

 async function applyWallet(item:Record<string,unknown>){
  const bookingId=String(item.booking_id||'');if(!bookingId)return;
  setBusy('wallet:'+bookingId);setPaymentNotice('');
  try{
   const wallet=await read<Wallet>('/api/pawspace-wallet');
   if(!(wallet.balance>0))throw new Error('No PawSpace Wallet balance is available to apply.');
   const response=await fetch('/api/pawspace-wallet',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bookingId,walletAmount:wallet.balance})});
   const body=await response.json() as{data?:{walletUsed?:number;bonus?:number;appliedValue?:number};error?:string};
   if(!response.ok||!body.data)throw new Error(body.error||'Unable to apply PawSpace Wallet.');
   await refreshBillingAndRewards();
   setPaymentNotice(`Wallet applied to booking ${bookingId}: ${money(body.data.appliedValue)} total value (${money(body.data.walletUsed)} Wallet + ${money(body.data.bonus)} bonus).`);
  }catch(error){setPaymentNotice(error instanceof Error?error.message:'Unable to apply PawSpace Wallet.');}
  finally{setBusy('');}
 }

 async function payBooking(item:Record<string,unknown>){
  const bookingId=String(item.booking_id||'');if(!bookingId)return;
  setBusy('pay:'+bookingId);setPaymentNotice('');
  try{
   const response=await fetch('/api/payment-order',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bookingId})}),body=await response.json() as{data?:{connected?:boolean;environment?:string;reason?:string;keyId?:string;orderId?:string;amountPaise?:number;currency?:string;bookingId?:string};error?:string};
   if(!response.ok)throw new Error(body.error||'Unable to start payment.');
   const order=body.data;
   if(!order?.connected||order.environment!=='sandbox'||!order.keyId||!order.orderId||!order.amountPaise)throw new Error(order?.reason||'Razorpay Test checkout is not available for this booking.');
   const result=await openMobileRazorpayCheckout({keyId:order.keyId,orderId:order.orderId,amountPaise:order.amountPaise,currency:order.currency||'INR',name:'PawSpace Test Checkout',description:`Booking ${bookingId}`,notes:{booking_id:bookingId}},{PAWSPACE_PAYMENT_ENV:'sandbox',FORBID_PRODUCTION:'true',PAWSPACE_PAYMENT_LIVE_APPROVED:'false'});
   if(!result.success)throw new Error(result.description);
   setPaymentNotice(`Payment submitted in Razorpay Test Mode for booking ${bookingId}. PawSpace will show it as paid only after the verified webhook is received.`);
   for(let attempt=0;attempt<8;attempt++){
    await new Promise(resolve=>setTimeout(resolve,1000));
    const billing=await read<CustomerBilling>('/api/customer-billing');
    setState(current=>({...current,billing:{billing}}));
    const current=billing.payments.find(value=>String(value.booking_id)===bookingId);
    if(current&&['captured','paid','settled'].includes(String(current.status).toLowerCase())){setPaymentNotice(`Payment verified for booking ${bookingId}.`);break;}
   }
  }catch(error){setPaymentNotice(error instanceof Error?error.message:'Unable to complete test checkout.');}
  finally{setBusy('');}
 }

 const panels:Array<[Panel,string]>=[['notifications','Notifications & reminders'],['billing','Payments & invoice summaries'],['rewards','Offers, Wallet & PawPoints'],['privacy','Privacy & security']];
 return <div className={styles.tools}>{panels.map(([panel,title])=>{const data=state[panel];return <details className={styles.item} key={panel} onToggle={event=>{if(event.currentTarget.open&&!data)void load(panel)}}><summary>{title}</summary><div className={styles.content}>
 {data?.loading&&<p role='status'>Loading…</p>}{data?.error&&<div role='alert' className={styles.error}><p>{data.error}</p><button className={styles.button} onClick={()=>void load(panel)}>Try again</button></div>}
 {panel==='notifications'&&data?.notifications&&<>{!data.notifications.length?<p>No order updates yet. Booking, service and refund updates will appear here.</p>:data.notifications.map(item=><article className={styles.record} key={item.id}><strong>{item.title}</strong><p>{item.body}</p><small>{new Date(item.created_at).toLocaleString('en-IN')} · {item.status==='unread'?'Unread':'Read'}</small>{item.status==='unread'&&<button className={styles.button} disabled={!!busy} onClick={()=>void markRead(item)}>{busy===item.id?'Saving…':'Mark as read'}</button>}</article>)}</>}
 {panel==='rewards'&&data?.points&&data.wallet&&<><p className={styles.balance}>{money(data.wallet.balance)} PawSpace Wallet</p><p className={styles.note}>Wallet redemptions receive the governed {(data.wallet.bonusRate*100).toFixed(0)}% PawSpace bonus, capped by the amount still payable on the booking.</p><p className={styles.balance}>{data.points.balance.toLocaleString('en-IN')} PawPoints</p><h4>Available offers</h4>{data.offers?.coupons.length?data.offers.coupons.map(offer=><article key={offer.code} className={styles.record}><strong>{offer.name}</strong><p>{offer.description}</p><small>Code: {offer.code} · Eligibility is checked at checkout.</small></article>):<p>No offers are available for your account right now.</p>}<h4>Points history</h4>{data.points.history.length?data.points.history.map((item,index)=><article key={`${item.createdAt}-${index}`} className={styles.record}><strong>{item.points} · {item.entryType.replaceAll('_',' ')}</strong><p>{item.reason}</p><small>{new Date(item.createdAt).toLocaleDateString('en-IN')}</small></article>):<p>No points activity yet.</p>}</>}
 {panel==='billing'&&data?.billing&&<><h4>Payments</h4>{paymentNotice&&<p role='status' className={styles.note}>{paymentNotice}</p>}{!data.billing.paymentsAvailable?<p>Payment records are not available yet.</p>:!data.billing.payments.length?<p>No payment records found for your account.</p>:data.billing.payments.map(item=>{const bookingId=String(item.booking_id),status=String(item.status).toLowerCase(),due=Number(item.amount_due_now||0),payable=due>0&&!['captured','paid','settled','refunded'].includes(status);return <article key={String(item.id)} className={styles.record}><strong>{String(item.package_name)} · {money(item.amount,item.currency)}</strong><p>{String(item.status).replaceAll('_',' ')} · {String(item.method)} · Due now {money(due,item.currency)}</p><small>Booking {bookingId} · {String(item.gateway)}</small>{payable&&<><button className={styles.button} disabled={!!busy} onClick={()=>void applyWallet(item)}>{busy===`wallet:${bookingId}`?'Applying Wallet…':'Apply PawSpace Wallet'}</button><button className={styles.button} disabled={!!busy} onClick={()=>void payBooking(item)}>{busy===`pay:${bookingId}`?'Opening Razorpay Test…':'Pay securely (Test)'}</button></>}</article>})}<h4>Invoice summaries</h4>{!data.billing.invoicesAvailable?<p>Invoice records are not available yet.</p>:!data.billing.invoices.length?<p>No invoices have been recorded for your account.</p>:data.billing.invoices.map(item=><article key={String(item.id)} className={styles.record}><strong>{String(item.invoice_number)}</strong><p>{String(item.package_name)} · {String(item.status)}</p><p>Total: {money(item.gross_amount,item.currency)} · Tax: {money(item.tax_amount,item.currency)}</p><small>Booking {String(item.booking_id)}</small></article>)}<p className={styles.note}>These are recorded payment states and invoice summaries. Contact support for a full invoice document or help with a payment.</p><button className={styles.button} onClick={onSupport}>Billing support</button></>}
 {panel==='privacy'&&<><p>You are signed in to your customer account. Update your profile and saved addresses above.</p><p>Contact support for a copy of your information, corrections or an account-deletion request. Some transaction records may need to be retained.</p><button className={styles.button} onClick={onSupport}>Contact support about privacy</button></>}
 </div></details>})}</div>;
}