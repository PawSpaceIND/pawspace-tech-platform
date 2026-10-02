import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = readFileSync(join(root, 'app/team/ai/handoff/page.tsx'), 'utf8');

test('handoff page renders canonical response deadline fields', () => {
  assert.match(page, /responseDeadline/);
  assert.match(page, /Response deadline/i);
});
