/** Structural PDF fixtures only; they are not signed company documents. */
export function pdfFromObjects(objects, trailerExtra = '') {
  let raw = '%PDF-1.4\n% SYNTHETIC TEST ONLY\n', offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(raw.length); raw += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = raw.length;
  raw += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) raw += `${String(offset).padStart(10, '0')} 00000 n \n`;
  raw += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(raw, 'latin1'));
}
export function pdfObjects(pages = 1) {
  const stream = '% SYNTHETIC - NO REAL SIGNATURE OR MEETING\nq Q\n', contentId = pages + 3;
  return [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(' ')}] >>`,
    ...Array.from({ length: pages }, () => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${contentId} 0 R >>`),
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ];
}
export const fixturePdf = (pages = 1) => pdfFromObjects(pdfObjects(pages));
