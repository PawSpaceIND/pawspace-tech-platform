/** Public provider boundary; Interakt is the production WhatsApp outbox adapter. */
export { recordCommunicationProviderCallback, signCommunicationProviderCallback } from "./communication-provider-boundary-core";
import { dispatchExternalCommunication as dispatchCore } from "./communication-provider-boundary-core";
import { dispatchInteraktOutboxMessage } from "./interakt-whatsapp";

type Db = D1Database;
type Env = Record<string, unknown>;

export async function dispatchExternalCommunication(db: Db, env: Env, input: { messageId: string; adapterName: string; recipient: string; timeoutMs?: number }) {
  if (String(input.adapterName || "").trim().toLowerCase() === "interakt") {
    return dispatchInteraktOutboxMessage(db, env, { messageId: input.messageId, recipient: input.recipient });
  }
  return dispatchCore(db, env, input);
}
