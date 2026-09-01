
test("contract: GET /api/uat-scheduling is staff-gated to scheduling.manage in the gateway", () => {
  assert.match(gatewaySource, /if\(url\.pathname==="\/api\/uat-scheduling"\)\{if\(method==="GET"\)return "scheduling\.manage";/);
});

test("contract: the staff scheduling board is standalone and uses only the governed endpoints", () => {
  assert.match(pageSource, /^"use client";/m);
  assert.match(pageSource, /\/api\/uat-scheduling\?date=/);
  assert.match(pageSource, /action:"reassign"/);
  assert.doesNotMatch(pageSource, /globalThis/);
  assert.doesNotMatch(pageSource, /from\s*["'][^"']*(grooming-flow|stay-flow|training-flow|walking-flow|food-flow)/);
});

test("contract: the double-booking guard and restore-on-failure are present in source", () => {
  assert.match(routeSource, /class SlotConflictError extends Error/);
  assert.match(routeSource, /WHERE NOT EXISTS \(SELECT 1 FROM scheduling_reservations WHERE provider_id=\? AND status!='cancelled' AND scheduled_start<\? AND scheduled_end>\?\)/);
  assert.match(routeSource, /COALESCE\(SUM\(capacity_units\),0\)/, "overnight services guard on capacity, not blanket overlap");
  assert.match(routeSource, /restore=async\(\)=>/);
  assert.match(routeSource, /securityAudit\(db,actor,`scheduling\.\$\{input\.action\}`/);
});