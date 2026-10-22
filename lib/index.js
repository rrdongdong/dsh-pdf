/**
 * # dsh-tool-pdf
 *
 * PDF download + text extraction tools for DSH / Cordis hosts.
 *
 * ## Why this exists
 * CVPR/CVF — and some IEEE — papers ship PDFs whose fonts are **subsetted CID
 * fonts** (glyph codes need a ToUnicode CMap) and whose font dictionaries are
 * packed inside **compressed object streams (/ObjStm)**. Naive stream scrapers
 * see zero font maps (empty text) and mistake 10–15 MB **vector figure
 * streams** for page content (effectively hanging). `pdfjs-dist` handles both
 * natively: an 11 MB paper loads in ~86 ms.
 *
 * ## Host-contract notes (learned the hard way)
 * 1. `output` MUST be `{ schema, render, presentationMeta? }`. `render` is
 *    REQUIRED — omitting it throws inside `ToolRuntime.register()` and takes
 *    the whole gateway down at boot. `defineTool()` does not check this, so
 *    `bin/preflight.mjs` mirrors that check before you restart anything.
 * 2. Do NOT depend on `@deepseek-ai/*` from a public registry: mirrors may
 *    publish an older version, and a second copy of `dsh-tools` breaks tool
 *    registration (duplicate service instance). Resolve the host's own copy.
 * 3. A plugin must not write user files with `node:fs`: that would bypass the
 *    host's filesystem policy. Downloads go to a private cache under
 *    `os.tmpdir()` only.
 * 4. A truncated PDF must fail loudly. Half-downloaded files otherwise parse
 *    into silent garbage — strictly worse than an error.
 *
 * @module dsh-tool-pdf
 */

import { readFile, stat, mkdir, open, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

export const name = 'tool-pdf';
export const inject = ['tools'];

/* --------------------------------------------------------------- defaults */

/** Every tunable; `apply(ctx, config)` may override any of them. */
export const DEFAULTS = Object.freeze({
  /** Private cache for `pdf_fetch`. Never the workspace. */
  cacheDir: path.join(os.tmpdir(), 'dsh-pdf-cache'),
  /** Refuse to read anything bigger (bytes). */
  maxPdfBytes: 256 * 1024 * 1024,
  /** Cap on returned text when the caller omits `maxChars`. */
  defaultMaxChars: 200_000,
  /** `pdf_fetch`: total attempts (each resumes from the byte offset). */
  fetchAttempts: 4,
  /** `pdf_fetch`: per-attempt timeout (ms). */
  fetchPerAttemptTimeoutMs: 90_000,
});

const PDF_MAGIC = Buffer.from('%PDF-');
const EOF_MARK = '%%EOF';

/**
 * Validate and merge user config, so a typo in `cordis.patch.yml` fails at the
 * row instead of halfway through a download.
 * @param {Record<string, unknown> | undefined} raw
 */
export function resolveConfig(raw) {
  const cfg = { ...DEFAULTS };
  if (raw === undefined || raw === null) return cfg;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('dsh-tool-pdf: config must be an object');
  }
  for (const key of Object.keys(raw)) {
    if (!(key in DEFAULTS)) {
      throw new TypeError(`dsh-tool-pdf: unknown config key "${key}" (known: ${Object.keys(DEFAULTS).join(', ')})`);
    }
  }
  const num = (key, integer = false) => {
    const v = raw[key];
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || (integer && !Number.isInteger(v))) {
      throw new TypeError(`dsh-tool-pdf: config.${key} must be ${integer ? 'an integer' : 'a number'} >= 1`);
    }
    cfg[key] = v;
  };
  if (raw.cacheDir !== undefined) {
    if (typeof raw.cacheDir !== 'string' || raw.cacheDir.length === 0) {
      throw new TypeError('dsh-tool-pdf: config.cacheDir must be a non-empty string');
    }
    cfg.cacheDir = path.resolve(raw.cacheDir);
  }
  num('maxPdfBytes', true);
  num('defaultMaxChars', true);
  num('fetchAttempts', true);
  num('fetchPerAttemptTimeoutMs', true);
  return cfg;
}

