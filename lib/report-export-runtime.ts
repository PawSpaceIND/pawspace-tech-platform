type Db = D1Database;
type Row = Record<string, unknown>;
const text = (v: unknown) => String(v ?? "").trim();
const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const rows = <T = Row>(r: { results?: unknown[] }) => (r.results ?? []) as T[];

export async function ensureReportExportTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS report_export_jobs (id TEXT PRIMARY KEY,report_type TEXT NOT NULL,format TEXT NOT NULL,filters_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',requested_by TEXT NOT NULL,requested_at INTEGER NOT NULL,started_at INTEGER,completed_at INTEGER,error TEXT,content_base64 TEXT,mime_type TEXT,file_name TEXT,row_count INTEGER NOT NULL DEFAULT 0)"),
    db.prepare("CREATE INDEX IF NOT EXISTS report_export_jobs_status_idx ON report_export_jobs(status,requested_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS report_export_schedules (id TEXT PRIMARY KEY,report_type TEXT NOT NULL,format TEXT NOT NULL,filters_json TEXT NOT NULL,recipients_json TEXT NOT NULL,delivery_channels_json TEXT NOT NULL,cadence TEXT NOT NULL,next_run_at INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS report_export_schedules_due_idx ON report_export_schedules(active,next_run_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS report_export_deliveries (id TEXT PRIMARY KEY,export_job_id TEXT NOT NULL,recipient TEXT NOT NULL,channel TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',provider_reference TEXT,last_error TEXT,created_at INTEGER NOT NULL,delivered_at INTEGER)"),
  ]);
}

