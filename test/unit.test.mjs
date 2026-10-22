/**
 * Unit tests — no network, no host process.
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';

import {
  DEFAULTS,
  assertRuntimeSupported,
  resolveConfig,
  parsePages,
  compileParameters,
  compileValueSpec,
  extractPdf,
  fetchPdf,
  toolSpecs,
  apply,
} from '../lib/index.js';

/* --------------------------------------------------------------- config */

test('resolveConfig: defaults when omitted', () => {
  const cfg = resolveConfig(undefined);
  assert.equal(cfg.cacheDir, DEFAULTS.cacheDir);
  assert.equal(cfg.fetchAttempts, 4);
});

test('resolveConfig: user values are applied and normalised', () => {
  const cfg = resolveConfig({ cacheDir: './pdfcache', maxPdfBytes: 1024, defaultMaxChars: 10, fetchAttempts: 2, fetchPerAttemptTimeoutMs: 5 });
  assert.ok(path.isAbsolute(cfg.cacheDir));
  assert.equal(cfg.maxPdfBytes, 1024);
  assert.equal(cfg.fetchAttempts, 2);
});

test('resolveConfig: unknown key is rejected', () => {
  assert.throws(() => resolveConfig({ cachDir: '/x' }), /unknown config key "cachDir"/);
});

test('resolveConfig: wrong types are rejected', () => {
  assert.throws(() => resolveConfig({ fetchAttempts: '4' }), /must be an integer/);
  assert.throws(() => resolveConfig({ fetchAttempts: 2.5 }), /must be an integer/);
  assert.throws(() => resolveConfig({ maxPdfBytes: -1 }), /must be an integer/);
  assert.throws(() => resolveConfig({ cacheDir: '' }), /non-empty string/);
  assert.throws(() => resolveConfig('nope'), /config must be an object/);
});

/* ---------------------------------------------------------------- pages */

test('parsePages: all / undefined', () => {
  assert.deepEqual(parsePages(undefined, 3), [1, 2, 3]);
  assert.deepEqual(parsePages('all', 3), [1, 2, 3]);
});

test('parsePages: ranges, lists, clamping and dedupe', () => {
  assert.deepEqual(parsePages('1-3', 5), [1, 2, 3]);
  assert.deepEqual(parsePages('3', 5), [3]);
  assert.deepEqual(parsePages('1,4-6', 10), [1, 4, 5, 6]);
  assert.deepEqual(parsePages('5-2', 6), [2, 3, 4, 5]);   // reversed range
  assert.deepEqual(parsePages('9-99', 10), [9, 10]);      // clamped
  assert.deepEqual(parsePages('1,1,2', 5), [1, 2]);       // deduped
});

test('parsePages: out-of-range and garbage are rejected', () => {
  assert.throws(() => parsePages('99', 3), /PDF_BAD_PAGES/);
  assert.throws(() => parsePages('abc', 3), /PDF_BAD_PAGES/);
});

/* ------------------------------------------------------- schema compiler */

test('compileValueSpec: property required:true lifts to object required[]', () => {
  const out = compileValueSpec({
    type: 'object',
    additionalProperties: false,
    properties: {
      a: { type: 'string', required: true },
      b: { type: 'number' },
      c: { type: 'array', required: true, items: { type: 'string' } },
    },
  });
  assert.deepEqual(out.required, ['a', 'c']);
  assert.equal(out.properties.a.required, undefined);
  assert.deepEqual(out.properties.c.items, { type: 'string' });
});

test('compileValueSpec: never invents additionalProperties', () => {
  // The host treats a parameter root as an implicit OPEN object; adding
  // additionalProperties:false here would make us stricter than the host.
  const out = compileParameters({ path: { type: 'string', required: true } });
  assert.equal('additionalProperties' in out, false);
  assert.deepEqual(out.required, ['path']);
});

test('compileValueSpec: rejects malformed nodes', () => {
  assert.throws(() => compileValueSpec(null), /must be an object/);
  assert.throws(() => compileValueSpec({ type: 'array' }), /needs items/);
  assert.throws(() => compileValueSpec({ type: 'object', properties: { x: 1 } }), /must be a schema object/);
});

