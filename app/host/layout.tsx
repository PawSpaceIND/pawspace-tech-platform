import type { ReactNode } from "react";
import PartnerModule from "../components/partner-presentation/PartnerModule";

/** Layout only; children retain their existing identity and service contracts. */
export default function Layout({ children }: { children: ReactNode }) {
  return <PartnerModule>{children}</PartnerModule>;
}