function csvEscape(value: unknown) {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(data: Row[]) {
  const columns = [...new Set(data.flatMap(row => Object.keys(row)))];
  return [columns.map(csvEscape).join(","), ...data.map(row => columns.map(col => csvEscape(row[col])).join(","))].join("\n");
}

function pdfEscape(value: string) { return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)"); }
function toPdf(title: string, data: Row[]) {
  const lines = [title, `Generated: ${new Date().toISOString()}`, ...data.slice(0, 80).map(row => Object.entries(row).map(([k, v]) => `${k}: ${String(v ?? "")}`).join(" | "))];
  const body = lines.map((line, index) => `BT /F1 9 Tf 40 ${800 - index * 10} Td (${pdfEscape(line.slice(0, 180))}) Tj ET`).join("\n");
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj",
    "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    `5 0 obj << /Length ${body.length} >> stream\n${body}\nendstream endobj`,
  ];
  let pdf = "%PDF-1.4\n", offsets = [0];
  for (const object of objects) { offsets.push(pdf.length); pdf += `${object}\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return pdf;
}

function base64Utf8(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function queryReport(db: Db, reportType: string, filters: Record<string, unknown>) {
  const limit = Math.max(1, Math.min(5000, Number(filters.limit || 1000)));
  switch (reportType) {
    case "pipeline": return rows(await db.prepare("SELECT id,lead_id,customer_id,service_code,owner,stage,status,amount,stage_probability,next_best_action,next_action_at,created_at,updated_at FROM crm_opportunities ORDER BY updated_at DESC LIMIT ?").bind(limit).all<Row>());
    case "forecast": return rows(await db.prepare("SELECT * FROM crm_forecast_snapshots ORDER BY generated_at DESC LIMIT ?").bind(Math.min(limit, 500)).all<Row>());
    case "lead_scores": return rows(await db.prepare("SELECT s.*,l.customer_id,l.owner,l.service,l.status FROM lead_scores s JOIN lead_work_items l ON l.id=s.lead_id ORDER BY s.total_score DESC,s.computed_at DESC LIMIT ?").bind(limit).all<Row>());
    case "win_loss": return rows(await db.prepare("SELECT id,customer_id,service_code,owner,stage,status,amount,lost_reason,won_booking_id,created_at,updated_at FROM crm_opportunities WHERE status IN ('won','lost') ORDER BY updated_at DESC LIMIT ?").bind(limit).all<Row>());
    case "email_engagement": return rows(await db.prepare("SELECT provider,event_type,message_id,thread_id,customer_id,provider_message_id,occurred_at FROM crm_email_events ORDER BY occurred_at DESC LIMIT ?").bind(limit).all<Row>());
    default: throw new Error("Unsupported report type");
  }
}

export async function queueReportExport(db: Db, input: { reportType: string; format: "csv" | "pdf"; filters?: Record<string, unknown>; actorId: string }) {
  await ensureReportExportTables(db);
  if (!["csv", "pdf"].includes(input.format)) throw new Error("Export format must be csv or pdf");
  const id = uid("EXP"), now = Date.now();
  await db.prepare("INSERT INTO report_export_jobs (id,report_type,format,filters_json,status,requested_by,requested_at) VALUES (?,?,?,?, 'queued',?,?)")
    .bind(id, input.reportType, input.format, JSON.stringify(input.filters || {}), input.actorId, now).run();
  return { id, status: "queued" };
}

export async function processReportExportJobs(db: Db, input: { limit?: number } = {}) {
  await ensureReportExportTables(db);
  const jobs = rows(await db.prepare("SELECT * FROM report_export_jobs WHERE status='queued' ORDER BY requested_at LIMIT ?").bind(Math.max(1, Math.min(50, input.limit ?? 10))).all<Row>());
  let completed = 0;
  for (const job of jobs) {
    const started = Date.now();
    await db.prepare("UPDATE report_export_jobs SET status='processing',started_at=? WHERE id=? AND status='queued'").bind(started, job.id).run();
    try {
      const filters = JSON.parse(text(job.filters_json) || "{}") as Record<string, unknown>, data = await queryReport(db, text(job.report_type), filters);
      const format = text(job.format), rendered = format === "csv" ? toCsv(data) : toPdf(`PawSpace ${text(job.report_type)} report`, data);
      const mime = format === "csv" ? "text/csv;charset=utf-8" : "application/pdf", fileName = `pawspace-${text(job.report_type)}-${new Date().toISOString().slice(0, 10)}.${format}`;
      await db.prepare("UPDATE report_export_jobs SET status='completed',completed_at=?,content_base64=?,mime_type=?,file_name=?,row_count=?,error=NULL WHERE id=?")
        .bind(Date.now(), base64Utf8(rendered), mime, fileName, data.length, job.id).run();
      completed++;
    } catch (error) {
      await db.prepare("UPDATE report_export_jobs SET status='failed',completed_at=?,error=? WHERE id=?").bind(Date.now(), error instanceof Error ? error.message : String(error), job.id).run();
    }
  }
  return { processed: jobs.length, completed };
}

function nextRun(cadence: string, from: number) {
  const day = 86400000;
  if (cadence === "daily") return from + day;
  if (cadence === "weekly") return from + 7 * day;
  if (cadence === "monthly") return from + 30 * day;
  throw new Error("Unsupported export cadence");
}

export async function runScheduledReportExports(db: Db, input: { actorId?: string; asOf?: number } = {}) {
  await ensureReportExportTables(db);
  const asOf = input.asOf ?? Date.now(), due = rows(await db.prepare("SELECT * FROM report_export_schedules WHERE active=1 AND next_run_at<=? ORDER BY next_run_at LIMIT 50").bind(asOf).all<Row>());
  let queued = 0;
  for (const schedule of due) {
    const exportJob = await queueReportExport(db, { reportType: text(schedule.report_type), format: text(schedule.format) as "csv" | "pdf", filters: JSON.parse(text(schedule.filters_json) || "{}"), actorId: input.actorId || "system:report-scheduler" });
    const recipients = JSON.parse(text(schedule.recipients_json) || "[]") as string[], channels = JSON.parse(text(schedule.delivery_channels_json) || "[]") as string[];
    for (const recipient of recipients) for (const channel of channels) await db.prepare("INSERT INTO report_export_deliveries (id,export_job_id,recipient,channel,status,created_at) VALUES (?,?,?,?, 'queued',?)")
      .bind(uid("EXPD"), exportJob.id, recipient, channel, asOf).run();
    await db.prepare("UPDATE report_export_schedules SET next_run_at=?,updated_at=? WHERE id=?").bind(nextRun(text(schedule.cadence), asOf), asOf, schedule.id).run();
    queued++;
  }
  return { schedulesProcessed: due.length, exportsQueued: queued };
}

export async function dispatchReportExportDeliveries(db: Db, env: Record<string, unknown>, input: { limit?: number } = {}) {
  await ensureReportExportTables(db);
  const deliveries = rows(await db.prepare("SELECT d.*,j.file_name,j.mime_type,j.content_base64,j.status job_status FROM report_export_deliveries d JOIN report_export_jobs j ON j.id=d.export_job_id WHERE d.status='queued' AND j.status='completed' ORDER BY d.created_at LIMIT ?").bind(Math.max(1, Math.min(100, input.limit ?? 25))).all<Row>());
  let delivered = 0;
  for (const delivery of deliveries) {
    try {
      if (text(delivery.channel) === "dashboard") {
        await db.prepare("UPDATE report_export_deliveries SET status='delivered',provider_reference='dashboard',delivered_at=? WHERE id=?").bind(Date.now(), delivery.id).run(); delivered++; continue;
      }
      if (text(delivery.channel) !== "email") throw new Error("Unsupported report delivery channel");
      const url = text(env.PAWSPACE_EMAIL_PROVIDER_URL), key = text(env.PAWSPACE_EMAIL_PROVIDER_API_KEY), from = text(env.PAWSPACE_EMAIL_FROM);
      if (!url || !key || !from) throw new Error("email_provider_not_configured");
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ from, to: text(delivery.recipient), subject: `PawSpace report: ${text(delivery.file_name)}`, text: "Your scheduled PawSpace report is attached.", attachments: [{ filename: delivery.file_name, contentType: delivery.mime_type, contentBase64: delivery.content_base64 }] }) });
      if (!response.ok) throw new Error(`email_provider_http_${response.status}`);
      const body = await response.json().catch(() => ({})) as Row;
      await db.prepare("UPDATE report_export_deliveries SET status='delivered',provider_reference=?,delivered_at=? WHERE id=?").bind(text(body.id || body.messageId) || "email_provider", Date.now(), delivery.id).run(); delivered++;
    } catch (error) {
      await db.prepare("UPDATE report_export_deliveries SET status='failed',last_error=? WHERE id=?").bind(error instanceof Error ? error.message : String(error), delivery.id).run();
    }
  }
  return { processed: deliveries.length, delivered };
}
