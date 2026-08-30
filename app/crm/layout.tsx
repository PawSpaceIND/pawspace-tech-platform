import type { ReactNode } from "react";
import convergence from "../components/ui/workspace-convergence.module.css";

export default function CrmLayout({ children }: { children: ReactNode }) {
  return <div className={`${convergence.workspace} ${convergence.crm}`}>{children}</div>;
}
