export type StaffInboxView = {
  channel: "all" | "whatsapp" | "chat";
  ownership: "all" | "me" | "unassigned" | "human";
  priority: "all" | "unread" | "favourite";
  status: "all" | "open" | "pending_customer" | "resolved" | "closed";
  query: string;
};
export const defaultStaffInboxView: StaffInboxView = { channel: "all", ownership: "all", priority: "all", status: "open", query: "" };
export function normalizeStaffInboxView(value: unknown): StaffInboxView {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Response("Inbox filter configuration is required", { status: 400 });
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !["channel", "ownership", "priority", "status", "query"].includes(key))) throw new Response("Unsupported inbox filter field", { status: 400 });
  const result = { ...defaultStaffInboxView, ...row };
  for (const [key, allowed] of Object.entries({ channel: ["all", "whatsapp", "chat"], ownership: ["all", "me", "unassigned", "human"], priority: ["all", "unread", "favourite"], status: ["all", "open", "pending_customer", "resolved", "closed"] })) {
    if (!allowed.includes(String(result[key as keyof StaffInboxView]))) throw new Response("Unsupported inbox filter", { status: 400 });
  }
  if (typeof result.query !== "string" || result.query.length > 200) throw new Response("Inbox search must contain at most 200 characters", { status: 400 });
  return { ...result, query: result.query.trim() } as StaffInboxView;
}
