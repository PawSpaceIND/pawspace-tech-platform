export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*fraction)-1)];
}

export function summarizePerformance(timings, failures) {
  const values = [...timings.values()].flat();
  const p95 = percentile(values, 0.95);
  const byOperation = Object.fromEntries([...timings].map(([name, samples]) => [name, {
    count: samples.length, p95Ms: percentile(samples, 0.95), maxMs: samples.length ? Math.max(...samples) : null,
  }]));
  const errorRate = values.length ? failures.length / values.length : 1;
  return {
    metrics: {totalRequests:values.length,p95Ms:p95,errorRate,byOperation},
    thresholds: {
      p95Under750: p95 !== null && p95 < 750,
      // Apply the existing latency budget to each measured operation, preventing read-heavy masking.
      everyOperationP95Under750: Object.keys(byOperation).length > 0 && Object.values(byOperation).every(metric => metric.p95Ms !== null && metric.p95Ms < 750),
      errorRateUnder1Percent: errorRate < 0.01,
    },
  };
}

// Let every launched request settle before recording a failed run's evidence.
export async function settlePerformanceBatch(promises) {
  const results = await Promise.allSettled(promises);
  const rejected = results.filter(result=>result.status === 'rejected');
  if (rejected.length) throw new AggregateError(rejected.map(result=>result.reason), `${rejected.length} performance requests failed`);
  return results.map(result=>result.value);
}

export function requirePerformanceSandbox(env) {
  for (const [name,value] of Object.entries({APP_ENV:'staging',PAWSPACE_PAYMENT_ENV:'sandbox',PAWSPACE_PAYMENT_LIVE_APPROVED:'false',FORBID_PRODUCTION:'true'})) {
    if (env[name] !== value) throw new Error(`Performance workload requires ${name}=${value}`);
  }
}
