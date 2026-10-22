/**
 * Download-path tests against a throwaway local HTTP server: no external
 * network, but the full fetchPdf pipeline (Range resume, retries, %%EOF check,
 * cache hit) is exercised.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { fetchPdf } from '../lib/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, '..', 'fixtures', 'sample.pdf');

/** Serve one buffer at `/ok.pdf`, honouring Range requests. */
async function startServer(body) {
  const server = http.createServer((req, res) => {
    const range = req.headers.range;
    const m = range && /bytes=(\d+)-/.exec(range);
    if (m) {
      const start = Number(m[1]);
      res.writeHead(206, {
        'content-type': 'application/pdf',
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${body.length - 1}/${body.length}`,
      });
      res.end(body.subarray(start));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': body.length });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}/ok.pdf` };
}

test('fetchPdf: completes and verifies a small valid PDF (no 1 KiB floor)', async () => {
  const body = await readFile(FIXTURE);
  assert.ok(body.length < 1024, 'fixture must be small to guard the size-floor regression');
  const { server, url } = await startServer(body);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dshtoolpdf-fetch-'));
  try {
    const r = await fetchPdf(url, { cacheDir: dir, attempts: 2, perAttemptTimeoutMs: 3000 });
    assert.equal(r.complete, true, `expected complete, got ${r.error}`);
    assert.equal(r.bytes, body.length);
    assert.deepEqual(await readFile(r.path), body);
  } finally {
    server.close();
  }
});

test('fetchPdf: a second call hits the cache', async () => {
  const body = await readFile(FIXTURE);
  const { server, url } = await startServer(body);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dshtoolpdf-cache-'));
  try {
    const first = await fetchPdf(url, { cacheDir: dir, attempts: 2, perAttemptTimeoutMs: 3000 });
    assert.equal(first.complete, true);
    const second = await fetchPdf(url, { cacheDir: dir });
    assert.equal(second.complete, true);
    assert.equal(second.cached, true);
    assert.equal(second.attempts, 0);
  } finally {
    server.close();
  }
});

test('fetchPdf: a body without %%EOF stays incomplete and is never renamed', async () => {
  const body = Buffer.from(`%PDF-1.4\n${'x'.repeat(2000)}`); // no trailer
  const { server, url } = await startServer(body);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dshtoolpdf-trunc-'));
  try {
    const r = await fetchPdf(url, { cacheDir: dir, attempts: 2, perAttemptTimeoutMs: 3000 });
    assert.equal(r.complete, false);
    assert.match(r.path, /\.part$/);
    assert.ok(r.bytes > 0);
  } finally {
    server.close();
  }
});

test('fetchPdf: resumes from an existing .part file', async () => {
  const body = await readFile(FIXTURE);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dshtoolpdf-resume-'));
  const { server, url } = await startServer(body);
  try {
    // Pre-seed a partial file whose name matches the cache key.
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(url).digest('hex').slice(0, 16);
    const partial = path.join(dir, `${hash}-ok.pdf.part`);
    await writeFile(partial, body.subarray(0, 200));
    const r = await fetchPdf(url, { cacheDir: dir, attempts: 2, perAttemptTimeoutMs: 3000 });
    assert.equal(r.complete, true, `expected complete, got ${r.error}`);
    assert.deepEqual(await readFile(r.path), body);
  } finally {
    server.close();
  }
});
