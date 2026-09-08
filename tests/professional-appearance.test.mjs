import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('professional default and cartoon backup are separate from colour selection', () => {
 const source = readFileSync('app/components/pawspace-appearance.tsx', 'utf8');
 assert.match(source, /useState\("professional"\)/);
 assert.match(source, /\["professional", "cartoon"\]/);
 assert.match(source, /pawspace.visual-style/);
 assert.match(source, /dataset.pawStyle = style/);
 assert.match(source, /themes.map/);
 assert.doesNotMatch(source, /fetch\(/);
});
