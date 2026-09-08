import { pathToFileURL } from "node:url";

export const INTERNAL_BUCKET = "pawspace-internal-uat-media";

export async function provisionInternalMedia({ env = process.env, fetchImpl = fetch } = {}) {
  if (env.APP_ENV !== "staging" || env.FORBID_PRODUCTION !== "true" || env.PAWSPACE_PAYMENT_ENV !== "sandbox" || env.PAWSPACE_PAYMENT_LIVE_APPROVED !== "false") throw new Error("Internal storage requires all staging and sandbox locks.");
  const account = env.CLOUDFLARE_ACCOUNT_ID, token = env.CLOUDFLARE_API_TOKEN;
  if (!account || !/^[a-f0-9]{32}$/i.test(account) || !token) throw new Error("Cloudflare account configuration and an R2 management credential are required.");
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets`;
  async function call(suffix, method = "GET", body, allowMissing = false) {
    let response;
    try {
      response = await fetchImpl(base + suffix, { method, redirect: "error", signal: AbortSignal.timeout(30000), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new Error("Cloudflare storage request could not be completed; no deployment was started."); }
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`Cloudflare storage request refused (${response.status}). Verify R2 is enabled and the stored token has R2 management permission.`);
    const data = await response.json();
    if (data.success !== true || !data.result) throw new Error("Cloudflare did not confirm the storage operation.");
    return data.result;
  }
  const path = `/${INTERNAL_BUCKET}`;
  let bucket = await call(path, "GET", undefined, true);
  const created = !bucket;
  if (!bucket) bucket = await call("", "POST", { name: INTERNAL_BUCKET });
  if (bucket.name !== INTERNAL_BUCKET) throw new Error("Unexpected storage identity; refusing to connect it.");
  const managed = await call(`${path}/domains/managed`);
  const custom = await call(`${path}/domains/custom`);
  if (managed.enabled !== false || !Array.isArray(custom.domains) || custom.domains.length !== 0) throw new Error("Storage is not verifiably private. No staging binding was changed.");
  return { bucketName: INTERNAL_BUCKET, created, private: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await provisionInternalMedia())); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
