import Link from "next/link";
import styles from "./service-bridge-shell.module.css";
export default function V2ServiceBridgeShell({children}:{children:React.ReactNode}){return <><header className={styles.bar}><Link href="/v2" className={styles.brand}><img src="/assets/pawspace-icon.jpeg" alt=""/><span>PawSpace V2</span></Link><nav className={styles.nav}><Link href="/v2">Home</Link><Link href="/v2/activity">Activity</Link><Link href="/v2/chat">PawSpace AI</Link><Link href="/v2/account">Account</Link></nav></header>{children}</>;}