/* ------------------------------------------------------------------ pages */

/**
 * Parse a page expression: `"1-5"`, `"3"`, `"1,4-6"`, `"all"`/undefined.
 * @param {string|undefined} spec
 * @param {number} pageCount
 * @returns {number[]} unique ascending 1-based page numbers
 */
export function parsePages(spec, pageCount) {
  if (!spec || /^\s*(all|\*)\s*$/i.test(spec)) {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }
  const out = new Set();
  for (const part of spec.split(',')) {
    const t = part.trim();
    if (!t) continue;
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(t);
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      for (let p = Math.max(1, Math.min(a, b)); p <= Math.min(pageCount, Math.max(a, b)); p++) out.add(p);
    } else if (/^\d+$/.test(t)) {
      const p = Number(t);
      if (p >= 1 && p <= pageCount) out.add(p);
    } else {
      throw new Error(`PDF_BAD_PAGES: 无法解析页码表达式 ${JSON.stringify(t)}（示例: "1-5"、"3"、"1,4-6"、"all"）`);
    }
  }
  if (out.size === 0) {
    throw new Error(`PDF_BAD_PAGES: 页码表达式 ${JSON.stringify(spec)} 在 1..${pageCount} 内无匹配页`);
  }
  return [...out].sort((x, y) => x - y);
}

/* ------------------------------------------------------------------ pdfjs */

let pdfjsCache = null;

/** Import pdfjs once, resolving `standard_fonts` for the installed copy. */
async function loadPdfjs() {
  if (pdfjsCache) return pdfjsCache;
  const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let standardFontDataUrl;
  try {
    const root = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
    standardFontDataUrl = path.join(root, 'standard_fonts') + path.sep;
  } catch { /* optional: extraction still works, some fonts warn */ }
  pdfjsCache = { mod, standardFontDataUrl };
  return pdfjsCache;
}

/* ---------------------------------------------------------------- extract */

/**
 * Extract text from a PDF (CID / ToUnicode / ObjStm handled by pdfjs).
 * @param {string} filePath absolute or relative to the process cwd
 * @param {{pages?: string, maxChars?: number, maxPdfBytes?: number}} [opts]
 * @returns {Promise<{pageCount:number, pagesExtracted:number[], chars:number, truncated:boolean, text:string}>}
 */
export async function extractPdf(filePath, opts = {}) {
  const abs = path.resolve(filePath);
  const maxPdfBytes = opts.maxPdfBytes ?? DEFAULTS.maxPdfBytes;

  let st;
  try {
    st = await stat(abs);
  } catch {
    throw new Error(`PDF_NOT_FOUND: ${abs}`);
  }
  if (!st.isFile()) throw new Error(`PDF_NOT_A_FILE: ${abs}`);
  if (st.size < 5) throw new Error(`PDF_TOO_SMALL: ${st.size} bytes`);
  if (st.size > maxPdfBytes) throw new Error(`PDF_TOO_LARGE: ${st.size} bytes > ${maxPdfBytes}`);

  const buf = await readFile(abs);
  if (!buf.subarray(0, 5).equals(PDF_MAGIC)) {
    throw new Error(`PDF_BAD_MAGIC: 文件头不是 %PDF-（前 8 字节: ${JSON.stringify(buf.subarray(0, 8).toString('latin1'))}）`);
  }
  // Truncation check first: pdfjs raises an opaque internal exception on a
  // half-downloaded file, and some scrapers emit garbage instead of failing.
  if (!buf.subarray(-8192).includes(EOF_MARK)) {
    throw new Error(
      `PDF_TRUNCATED: 未找到 ${EOF_MARK} 标记（文件 ${buf.length} 字节），很可能下载不完整——`
      + '请用 pdf_fetch 带断点续传重新获取，不要把这个半截文件当有效 PDF 解析。',
    );
  }

  const { mod, standardFontDataUrl } = await loadPdfjs();
  const doc = await mod.getDocument({
    data: new Uint8Array(buf),
    verbosity: 0,
    useSystemFonts: false,
    disableFontFace: true,
    ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
  }).promise;

  const pageCount = doc.numPages;
  const wanted = parsePages(opts.pages, pageCount);
  const maxChars = opts.maxChars ?? DEFAULTS.defaultMaxChars;

  const chunks = [];
  let chars = 0;
  let truncated = false;

  for (const p of wanted) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    let s = '';
    let prevY = null;
    for (const item of tc.items) {
      if (typeof item.str !== 'string') continue;
      // pdfjs drops inter-run gaps; restore one space for words split across
      // runs on the same text line.
      const y = Array.isArray(item.transform) ? item.transform[5] : null;
      if (prevY !== null && y !== null && Math.abs(y - prevY) > 1 && s && !/\s$/.test(s)) s += ' ';
      prevY = y;
      s += item.str;
      if (item.hasEOL) { s += '\n'; prevY = null; }
    }
    if (chars + s.length > maxChars) {
      s = s.slice(0, Math.max(0, maxChars - chars));
      truncated = true;
    }
    chunks.push(s);
    chars += s.length;
    if (truncated) break;
  }

  const cleanup = doc.cleanup?.bind(doc) ?? doc.destroy?.bind(doc);
  if (cleanup) { try { await cleanup(); } catch { /* best effort */ } }

  return { pageCount, pagesExtracted: wanted, chars, truncated, text: chunks.join('\n\n') };
}

