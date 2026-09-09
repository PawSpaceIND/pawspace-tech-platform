import type { ReactNode } from "react";

// Data refresh belongs to the inbox page; remounting discards drafts and selection.
// This stays a server component on purpose: marking this template as a client
// component fails to render on this stack, and the page owns the conversation stream.
export default function CustomerExperienceLiveTemplate({children}:{children:ReactNode}){
 return <>{children}</>;
}
