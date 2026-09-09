import type { ReactNode } from "react";

export default function CustomerExperienceLiveTemplate({children}:{children:ReactNode}){
 // Data refresh belongs to the inbox page; remounting discards drafts and selection.
 return <>{children}</>;
}
