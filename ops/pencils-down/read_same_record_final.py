#!/usr/bin/env python3
import json, os, sys
from urllib.request import Request, urlopen
from urllib.error import HTTPError
WORKER='pawspace-beta-golden-wallet-43ba4002'; DB_NAME=WORKER
BOOKING='PS-UAT-MTV9TAXL-D586'; PROVIDER='groom_arun'; ORDER='order_TaGn7hheH3NbJT'
OUT='golden-service-evidence/final-readback.json'

def api(path,method='GET',body=None):
 account=os.environ['CLOUDFLARE_ACCOUNT_ID'];token=os.environ['CLOUDFLARE_API_TOKEN']
 req=Request('https://api.cloudflare.com/client/v4/accounts/'+account+path,data=None if body is None else json.dumps(body).encode(),method=method,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
 try:
  with urlopen(req,timeout=45) as r:p=json.load(r)
 except HTTPError as e:raise RuntimeError(f'Cloudflare {method} HTTP {e.code}')
 if p.get('success') is not True:raise RuntimeError('Cloudflare request failed')
 return p.get('result')

def db_id():
 rows=api('/d1/database?per_page=100');hits=[r for r in rows if r.get('name')==DB_NAME]
 if len(hits)!=1:raise RuntimeError('isolated D1 not unique')
 return hits[0].get('uuid') or hits[0].get('id')

def query(db,sql):
 result=api('/d1/database/'+db+'/query','POST',{'sql':sql});rows=[]
 for part in result or []:rows.extend(part.get('results') or [])
 return rows

def one(rows):return rows[0] if rows else None
def main():
 db=db_id()
 booking=one(query(db,f"SELECT id,customer_id,provider_id,status,service_code,total_amount,currency FROM canonical_bookings WHERE id='{BOOKING}'"))
 work=one(query(db,f"SELECT id,provider_id,status,service_code FROM provider_work_orders WHERE booking_id='{BOOKING}'"))
 payment=one(query(db,f"SELECT id,status,amount,amount_due_now,currency,gateway FROM booking_payments WHERE booking_id='{BOOKING}'"))
 gateway=one(query(db,f"SELECT gateway_order_id,environment,status FROM payment_gateway_links WHERE booking_id='{BOOKING}'"))
 recon=one(query(db,f"SELECT expected_amount,captured_amount,refunded_amount,reconciliation_status,variance_amount,gateway_status FROM payment_reconciliation_records WHERE booking_id='{BOOKING}'"))
 wallet=query(db,f"SELECT entry_type,amount,bonus_amount,applied_value,source_type,source_id FROM pawspace_wallet_ledger WHERE source_type='booking' AND source_id='{BOOKING}'")
 collection=query(db,f"SELECT event,amount,verification_status,payment_id FROM collection_ledger_postings WHERE payment_id=(SELECT id FROM booking_payments WHERE booking_id='{BOOKING}')")
 invoice=one(query(db,f"SELECT invoice_number,status,gross_amount,tax_amount,net_amount FROM booking_invoices WHERE booking_id='{BOOKING}'"))
 tax=one(query(db,f"SELECT gross_amount,tax_amount,tax_rule_status,reason FROM booking_tax_readiness WHERE booking_id='{BOOKING}'"))
 payout=one(query(db,f"SELECT provider_id,order_value,provider_net_payout,platform_fee,platform_gst,provider_gst_deducted,pawspace_gst_on_order,term_id FROM provider_payout_computations WHERE booking_id='{BOOKING}'"))
 settlement=one(query(db,f"SELECT provider_id,payout_amount,status,rule_version,reason FROM provider_settlement_readiness WHERE booking_id='{BOOKING}'"))
 parity=one(query(db,f"SELECT customer_gross_collection,pawspace_entitlement,statutory_liabilities,provider_settlement,variance,status FROM booking_settlement_reconciliations WHERE booking_id='{BOOKING}'"))
 journal=query(db,f"SELECT account_code,debit,credit,period_code,posted FROM finance_journal_entries WHERE source_type='service_completion' AND source_id='{BOOKING}' ORDER BY account_code")
 attribution=one(query(db,f"SELECT attribution_type,lead_id,source,detail_json FROM booking_attribution WHERE booking_id='{BOOKING}'"))
 leads=query(db,f"SELECT id,service,status,lifecycle_state,initiated_booking_id,converted_booking_id FROM lead_work_items WHERE customer_id=(SELECT customer_id FROM canonical_bookings WHERE id='{BOOKING}') ORDER BY updated_at DESC LIMIT 20")
 expected=[booking,work,payment,gateway,recon,invoice,tax,payout,settlement,parity,attribution]
 if any(x is None for x in expected):raise RuntimeError('one or more required same-record finance rows are missing')
 if booking['status']!='completed' or booking['provider_id']!=PROVIDER or work['status']!='completed':raise RuntimeError('booking/work-order completion mismatch')
 if payment['status']!='captured' or gateway['gateway_order_id']!=ORDER or gateway['environment']!='sandbox':raise RuntimeError('payment/order identity mismatch')
 if round(float(recon['expected_amount']),2)!=849 or round(float(recon['captured_amount']),2)!=849 or round(float(recon['variance_amount']),2)!=0 or recon['reconciliation_status']!='matched':raise RuntimeError('Razorpay reconciliation is not exact')
 applied=round(sum(float(r.get('applied_value') or 0) for r in wallet),2)
 if applied!=500:raise RuntimeError(f'Wallet applied value is {applied}, expected 500')
 if not any(r['event']=='online_payment_captured' and round(float(r['amount']),2)==849 and r['verification_status']=='posted' for r in collection):raise RuntimeError('posted ₹849 collection missing')
 if invoice['status']!='issued' or round(float(invoice['gross_amount']),2)!=1349 or tax['tax_rule_status']!='resolved':raise RuntimeError('invoice/GST readiness mismatch')
 if round(float(payout['order_value']),2)!=1349 or float(payout['provider_net_payout'])<=0 or settlement['status']!='accrued':raise RuntimeError('provider payout accrual mismatch')
 if parity['status']!='reconciled' or round(float(parity['variance']),2)!=0:raise RuntimeError('settlement parity is not reconciled')
 debit=round(sum(float(r.get('debit') or 0) for r in journal),2);credit=round(sum(float(r.get('credit') or 0) for r in journal),2)
 if not journal or debit!=credit or debit!=1349 or not all(int(r['posted'])==1 for r in journal):raise RuntimeError(f'completion journal mismatch {debit}/{credit}')
 atype=attribution['attribution_type']; lead_id=attribution.get('lead_id')
 linked=[r for r in leads if r.get('initiated_booking_id')==BOOKING or r.get('converted_booking_id')==BOOKING]
 if atype=='lead':
  if not lead_id or not any(r['id']==lead_id and r.get('converted_booking_id')==BOOKING and r.get('status')=='converted' for r in leads):raise RuntimeError('linked CRM lead did not convert')
  crm='linked_lead_converted'
 elif atype=='direct_booking':
  if linked:raise RuntimeError('direct booking unexpectedly mutated a lead')
  crm='direct_booking_correctly_left_unrelated_leads_untouched'
 else:raise RuntimeError('unknown booking attribution type')
 result={'testOnly':True,'productionChanged':False,'bookingId':BOOKING,'providerId':PROVIDER,'gatewayOrderId':ORDER,'walletApplied':applied,'cashCaptured':849,'serviceValue':1349,'booking':booking,'workOrder':work,'payment':payment,'reconciliation':recon,'collectionLedger':collection,'invoice':invoice,'taxReadiness':tax,'providerPayout':payout,'settlementReadiness':settlement,'settlementParity':parity,'completionJournal':journal,'completionJournalDebit':debit,'completionJournalCredit':credit,'bookingAttribution':attribution,'crmResult':crm,'leads':leads,'outcome':'SAME_RECORD_DOWNSTREAM_PASS'}
 os.makedirs(os.path.dirname(OUT),exist_ok=True);open(OUT,'w').write(json.dumps(result,indent=2)+'\n')
 print(json.dumps({'outcome':result['outcome'],'booking':BOOKING,'walletApplied':applied,'cashCaptured':849,'journal':f'{debit}/{credit}','crmResult':crm,'invoice':invoice['invoice_number'],'taxStatus':tax['tax_rule_status'],'payoutStatus':settlement['status']}))

if __name__=='__main__':
 try:main()
 except Exception as e:print('STOP:',str(e),file=sys.stderr);sys.exit(1)
