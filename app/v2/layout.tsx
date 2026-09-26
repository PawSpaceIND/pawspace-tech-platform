import type { ReactNode } from "react";
import styles from "./presentation.module.css";
import options from "./style-options.module.css";
import V2NativeShell from "./native-shell";

/** V2-only presentation boundary. No identity, service or payment state lives here. */
export default function V2Layout({ children }: { children: ReactNode }) {
  return <div data-pawspace-v2="true" className={`${styles.canvas} ${options.surface}`}><V2NativeShell />{children}</div>;
}
