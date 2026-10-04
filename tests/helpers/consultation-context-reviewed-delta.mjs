import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const receipt = JSON.parse(readFileSync(new URL('../fixtures/consultation-context-reviewed-delta.json', import.meta.url)));
const hash = value => createHash('sha256').update(value).digest('hex');

/** Reverse only the four exact PR1268 consultation postimages before older preservation guards run. */
export function preservedConsultationContextBytes(path, bytes) {
  const entry = receipt.files[path];
  if (!entry || hash(bytes) === entry.beforeSha256) return bytes;
  assert.equal(hash(bytes), entry.afterSha256, `Exact reviewed consultation context required: ${path}`);
  let source = bytes.toString();
  for (const [before, after] of [...entry.replacements].reverse()) {
    assert.equal(source.split(after).length, 2, `Unique consultation context reversal: ${path}`);
    source = source.replace(after, () => before);
  }
  assert.equal(hash(source), entry.beforeSha256, `Exact pre-consultation source restored: ${path}`);
  return Buffer.isBuffer(bytes) ? Buffer.from(source) : source;
}
