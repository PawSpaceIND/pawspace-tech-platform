// A high-volume fast operation must never mask a slow booking or assignment.
export const REQUIRED_OPERATIONS = ['assignment', 'booking', 'duplicate-payment-booking-replay', 'webhook-first-delivery', 'webhook-replay', 'ledger-query'];
export function operationThresholds(metrics, budgetMs = 750) {
  return Object.fromEntries(REQUIRED_OPERATIONS.map(name => {
    const value = metrics[name];
    return [name, Boolean(value && value.count > 0 && Number.isFinite(value.p95Ms) && value.p95Ms < budgetMs)];
  }));
}
