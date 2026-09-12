import { buildHeadOfMarketingContext } from "./head-of-marketing-prompt";
import { buildHeadOfSalesContext } from "./sales-head";

export type ManagedAgentCode = "sales" | "marketing";

export async function buildManagedAgentContext(db: D1Database, input: { agentCode: ManagedAgentCode; goalId: string; asOf?: number }) {
  if (input.agentCode === "sales") return buildHeadOfSalesContext(db, { goalId: input.goalId, asOf: input.asOf });
  return buildHeadOfMarketingContext(db, { goalId: input.goalId, asOf: input.asOf });
}
