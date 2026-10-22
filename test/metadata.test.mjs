/**
 * Release-metadata consistency. These are exactly the checks a reviewer runs
 * ("does the tarball contain what the docs promise?", "is the lockfile from a
 * registry the outside world can reach?") — cheap to assert, expensive to miss.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readJson = async (p) => JSON.parse(await readFile(path.join(root, p), 'utf8'));

test('package-lock versions match package.json', async () => {
  const pkg = await readJson('package.json');
  const lock = await readJson('package-lock.json');
  assert.equal(lock.version, pkg.version, 'lockfile top-level version drifted');
  assert.equal(lock.packages[''].version, pkg.version, 'lockfile root package version drifted');
});

test('lockfile resolves from a public registry', async () => {
  const raw = await readFile(path.join(root, 'package-lock.json'), 'utf8');
  const hosts = new Set([...raw.matchAll(/"resolved":\s*"\w+:\/\/([^/"]+)/g)].map((m) => m[1]));
  for (const host of hosts) {
    assert.ok(/^(registry\.npmjs\.org|registry\.yarnpkg\.com)$/.test(host),
      `lockfile points at a non-public registry: ${host} (CI cannot resolve it)`);
  }
});

test('published files list covers the documents we ship', async () => {
  const pkg = await readJson('package.json');
  const files = pkg.files ?? [];
  for (const required of ['lib/', 'bin/', 'CHANGELOG.md', 'THIRD-PARTY-NOTICES.md', 'LICENSE', 'README.md']) {
    assert.ok(files.includes(required), `package.json#files is missing ${required}`);
  }
});

test('declared Node engine satisfies the pdfjs-dist requirement', async () => {
  const pkg = await readJson('package.json');
  const pdfjs = await readJson('node_modules/pdfjs-dist/package.json');
  // pdfjs-dist declares e.g. ">=22.13.0 || >=24"; our floor must not be lower.
  const floor = Number(/(\d+)\.(\d+)\.(\d+)/.exec(pkg.engines.node)?.[1]);
  const depFloor = Number(/(\d+)\.(\d+)\.(\d+)/.exec(pdfjs.engines.node)?.[1]);
  assert.ok(Number.isFinite(floor), 'engines.node must declare a floor');
  assert.ok(floor >= depFloor, `engines.node (${pkg.engines.node}) is below pdfjs-dist's (${pdfjs.engines.node})`);
});

test('no placeholder OWNER left in shipped metadata', async () => {
  for (const f of ['package.json', 'README.md']) {
    const raw = await readFile(path.join(root, f), 'utf8');
    assert.ok(!raw.includes('OWNER'), `${f} still contains the OWNER placeholder`);
  }
});
