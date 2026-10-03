"use client";

import {useEffect,useRef,type ReactNode} from "react";
import {usePathname} from "next/navigation";
import styles from "./proof-appearance.module.css";

const proofWorkspaces=new Set(["/v2/partner/trainer","/v2/partner/host/proof","/v2/partner/sitter/proof"]);
/** Give existing appearance controls a content-safe home; no service state lives here. */
export default function PartnerLayout({children}:{children:ReactNode}) {
 const scoped=proofWorkspaces.has(usePathname());
 const utility=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  const slot=utility.current;if(!slot)return;
  slot.dataset.pawAppearanceReady="true";
  return ()=>{delete slot.dataset.pawAppearanceReady;};
 },[scoped]);
 if(!scoped)return children;
 return <div className={styles.scope}><div ref={utility} className={styles.utility} data-paw-appearance-slot="partner-proof" aria-label="Workspace appearance"/>{children}</div>;
}
