import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DYNAMIC_IMPORT, REPLACEMENT, vendored } from '../../../scripts/vendor-exifr';

const root = join(__dirname, '..', '..', '..');

test('the vendored exifr is the installed full bundle with only its dynamic import replaced (npm run vendor:exifr)', () => {
  const source = readFileSync(join(root, 'node_modules/exifr/dist/full.umd.js'), 'utf8');
  const copy = readFileSync(join(root, 'src/media/vendor/exifr.js'), 'utf8');
  assert.equal(copy, vendored(source));
  assert.ok(!copy.includes(DYNAMIC_IMPORT) && copy.includes(REPLACEMENT));
});
