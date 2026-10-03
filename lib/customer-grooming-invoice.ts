import{bookingInvoiceDocument}from"./booking-tax-invoice";
type Row=Record<string,unknown>;
export async function readCustomerGroomingInvoice(db:D1Database,input:{bookingId:string;customerId:string;status:string}){
 if(input.status!=="completed")return null;
 const document=await bookingInvoiceDocument(db,input.bookingId);
 if(document){
  if(document.customerId!==input.customerId||document.bookingId!==input.bookingId)throw new Error("Customer invoice ownership is inconsistent");
  return{number:document.invoiceNumber,status:"issued",currency:"INR",total:document.amountReceived,tax:document.totalTax,subtotal:Number((document.amountReceived-document.totalTax).toFixed(2)),issuedAt:Date.parse(document.issueDate),source:"governed" as const,title:document.title,issueDate:document.issueDate,documentAvailable:true};
 }
 const exists=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='booking_invoices'").first<Row>();
 if(!exists)return null;
 const invoice=await db.prepare("SELECT invoice_number,status,currency,gross_amount,tax_amount,net_amount,issued_at FROM booking_invoices WHERE booking_id=? AND customer_id=? AND status IN ('issued','issued_uat')").bind(input.bookingId,input.customerId).first<Row>();
 return invoice?{number:invoice.invoice_number,status:invoice.status,currency:invoice.currency,total:invoice.gross_amount,tax:invoice.tax_amount,subtotal:invoice.net_amount,issuedAt:invoice.issued_at,source:"legacy" as const,title:"Legacy invoice summary",documentAvailable:false}:null;
}