/* ------------------------------------------------------------ tool spec */

test('every tool declares schema + render (the boot-fatal contract)', () => {
  for (const spec of toolSpecs) {
    assert.equal(typeof spec.output?.render, 'function', `${spec.name} must declare output.render`);
    assert.equal(typeof spec.output?.schema, 'object', `${spec.name} must declare output.schema`);
    assert.ok(spec.output.presentationMeta === undefined || typeof spec.output.presentationMeta === 'function');
    assert.notEqual(spec.name, 'run_code', 'reserved transport name');
  }
});

test('render returns ContentBlock[]', () => {
  const extract = toolSpecs.find((t) => t.name === 'pdf_extract');
  const blocks = extract.output.render({ path: '/tmp/a.pdf' }, {
    pageCount: 4, pagesExtracted: [1], chars: 3, truncated: true, text: 'abc',
  });
  assert.ok(Array.isArray(blocks) && blocks[0].type === 'text');
  assert.match(blocks[0].text, /4 页/);

  const fetchTool = toolSpecs.find((t) => t.name === 'pdf_fetch');
  const bad = fetchTool.output.render({ url: 'http://x' }, {
    path: '/tmp/a.pdf.part', bytes: 12, attempts: 4, complete: false, cached: false, error: 'HTTP_500',
  });
  assert.match(bad[0].text, /下载不完整/);
});

test('apply registers both tools and rejects bad config', async () => {
  const registered = [];
  const ctx = { tools: { register: (d) => { registered.push(d); return () => {}; } } };
  await apply(ctx, { defaultMaxChars: 1234 });
  assert.deepEqual(registered.map((d) => d.name), ['pdf_extract', 'pdf_fetch']);
  await assert.rejects(() => apply(ctx, { nope: 1 }), /unknown config key/);
});

/* --------------------------------------------------------------- errors */

test('extractPdf: missing file', async () => {
  await assert.rejects(() => extractPdf('/nonexistent/x.pdf'), /PDF_NOT_FOUND/);
});

test('extractPdf: not a PDF', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dshtoolpdf-'));
  const p = path.join(dir, 'x.pdf');
  await writeFile(p, 'this is not a pdf');
  await assert.rejects(() => extractPdf(p), /PDF_BAD_MAGIC/);
});

test('extractPdf: truncated PDF fails loudly instead of returning garbage', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dshtoolpdf-'));
  const p = path.join(dir, 't.pdf');
  // valid magic, plenty of bytes, but no %%EOF
  await writeFile(p, `${'%PDF-1.5\n'}${'x'.repeat(4096)}`);
  await assert.rejects(() => extractPdf(p), /PDF_TRUNCATED/);
});

test('extractPdf: oversized file is refused', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dshtoolpdf-'));
  const p = path.join(dir, 'big.pdf');
  await writeFile(p, `%PDF-1.5\n${'x'.repeat(2048)}\n%%EOF`);
  await assert.rejects(() => extractPdf(p, { maxPdfBytes: 100 }), /PDF_TOO_LARGE/);
});

test('fetchPdf: unreachable URL reports complete:false', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dshtoolpdf-'));
  const r = await fetchPdf('http://127.0.0.1:1/nope.pdf', { attempts: 1, perAttemptTimeoutMs: 800, cacheDir: dir });
  assert.equal(r.complete, false);
  assert.equal(typeof r.path, 'string');
  assert.ok(r.error);
});

test('fetchPdf: non-http protocol is rejected', async () => {
  await assert.rejects(() => fetchPdf('file:///etc/passwd'), /PDF_BAD_URL/);
});

/* -------------------------------------------------------------- runtime */

test('assertRuntimeSupported: passes on a modern runtime', () => {
  assert.doesNotThrow(() => assertRuntimeSupported());
});

test('assertRuntimeSupported: named error when Promise.withResolvers is missing', () => {
  const saved = Promise.withResolvers;
  // eslint-disable-next-line no-delete-var
  delete Promise.withResolvers;
  try {
    assert.throws(() => assertRuntimeSupported(), /NODE_TOO_OLD: pdfjs-dist 6\.x requires Node >= 22\.13/);
  } finally {
    Promise.withResolvers = saved;
  }
});
