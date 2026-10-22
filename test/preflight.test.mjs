/**
 * Runs the registration-mirror preflight as part of `npm test`.
 * Kept as a test (not just a script) so any drift between the plugin's
 * schema compiler and the host's `defineTool()` fails CI, not production boot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('preflight passes (registration contract + host parity + end-to-end)', () => {
  const r = spawnSync(
    process.execPath,
    [path.join(root, 'bin/preflight.mjs'), path.join(root, 'fixtures/sample.pdf')],
    { encoding: 'utf8' },
  );
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  assert.equal(r.status, 0, `preflight failed:\n${out}`);
  assert.match(out, /结果: \d+ 通过 \/ 0 失败/);
});
