/** Resolve one loopback origin for both the browser and fresh server.
 * @param {{PW_PORT?: string, PW_BASE_URL?: string}} environment
 * @returns {{port: string, baseURL: string}}
 */
export function resolveUiAuditServer({PW_PORT, PW_BASE_URL} = {}) {
  const checkedPort = value => {
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('UI audit port must be an integer from 1 to 65535.');
    return String(Number(value));
  };
  const explicit = PW_PORT === undefined ? undefined : checkedPort(PW_PORT);
  const url = new URL(PW_BASE_URL || `http://127.0.0.1:${explicit || '4197'}`);
  if (url.protocol !== 'http:' || !['localhost','127.0.0.1'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('UI repair fixtures require a loopback HTTP origin without credentials, paths, queries or fragments.');
  }
  const port = checkedPort(url.port || '80');
  if (explicit && explicit !== port) throw new Error('PW_PORT must match the port in PW_BASE_URL.');
  return {port, baseURL:url.origin};
}
