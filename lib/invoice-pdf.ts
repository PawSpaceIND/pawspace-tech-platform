/**
 * Dependency-free, Cloudflare-Workers-safe invoice PDF rendering.
 *
 * The Workers runtime has no headless browser and no Node PDF libraries, and this repo deliberately
 * carries almost no dependencies, so we emit a valid PDF by hand. It uses only the two built-in
 * ("standard 14") PDF fonts Helvetica / Helvetica-Bold, so nothing needs embedding and the byte stream
 * stays pure single-byte text. The Indian Rupee glyph is not in Helvetica's WinAnsi encoding, so
 * amounts are rendered with the "INR" currency prefix rather than "₹".
 *
 * Output is a Uint8Array ready to hand straight to `new Response(bytes, {headers:{"content-type":
 * "application/pdf"}})`.
 */

export type InvoiceLine = {label: string; value: string};

export type InvoicePdfInput = {
  invoiceNumber: string;
  status: string;
  issueDate: string;
  sellerName: string;
  sellerLines?: string[];
  customerName: string;
  customerLines?: string[];
  meta: InvoiceLine[];
  currency: string;
  grossAmount: number;
  taxAmount: number | null;
  netAmount: number;
  taxNote?: string;
  footerNote?: string;
};

// PDF text strings are ()-delimited; escape the three special bytes and keep output to single-byte
// (<=0xFF) chars so string length equals byte length — the xref offsets below depend on that.
function pdfString(s: string): string {
  let out = "";
  for (const ch of String(s ?? "")) {
    const code = ch.codePointAt(0) ?? 63;
    const c = code <= 0xff ? ch : "?";
    if (c === "\\" || c === "(" || c === ")") out += "\\" + c;
    else if (code < 0x20) out += " ";
    else out += c;
  }
  return out;
}

function money(currency: string, n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  return `${currency} ${v.toFixed(2)}`;
}

export function renderInvoicePdf(input: InvoicePdfInput): Uint8Array {
  const W = 595, H = 842, L = 56; // A4 points, left/right margin
  const ops: string[] = [];
  const T = (x: number, y: number, size: number, font: "F1" | "F2", str: string) =>
    ops.push(`BT /${font} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${pdfString(str)}) Tj ET\n`);
  const HR = (y: number) => ops.push(`0.6 w ${L} ${y.toFixed(2)} m ${W - L} ${y.toFixed(2)} l S\n`);

  // Header
  T(L, H - 60, 18, "F2", input.sellerName);
  let y = H - 78;
  for (const ln of input.sellerLines ?? []) { T(L, y, 9, "F1", ln); y -= 12; }
  T(W - L - 170, H - 60, 20, "F2", input.taxAmount != null && input.taxAmount > 0 ? "TAX INVOICE" : "INVOICE");

  y = Math.min(y, H - 96) - 6;
  HR(y); y -= 22;

  // Invoice identity
  T(L, y, 10, "F2", "Invoice No:"); T(L + 72, y, 10, "F1", input.invoiceNumber);
  T(W - L - 210, y, 10, "F2", "Date:"); T(W - L - 175, y, 10, "F1", input.issueDate); y -= 15;
  T(L, y, 10, "F2", "Status:"); T(L + 72, y, 10, "F1", input.status); y -= 26;

  // Bill to
  T(L, y, 11, "F2", "Bill To"); y -= 15;
  T(L, y, 10, "F1", input.customerName); y -= 13;
  for (const ln of input.customerLines ?? []) { T(L, y, 9, "F1", ln); y -= 12; }
  y -= 6; HR(y); y -= 22;

  // Booking / service meta
  for (const m of input.meta) { T(L, y, 10, "F2", m.label); T(L + 160, y, 10, "F1", m.value); y -= 15; }
  y -= 6; HR(y); y -= 22;

  // Amounts (right aligned block)
  const amountRow = (label: string, value: string, bold = false) => {
    const f = bold ? "F2" : "F1";
    T(W - L - 260, y, 10, f, label);
    T(W - L - 110, y, 10, f, value);
    y -= 16;
  };
  amountRow("Subtotal", money(input.currency, input.grossAmount));
  amountRow("Tax", input.taxAmount == null ? "Not applied (configuration pending)" : money(input.currency, input.taxAmount));
  HR(y + 9);
  y -= 4;
  amountRow("Total", money(input.currency, input.netAmount), true);

  // Notes
  y -= 14;
  if (input.taxNote) { T(L, y, 8, "F1", input.taxNote.slice(0, 120)); y -= 12; }
  if (input.footerNote) { T(L, y, 8, "F1", input.footerNote.slice(0, 120)); y -= 12; }

  const content = ops.join("");

  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objects[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`;
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  objects[6] = `<< /Length ${content.length} >>\nstream\n${content}endstream`;

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i <= 6; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = pdf.length;
  pdf += `xref\n0 7\n0000000000 65535 f \n`;
  for (let i = 1; i <= 6; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;

  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}
