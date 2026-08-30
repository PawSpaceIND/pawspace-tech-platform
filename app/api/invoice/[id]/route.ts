import {database, resolveActor, requireCustomerOwnership} from "../../../../lib/server-auth";
import {hasPermission} from "../../../../lib/platform-security";
import {renderInvoicePdf, type InvoiceLine} from "../../../../lib/invoice-pdf";

type Row = Record<string, unknown>;
const text = (v: unknown) => String(v ?? "").trim();

// Staff who may read any customer's invoice document. A plain customer must own the booking.
function isFinanceOrOps(permissions: string[]) {
  return (
    hasPermission(permissions, "finance.view") ||
    hasPermission(permissions, "payments.view") ||
    hasPermission(permissions, "bookings.view") ||
    hasPermission(permissions, "bookings.manage")
  );
}

function istDate(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  return new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
}
function istDateTime(iso: string) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return text(iso) || "—";
  return new Date(t + 330 * 60_000).toISOString().replace("T", " ").slice(0, 16) + " IST";
}

/**
 * GET /api/invoice/:id.pdf — render the invoice for a completed booking as a downloadable PDF.
 * `id` may be the invoice number (what customers see), the invoice id, or the booking id. The central
 * API gateway maps /api/invoice/* to no fixed permission (see lib/api-gateway.ts) and authorization is
 * enforced here: the owning customer, or a finance/ops staff actor.
 */
export async function GET(request: Request, {params}: {params: Promise<{id: string}>}) {
  try {
    const {id} = await params;
    const key = decodeURIComponent(String(id || "")).replace(/\.pdf$/i, "").trim();
    if (!key) return Response.json({error: "Invoice reference is required"}, {status: 400});

    const db = await database();
    const actor = await resolveActor(request); // throws a 401 Response when unauthenticated

    const invoice = await db
      .prepare("SELECT * FROM booking_invoices WHERE invoice_number=? OR id=? OR booking_id=? ORDER BY created_at DESC LIMIT 1")
      .bind(key, key, key)
      .first<Row>()
      .catch(() => null);
    if (!invoice) return Response.json({error: "Invoice not found"}, {status: 404});

    // Authorization: finance/ops staff, or the customer who owns the booking.
    if (!isFinanceOrOps(actor.permissions) && !actor.developmentPreview) {
      await requireCustomerOwnership(db, actor, text(invoice.customer_id)); // throws 403 Response otherwise
    }

    const bookingId = text(invoice.booking_id);
    const [booking, work, tax, customer] = await Promise.all([
      db.prepare("SELECT * FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>().catch(() => null),
      db.prepare("SELECT * FROM provider_work_orders WHERE booking_id=?").bind(bookingId).first<Row>().catch(() => null),
      db.prepare("SELECT * FROM booking_tax_readiness WHERE booking_id=?").bind(bookingId).first<Row>().catch(() => null),
      db.prepare("SELECT * FROM canonical_customers WHERE id=?").bind(text(invoice.customer_id)).first<Row>().catch(() => null),
    ]);

    const taxConfigured = !!tax && text(tax.tax_rule_status) !== "configuration_required" && tax.tax_amount != null;
    const taxAmount = taxConfigured ? Number(invoice.tax_amount) : null;
    const gross = Number(invoice.gross_amount ?? booking?.total_amount ?? 0);
    const net = Number(invoice.net_amount ?? gross);

    const meta: InvoiceLine[] = [{label: "Booking ID", value: bookingId || "—"}];
    if (booking) {
      const service = text(booking.service_code).replace(/_/g, " ");
      const pkg = text(booking.package_name);
      meta.push({label: "Service", value: pkg ? `${service} — ${pkg}` : service || "—"});
      meta.push({label: "Scheduled", value: istDateTime(text(booking.scheduled_start))});
    }
    if (work?.provider_name) meta.push({label: "Provider", value: text(work.provider_name)});

    const customerLines: string[] = [];
    if (customer?.primary_phone) customerLines.push(text(customer.primary_phone));
    if (customer?.email) customerLines.push(text(customer.email));
    customerLines.push(`Customer ${text(invoice.customer_id)}`);

    const pdf = renderInvoicePdf({
      invoiceNumber: text(invoice.invoice_number) || text(invoice.id),
      status: text(invoice.status) || "issued",
      issueDate: istDate(Number(invoice.issued_at ?? invoice.created_at ?? 0)),
      sellerName: "PawSpace Pet Care",
      sellerLines: ["Bengaluru, Karnataka, India", "support@pawspace.in"],
      customerName: text(customer?.name) || text(invoice.customer_id),
      customerLines,
      meta,
      currency: text(invoice.currency) || "INR",
      grossAmount: gross,
      taxAmount,
      netAmount: net,
      taxNote: taxConfigured ? undefined : text(tax?.reason) || "Tax not applied — production GST rule pending approval; this is not a production tax invoice.",
      footerNote: "Sandbox/UAT document — no live money movement.",
    });

    const body = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer;
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${(text(invoice.invoice_number) || "invoice").replace(/[^A-Za-z0-9._-]/g, "_")}.pdf"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({error: error instanceof Error ? error.message : "Unable to render invoice"}, {status: 500});
  }
}
