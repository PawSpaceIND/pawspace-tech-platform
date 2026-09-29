import {resolveUiAuditServer} from './ui-audit-server.mjs';
/** Resolve the fresh chat test origin without requiring an elevated server process.
 * @param {{PW_PORT?: string, PW_BASE_URL?: string}} environment
 * @returns {{port: string, baseURL: string}}
 */
export function resolveUiChatServer({PW_PORT, PW_BASE_URL}={}) {
  const server=resolveUiAuditServer({PW_PORT:PW_PORT??(PW_BASE_URL?undefined:'4209'),PW_BASE_URL});
  if(Number(server.port)<1024) throw new Error('Chat audit requires an explicit unprivileged port from 1024 to 65535; use http://localhost:4209 rather than a portless origin.');
  return server;
}
