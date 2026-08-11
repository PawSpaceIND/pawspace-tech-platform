export default function PartnerMobileLayout({children}:{children:React.ReactNode}){
  return <>
    <div role="status" style={{padding:"8px 14px",borderBottom:"1px solid #eadff3",background:"#fffaf0",color:"#62451a",fontFamily:"system-ui",fontSize:11,lineHeight:1.4,textAlign:"center"}}>
      <strong>PARTNER MOBILE UAT</strong> · Verified provider identity and canonical work orders only. Live payouts, background GPS and production activation remain disabled.
    </div>
    {children}
  </>;
}
