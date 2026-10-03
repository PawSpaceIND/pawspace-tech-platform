import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { inspectPdf, PDF_LIMITS } from '../lib/company-compliance/pdf-boundary.ts';
import { fixturePdf, pdfObjects, pdfFromObjects } from './helpers/company-compliance-fixtures.mjs';
test('validated classic xref/page tree determines actual pages and accepts Chromium print fixture', async () => {
  for (const pages of [1, 2, 40]) assert.equal((await inspectPdf(fixturePdf(pages))).pageCount, pages);
  assert.equal((await inspectPdf(new Uint8Array(await readFile(new URL('../qa/company-compliance/synthetic-resolution.pdf', import.meta.url))))).pageCount, 1);
});
test('header/type/size/EOF and cross-reference offsets fail closed without PDF repair', async () => {
  await assert.rejects(inspectPdf(new TextEncoder().encode('%PDF-1.4 forged content %%EOF')), /invalid_pdf/);
  await assert.rejects(inspectPdf(new Uint8Array(PDF_LIMITS.bytes + 1)), /invalid_pdf_size/);
  const raw = Buffer.from(fixturePdf()).toString('latin1');
  await assert.rejects(inspectPdf(new Uint8Array(Buffer.from(raw.replace(/startxref\s+(\d+)/, (_, offset) => `startxref\n${Number(offset) + 1}`), 'latin1'))), /classic_xref/);
  await assert.rejects(inspectPdf(new Uint8Array(Buffer.from(raw + '<html>polyglot</html>', 'latin1'))), /trailer/);
});
test('effective page tree rejects false counts, cycles, duplicate kids, bad parents and giant page dimensions', async () => {
  for (const [index, value] of [[1, '<< /Type /Pages /Count 2 /Kids [3 0 R] >>'], [1, '<< /Type /Pages /Count 2 /Kids [3 0 R 3 0 R] >>'], [1, '<< /Type /Pages /Count 1 /Kids [2 0 R] >>'], [2, '<< /Type /Page /Parent 1 0 R /MediaBox [0 0 595 842] >>'], [2, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 99999 842] >>']]) {
    const objects = pdfObjects(); objects[index] = value; await assert.rejects(inspectPdf(pdfFromObjects(objects)), /invalid_pdf/);
  }
  await assert.rejects(inspectPdf(fixturePdf(41)), /page_count|page_limit/);
});
test('encrypted, incremental, object-stream, active, attachment and escaped-name PDFs are refused', async () => {
  for (const name of ['JS', 'J#53', 'JavaScript', 'OpenAction', 'AcroForm', 'EmbeddedFile', 'ObjStm', 'URI']) {
    const objects = pdfObjects(); objects.push(`<< /${name} (synthetic) >>`); await assert.rejects(inspectPdf(pdfFromObjects(objects)), /active_or_unsupported/);
  }
  for (const key of ['Encrypt', 'Prev', 'XRefStm']) await assert.rejects(inspectPdf(pdfFromObjects(pdfObjects(), `/${key} 1 0 R`)), /active_or_unsupported/);
});
test('stream lengths and filter chains are validated, not trusted from textual signatures', async () => {
  const objects = pdfObjects(); objects.at(-1); objects[3] = objects[3].replace(/\/Length \d+/, '/Length 1');
  await assert.rejects(inspectPdf(pdfFromObjects(objects)), /stream_end/);
  const chain = pdfObjects(); chain[3] = chain[3].replace('/Length', '/Filter [/ASCII85Decode /FlateDecode] /Length');
  await assert.rejects(inspectPdf(pdfFromObjects(chain)), /filter_chain/);
});
test('compressed-stream and image expansion have explicit budgets', async () => {
  const objects = pdfObjects(), compressed = deflateSync(Buffer.alloc(PDF_LIMITS.inflatedStream + 1, 32));
  objects[3] = `<< /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n${compressed.toString('latin1')}\nendstream`;
  await assert.rejects(inspectPdf(pdfFromObjects(objects)), /decompression_limit/);
  const image = pdfObjects(); image.push('<< /Type /XObject /Subtype /Image /Width 10000 /Height 10000 >>');
  await assert.rejects(inspectPdf(pdfFromObjects(image)), /image_pixel_limit/);
});
