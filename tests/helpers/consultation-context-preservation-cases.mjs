import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { preservedConsultationContextBytes } from './consultation-context-reviewed-delta.mjs';

const receipt = JSON.parse(readFileSync(new URL('../fixtures/consultation-context-reviewed-delta.json', import.meta.url)));
const hash = value => createHash('sha256').update(value).digest('hex');

for (const [path, entry] of Object.entries(receipt.files)) {
  test(`PR1268 exact consultation context restores reviewed base: ${path}`, () => {
    const bytes = readFileSync(new URL(`../../${path}`, import.meta.url));
    assert.equal(hash(bytes), entry.afterSha256);
    const restored = preservedConsultationContextBytes(path, bytes);
    assert.equal(hash(restored), entry.beforeSha256);
    assert.deepEqual(preservedConsultationContextBytes(path, restored), restored);
    assert.throws(() => preservedConsultationContextBytes(path, Buffer.concat([bytes, Buffer.from('\n')])), /Exact reviewed consultation context required/);
  });
}
