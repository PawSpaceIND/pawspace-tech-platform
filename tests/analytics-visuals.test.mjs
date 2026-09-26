import test from 'node:test';
import assert from 'node:assert/strict';
import { previousRange, rangeDays, recentRange, comparisonLabel, dailyBookingSeries, alignDaily } from '../lib/analytics-visuals.ts';
test('inclusive equal periods across leap year and year boundary', () => {
 assert.deepEqual(previousRange({from:'2024-03-01',to:'2024-03-02'}),{from:'2024-02-28',to:'2024-02-29'});
 assert.deepEqual(previousRange({from:'2026-01-01',to:'2026-01-01'}),{from:'2025-12-31',to:'2025-12-31'});
 assert.equal(rangeDays({from:'2024-02-01',to:'2024-02-29'}),29);
});
test('reject invalid or reversed calendar dates', () => {
 for (const range of [{from:'2026-02-30',to:'2026-03-02'},{from:'',to:'2026-03-02'},{from:'2026-03-03',to:'2026-03-02'}]) assert.throws(()=>rangeDays(range));
});
test('complete-day presets respect India midnight', () => {
 assert.deepEqual(recentRange(7,new Date('2026-09-26T20:00:00Z')),{from:'2026-09-20',to:'2026-09-26'});
});
test('zero comparison baseline is disclosed rather than divided by zero', () => {
 assert.match(comparisonLabel(100,0),/No percentage baseline/);
 assert.match(comparisonLabel(0,0),/No change/);
 assert.equal(comparisonLabel(150,100),'+50.0% vs previous period');
});
test('daily revenue excludes cancelled and draft while counting all bookings', () => {
 const rows=[{scheduled_start:'2026-03-01T10:00:00Z',status:'completed',total_amount:500},{scheduled_start:'2026-03-01T12:00:00Z',status:'cancelled',total_amount:900},{scheduled_start:'2026-03-02T12:00:00Z',status:'draft',total_amount:400}];
 assert.deepEqual(dailyBookingSeries(rows,()=>250),[{date:'2026-03-01',gmv:500,collected:250,bookings:2},{date:'2026-03-02',gmv:0,collected:0,bookings:1}]);
});
test('align exact comparison dates and fill genuine missing booking days', () => {
 assert.deepEqual(alignDaily({from:'2026-03-01',to:'2026-03-02'},[{date:'2026-03-02',gmv:500}],[{date:'2026-02-27',gmv:200}]),[{date:'2026-03-01',previousDate:'2026-02-27',current:0,previous:200},{date:'2026-03-02',previousDate:'2026-02-28',current:500,previous:0}]);
 assert.throws(()=>alignDaily({from:'2020-01-01',to:'2026-01-01'},[],[]));
});
