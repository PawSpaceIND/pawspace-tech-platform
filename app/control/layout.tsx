import type {ReactNode} from "react";
import "./control-route-fix.css";

export default function ControlLayout({children}:{children:ReactNode}){
  return <div className="control-route-shell">{children}</div>;
}
