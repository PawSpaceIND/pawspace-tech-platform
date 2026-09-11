import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const query=fs.readFileSync("lib/intelligence/financial-query-agent.ts","utf8");
const data=fs.readFileSync("lib/intelligence/atlas-data.ts","utf8");
const ingest=fs.readFileSync("app/api/admin/tally-ingest/route.ts","utf8");
const chat=fs.readFileSync("app/api/admin/atlas-chat/route.ts","utf8");
const worker=fs.readFileSync("worker/index.ts","utf8");
const vite=fs.readFileSync("vite.config.ts","utf8");

test("Atlas financial memory is isolated from live finance ledgers",()=>{
 assert.match(data,/analytics_historical_financials/);
 assert.doesNotMatch(ingest,/INSERT INTO finance_|UPDATE finance_|DELETE FROM finance_/);
 assert.match(ingest,/liveLedgerMutation:false/);
});

test("Atlas text-to-SQL compiles only whitelisted SELECT analytics queries",()=>{
 assert.match(query,/Allowed table is analytics_historical_financials/);
 assert.match(query,/Never output SQL/);
 assert.match(query,/^export function compileFinancialQuery/m);
 assert.match(query,/INSERT\|UPDATE\|DELETE\|DROP\|ALTER\|CREATE\|ATTACH\|PRAGMA\|REPLACE\|VACUUM/);
 assert.match(query,/readOnly:true/);
});

test("Atlas routes require literal Founder RBAC instead of wildcard superuser",()=>{
 assert.match(data,/actor\.roleCode!=="founder"/);
 assert.match(ingest,/requireFounderRole/);
 assert.match(chat,/requireFounderRole/);
});

test("Tally ingestion is bounded, streamed for CSV, and writes 500-row governed batches",()=>{
 assert.match(ingest,/MAX_ROWS=100_000/);
 assert.match(ingest,/ROWS_PER_DB_BATCH=500/);
 assert.match(ingest,/csvRows\(request\.body\)/);
 assert.match(ingest,/MAX_XLSX_BYTES=25\*1024\*1024/);
});

test("Atlas campaign approval cannot bypass governed campaign approval/snapshot",()=>{
 assert.match(data,/activateCampaign/);
 assert.match(data,/action_status='approval_required'/);
 assert.match(chat,/action==="approve"/);
 assert.match(chat,/Yes, execute\./);
});

test("Atlas WebSocket and daily Cloudflare cron are wired",()=>{
 assert.match(worker,/handleAtlasWebSocket/);
 assert.match(worker,/runAtlasDailyAnalysis/);
 assert.match(worker,/controller\.cron==="15 2 \* \* \*"/);
 assert.match(vite,/"15 2 \* \* \*"/);
});
