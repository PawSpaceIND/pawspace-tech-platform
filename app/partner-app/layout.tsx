import WorkspaceOrderInbox from "../components/workspace-order-inbox";
import convergence from "../components/ui/workspace-convergence.module.css";

export default function PartnerMobileLayout({children}:{children:React.ReactNode}){
  return <div className={`${convergence.workspace} ${convergence.partner}`}>
    <div role="status" style={{padding:"8px 14px",borderBottom:"1px solid var(--paw-line)",background:"var(--paw-bg)",color:"var(--paw-text)",fontFamily:"var(--paw-font, system-ui)",fontSize:11,lineHeight:1.4,textAlign:"center"}}>
      <strong>PARTNER MOBILE UAT</strong> · Verified provider identity and canonical work orders only. Live payouts and production activation remain disabled. Background location requires the native partner app and device permission.
    </div>
    <WorkspaceOrderInbox/>
    {children}
  </div>;
}
