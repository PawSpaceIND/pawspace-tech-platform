import convergence from "../components/ui/workspace-convergence.module.css";

export default function PartnerMobileLayout({children}:{children:React.ReactNode}){
  return <div className={`${convergence.workspace} ${convergence.partner}`}>
    <div role="status" style={{padding:"8px 14px",borderBottom:"1px solid #d8e6e0",background:"#fff8eb",color:"#61491b",fontFamily:"system-ui",fontSize:11,lineHeight:1.4,textAlign:"center"}}>
      <strong>PARTNER MOBILE UAT</strong> · Verified provider identity and canonical work orders only. Live payouts, background GPS and production activation remain disabled.
    </div>
    {children}
  </div>;
}
