import type {ReactNode} from "react";
import "./control-route-fix.css";
import convergence from "../components/ui/workspace-convergence.module.css";

export default function ControlLayout({children}:{children:ReactNode}){
  return <div className={`control-route-shell ${convergence.workspace} ${convergence.control}`}>{children}</div>;
}
