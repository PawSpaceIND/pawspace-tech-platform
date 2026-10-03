import { pathToFileURL } from 'node:url';
export async function inspect({ token, account, request = fetch, now = new Date() }) {
  const summary = { readOnly: true, includedHeadroom: null, zeroIncrementalHostingProven: false, results: [] };
  if (!token || !/^[a-f0-9]{32}$/i.test(account ?? '')) return { ...summary, blocker: 'existing_credentials_unavailable' };
  const to = now.toISOString().slice(0, 10);
  const from = `${to.slice(0, 7)}-01`;
  const endpoints = [['subscriptions', 'subscriptions'], ['entitlements', 'entitlements'], ['billable_usage', `billable/usage?from=${from}&to=${to}`]];
  for (const [name, path] of endpoints) {
    let response;
    try {
      response = await request(`https://api.cloudflare.com/client/v4/accounts/${account}/${path}`, { method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) return { ...summary, blocker: response.status === 401 || response.status === 403 ? 'existing_token_read_access_denied_no_retry' : 'read_endpoint_unavailable', failedEndpoint: name, status: response.status };
      let bytes = 0; const chunks = [];
      for await (const chunk of response.body) { bytes += chunk.byteLength; if (bytes > 1048576) throw new Error('bounded'); chunks.push(chunk); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (data.success !== true || !Array.isArray(data.result) || data.result.length > 10000) throw new Error('invalid');
      if (data.result_info?.total_count > data.result.length) return { ...summary, blocker: 'partial_response_no_pagination_retry', failedEndpoint: name };
      const item = { endpoint: name, records: data.result.length };
      if (name === 'subscriptions') item.plans = data.result.slice(0, 30).map(x => ({ state: ['Trial','Provisioned','Paid','AwaitingPayment','Cancelled','Failed','Expired'].includes(x.state) ? x.state : 'unknown', plan: ['free','lite','pro','pro_plus','business','enterprise','partners_free','partners_pro','partners_business','partners_enterprise'].includes(x.rate_plan?.id) ? x.rate_plan.id : 'unknown' }));
      if (name === 'entitlements') item.numericAllocations = data.result.filter(x => x.allocation?.type === 'max_count' && Number.isFinite(x.allocation.value)).length;
      if (name === 'billable_usage') {
        item.window = { from, to }; item.metrics = [];
        const totals = new Map();
        for (const x of data.result) {
          const id = x.x_BillableMetricId;
          if (typeof id !== 'string' || !/^(workers|d1|r2)[a-z0-9_]{0,100}$/.test(id)) continue;
          if (!Number.isFinite(x.ConsumedQuantity) || x.ConsumedQuantity < 0) throw new Error('invalid');
          const unit=x.ConsumedUnit;if(typeof unit!=='string'||!/^[A-Za-z0-9 _-]{1,40}$/.test(unit))throw new Error('invalid');
          const key=JSON.stringify([id,unit]);totals.set(key,(totals.get(key)??0)+x.ConsumedQuantity);
        }
        item.metrics = [...totals].slice(0, 50).map(([key,consumed])=>{const [metric,unit]=JSON.parse(key);return{metric,unit,consumed}});
      }
      summary.results.push(item);
    } catch { return { ...summary, blocker: 'read_response_invalid_timeout_or_oversize', failedEndpoint: name }; }
  }
  return { ...summary, blocker: 'billing_usage_alpha_no_authoritative_included_allowance_mapping_or_live_freshness' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const summary = await inspect({ token: process.env.CLOUDFLARE_API_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID });
  console.log(JSON.stringify(summary));
  process.exitCode = summary.zeroIncrementalHostingProven ? 0 : 2;
}