/* ------------------------------------------------------------------ fetch */

/** True when `p` looks like a complete PDF (size floor + trailing %%EOF). */
async function looksComplete(p) {
  try {
    const fh = await open(p, 'r');
    try {
      const { size } = await fh.stat();
      // Only reject files too small to hold a header + trailer. A tiny but
      // valid PDF (e.g. a 635-byte generated fixture) must not be mistaken for
      // a truncated download — the %%EOF marker is the real integrity signal.
      if (size < 64) return false;
      const tailLen = Math.min(4096, size);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, size - tailLen);
      return tail.includes(EOF_MARK);
    } finally {
      await fh.close();
    }
  } catch { return false; }
}

/**
 * Download a PDF with resume, retries, and an integrity check. Writes only into
 * `cacheDir` (default: a private dir under the OS temp root).
 * @param {string} url
 * @param {{force?: boolean, attempts?: number, perAttemptTimeoutMs?: number, cacheDir?: string}} [opts]
 * @returns {Promise<{path:string, bytes:number, attempts:number, complete:boolean, cached:boolean, error?:string}>}
 */
export async function fetchPdf(url, opts = {}) {
  const cacheDir = opts.cacheDir ?? DEFAULTS.cacheDir;
  const attempts = opts.attempts ?? DEFAULTS.fetchAttempts;
  const perAttemptTimeoutMs = opts.perAttemptTimeoutMs ?? DEFAULTS.fetchPerAttemptTimeoutMs;

  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`PDF_BAD_URL: ${url}`); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`PDF_BAD_URL: 仅支持 http/https，收到 ${parsed.protocol}`);

  await mkdir(cacheDir, { recursive: true });
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 16);
  const last = parsed.pathname.split('/').pop()?.replace(/[^\w.\-]+/g, '_') || 'doc';
  const target = path.join(cacheDir, `${hash}-${last.endsWith('.pdf') ? last : `${last}.pdf`}`);
  const partial = `${target}.part`;

  if (!opts.force && (await looksComplete(target))) {
    const { size } = await stat(target);
    return { path: target, bytes: size, attempts: 0, complete: true, cached: true };
  }

  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    let have = 0;
    try { have = (await stat(partial)).size; } catch { have = 0; }
    const headers = have > 0 ? { Range: `bytes=${have}-` } : {};
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), perAttemptTimeoutMs);
    try {
      const res = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
      if (!res.ok && res.status !== 206) throw new Error(`HTTP_${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      // Append only when the server honored the Range request.
      const append = have > 0 && res.status === 206;
      const fh = await open(partial, append ? 'a' : 'w');
      try { await fh.write(body); } finally { await fh.close(); }
      if (await looksComplete(partial)) {
        await rename(partial, target);
        const { size } = await stat(target);
        return { path: target, bytes: size, attempts: i, complete: true, cached: false };
      }
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }

  let got = 0;
  try { got = (await stat(partial)).size; } catch { /* none */ }
  return {
    path: partial,
    bytes: got,
    attempts,
    complete: false,
    cached: false,
    error: lastErr ? String(lastErr.message ?? lastErr) : 'INCOMPLETE',
  };
}

/* ------------------------------------------------------- schema compiling */

/**
 * Compile a `ParameterSchemaSpec` (our authoring subset) into an object-rooted
 * JSON Schema. Mirrors what the host's `defineTool()` does for `parameters`,
 * so the plugin keeps working even when no host runtime can be resolved.
 * Supported per-property keys: type / required / description / items /
 * properties / enum / additionalProperties.
 * @param {Record<string, any>} spec
 */
export function compileParameters(spec = {}) {
  return compileValueSpec({ type: 'object', properties: spec });
}

/**
 * Compile one authoring value node into raw JSON Schema.
 * `required: true` lives on the property node in the authoring form and turns
 * into the parent object's `required: [...]` array.
 * @param {Record<string, any>} node
 */
export function compileValueSpec(node) {
  if (node === null || typeof node !== 'object') {
    throw new TypeError('dsh-tool-pdf: schema node must be an object');
  }
  const { required: _drop, ...rest } = node;

  if (rest.type === 'array') {
    if (!rest.items || typeof rest.items !== 'object') {
      throw new TypeError('dsh-tool-pdf: array schema needs items');
    }
    return { ...rest, items: compileValueSpec(rest.items) };
  }

  if (rest.type === 'object' || rest.properties) {
    const properties = {};
    const required = [];
    for (const [key, child] of Object.entries(rest.properties ?? {})) {
      if (child === null || typeof child !== 'object') {
        throw new TypeError(`dsh-tool-pdf: property "${key}" must be a schema object`);
      }
      if (child.required === true) required.push(key);
      properties[key] = compileValueSpec(child);
    }
    // NOTE: do NOT default `additionalProperties`. The host treats a parameter
    // root as an implicit open object; forcing `false` here would make the
    // fallback compiler stricter than the host and reject extra arguments.
    const out = { ...rest, properties };
    if (required.length) out.required = required;
    else delete out.required;
    return out;
  }

  return rest;
}

/* ------------------------------------------------------------------ tools */

/**
 * Raw tool specs, before `defineTool()` compiles `parameters` into JSON Schema.
 * Exported so tests can validate the authoring shape directly.
 */
export const toolSpecs = [
  {
    name: 'pdf_extract',
    description:
      '抽取 PDF 的正文文本（支持子集化 CID 字体 / ToUnicode CMap / 压缩对象流，'
      + '这正是 CVPR-CVF 与部分 IEEE 论文 PDF 的编码方式，普通正则抽取会得到乱码或空文本）。'
      + '只读文件，不修改。用于读论文：先确认 pageCount，再按需指定 pages 分批读。',
    parameters: {
      path: { type: 'string', required: true, description: 'PDF 路径（绝对路径，或相对当前工作区）。' },
      pages: { type: 'string', description: '页码表达式，如 "1-5"、"3"、"1,4-6"，省略或 "all" 表示全部。' },
      maxChars: { type: 'number', description: '返回字符上限，默认 200000；超出则截断并置 truncated。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageCount: { type: 'number', required: true },
          pagesExtracted: { type: 'array', required: true, items: { type: 'number' } },
          chars: { type: 'number', required: true },
          truncated: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      // REQUIRED by the host: `ToolRuntime.register()` rejects an output
      // without `render`, which takes the whole gateway down at boot.
      render(args, value) {
        const file = path.basename(String(args.path));
        const head = `PDF ${file} — 共 ${value.pageCount} 页；本次抽取 ${value.pagesExtracted.length} 页`
          + `（${value.pagesExtracted.join(',')}），${value.chars} 字符`
          + (value.truncated ? '，已按 maxChars 截断' : '');
        return [{ type: 'text', text: `${head}\n\n${value.text}` }];
      },
    },
    /** @param {{path:string, pages?:string, maxChars?:number}} args */
    async execute(args) {
      return extractPdf(args.path, { pages: args.pages, maxChars: args.maxChars });
    },
    presentCall(args) {
      return { card: 'generic', title: `Extract PDF: ${path.basename(String(args.path))}`, kind: 'other', rawInput: args };
    },
  },
  {
    name: 'pdf_fetch',
    description:
      '下载 PDF 到本机缓存（带断点续传、重试、%%EOF 完整性校验）。'
      + '用于 CVF/IEEE 这类大文件慢速源：半截文件会被判为 incomplete 而不是当成有效 PDF。'
      + '只写入系统临时目录下的私有缓存，不写工作区。',
    parameters: {
      url: { type: 'string', required: true, description: 'PDF 的 URL（http/https）。' },
      force: { type: 'boolean', description: '忽略已缓存的完整文件，强制重新下载。' },
      perAttemptTimeoutMs: { type: 'number', description: '单次尝试超时毫秒，默认 90000。' },
      attempts: { type: 'number', description: '最大尝试次数，默认 4（每次从断点续传）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
          attempts: { type: 'number', required: true },
          complete: { type: 'boolean', required: true },
          cached: { type: 'boolean', required: true },
          error: { type: 'string' },
        },
      },
      render(args, value) {
        const text = value.complete
          ? `✅ 下载完成：${value.bytes} 字节（尝试 ${value.attempts} 次${value.cached ? '，命中缓存' : ''}）\n路径: ${value.path}`
          : `⚠️ 下载不完整：${value.bytes} 字节（尝试 ${value.attempts} 次）`
            + `${value.error ? `，原因: ${value.error}` : ''}\n半截文件: ${value.path}\n请重试或换源；不要把它当有效 PDF 解析。`;
        return [{ type: 'text', text }];
      },
    },
    /** @param {{url:string, force?:boolean, perAttemptTimeoutMs?:number, attempts?:number}} args */
    async execute(args) {
      return fetchPdf(args.url, {
        force: args.force,
        perAttemptTimeoutMs: args.perAttemptTimeoutMs,
        attempts: args.attempts,
      });
    },
    presentCall(args) {
      return { card: 'generic', title: `Fetch PDF: ${String(args.url).slice(0, 60)}`, kind: 'other', rawInput: args };
    },
  },
];

/**
 * Resolve the host's own `@deepseek-ai/dsh-tools` so definitions get the same
 * build-time treatment as first-party tools, without installing a second copy
 * (a duplicate service instance breaks registration).
 * @param {string} [profileDir]
 */
async function resolveDefineTool(profileDir) {
  const anchors = [
    profileDir && path.join(profileDir, 'package.json'),
    process.env.DSH_PROFILE_DIR && path.join(process.env.DSH_PROFILE_DIR, 'package.json'),
    path.resolve(process.cwd(), 'package.json'),
  ].filter(Boolean);
  for (const anchor of anchors) {
    try {
      const entry = createRequire(anchor).resolve('@deepseek-ai/dsh-tools');
      const mod = await import(pathToFileURL(entry).href);
      if (typeof mod.defineTool === 'function') return mod.defineTool;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Cordis plugin entry.
 * @param {{tools: {register: (def: unknown) => () => void}}} ctx
 * @param {Record<string, unknown>} [config] see {@link DEFAULTS}
 */
export async function apply(ctx, config) {
  resolveConfig(config); // fail fast on bad config, even before any tool call
  const defineTool = await resolveDefineTool();
  const wrap = defineTool ?? ((spec) => ({
    ...spec,
    parameters: compileParameters(spec.parameters),
    output: { ...spec.output, schema: compileValueSpec(spec.output.schema) },
  }));
  for (const spec of toolSpecs) ctx.tools.register(wrap(spec));
}
