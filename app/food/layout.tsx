import type { ReactNode } from "react";

export default function FoodLayout({ children }: { children: ReactNode }) {
  return <div className="ps-unified-service ps-food">{children}</div>;
}
