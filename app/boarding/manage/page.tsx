import Link from "next/link";
import BoardingCustomerStayPanel from "../../mobile-app/boarding-customer-stay-panel";
export default async function BoardingManagePage({searchParams}:{searchParams:Promise<{bookingId?:string}>}){
 const params=await searchParams,bookingId=String(params.bookingId||"").trim();
 return <main style={{maxWidth:980,margin:"0 auto",padding:24,fontFamily:"system-ui"}}><Link href="/mobile-app">My PawSpace</Link><h1 style={{fontSize:28,margin:"16px 0"}}>Your Boarding booking</h1>{bookingId?<BoardingCustomerStayPanel key={bookingId} bookingId={bookingId} caregiverName="Host name unavailable"/>:<p>Open a Boarding booking from your Activity to view its care plan and requests.</p>}</main>;
}
