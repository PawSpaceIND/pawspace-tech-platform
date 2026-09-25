import V2ServiceBridgeShell from "../../service-bridge-shell";
/** Presentation and existing V2 navigation only; no identity or booking logic. */
export default function Layout({children}:{children:React.ReactNode}){return <V2ServiceBridgeShell>{children}</V2ServiceBridgeShell>;}
