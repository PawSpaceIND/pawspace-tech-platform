import type { ReactNode } from "react";
import convergence from "../components/ui/workspace-convergence.module.css";

export default function PartnerLayout({ children }: { children: ReactNode }) {
  return <div className={`${convergence.workspace} ${convergence.partner}`}>{children}</div>;
}
