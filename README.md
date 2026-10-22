# dsh-tool-pdf

[![CI](https://github.com/rrdongdong/dsh-tool-pdf/actions/workflows/ci.yml/badge.svg)](https://github.com/rrdongdong/dsh-tool-pdf/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Two [DSH](https://github.com/deepseek-ai/deepseek-harness) (Cordis) tools for reading papers:
**`pdf_fetch`** — resumable, integrity-checked download; **`pdf_extract`** — text extraction that
survives **subsetted CID fonts**, **ToUnicode CMaps**, and **compressed object streams (`/ObjStm`)**.

中文说明见 [README.zh.md](./README.zh.md).

---

## Why this exists

Most PDFs are fine. CVPR/CVF (and some IEEE) PDFs are not: their fonts are subsetted CID fonts, so a
glyph byte only means something after a `/ToUnicode` CMap lookup — and those font dictionaries are
themselves packed inside **compressed object streams**. A naive scraper therefore:

| Step | What a naive stream scraper does | Result |
|---|---|---|
| Look for font maps | `/ToUnicode` appears **0 times** in raw bytes (it lives inside `/ObjStm`) | no character mapping at all |
| Treat streams as text | 4 vector-figure streams of **12–14 MB** happen to contain `BT`/`Tj`-like tokens | ~50 MB of drawing commands parsed |
| Outcome | hangs, then emits garbage | "the paper has no text" — except it does |

`pdfjs-dist` handles both. Measured on an 11.2 MB CVPR 2026 paper: **86 ms to load**, 10,525
characters from the first 3 pages, 100 % printable.

### Measured before / after (same file)

| | naive scraper | this plugin |
|---|---|---|
| Download | 3 failures (timeout, truncated at 1.48 MB, SIGTERM) | **6.3 s, 1 attempt, 8.94 MB, `%%EOF` verified** |
| Extraction | font maps = 0; 100 s hang; 682 KB of mojibake | **13 pages, clean text** |
| On a truncated file | silent garbage | `PDF_TRUNCATED: 未找到 %%EOF 标记 …` |

---

## Install (DSH profile)

```bash
# 1) clone + deps
git clone <this repo> ~/.dsh/plugins/dsh-tool-pdf
cd ~/.dsh/plugins/dsh-tool-pdf && npm ci --omit=dev

# 2) make it resolvable from the profile — symlink, so npm never rewrites the profile tree
ln -sfn ~/.dsh/plugins/dsh-tool-pdf ~/.dsh/profiles/web/node_modules/dsh-tool-pdf

# 3) add one row to the profile patch (back it up first)
cp ~/.dsh/profiles/web/cordis.patch.yml ~/.dsh/profiles/web/cordis.patch.yml.bak
cat >> ~/.dsh/profiles/web/cordis.patch.yml <<'YAML'
- insert:
    - id: tool-pdf
      name: 'dsh-tool-pdf'
      # optional — all keys shown with their defaults:
      # config:
      #   cacheDir: /tmp/dsh-pdf-cache
      #   maxPdfBytes: 268435456
      #   defaultMaxChars: 200000
      #   fetchAttempts: 4
      #   fetchPerAttemptTimeoutMs: 90000
YAML

# 4) verify BEFORE restarting (see next section)
node bin/preflight.mjs
dsh --profile web --dump-config | grep -A2 'id: tool-pdf'

# 5) restart the host
```

### Never restart blind

`ToolRuntime.register()` rejects a definition whose `output` lacks `render`, and that throw happens
**while the plugin tree loads** — so the whole gateway fails to boot, not just this plugin.
`defineTool()` does not validate it, so the mistake stays invisible until the host is already down.

`bin/preflight.mjs` mirrors the registration-time checks **before** you touch a running host:

```
$ node bin/preflight.mjs path/to/paper.pdf
✓ apply() 注册了 2 个工具
[1] output { schema, render, presentationMeta? } / assertSupportedJsonSchema / author-spec compiles
[2] parameter schema compiles (and matches host compilation)
[3] render → ContentBlock[]
[5] fallback compiler output == host defineTool output   (both tools)
[4] end-to-end: extract + render on a real PDF
结果: 19 通过 / 0 失败
```

Step **[5]** is the important one. When the host's `dsh-tools` cannot be resolved, the plugin
compiles schemas itself; a fallback that is *stricter or looser* than the host silently changes
behaviour, so preflight asserts byte-for-byte equality with `defineTool()` whenever the host copy is
available. (Writing this check immediately caught a real divergence: the host treats a parameter root
as an implicit **open** object, while the first fallback emitted `additionalProperties: false`.)

---

## Tools

### `pdf_extract(path, pages?, maxChars?)`

| parameter | |
|---|---|
| `path` *(required)* | absolute, or relative to the process cwd |
| `pages` | `"1-5"`, `"3"`, `"1,4-6"`, or `"all"` (default) |
| `maxChars` | default `200000`; sets `truncated: true` when hit |
| returns | `{ pageCount, pagesExtracted[], chars, truncated, text }` |

Read-only. Fails fast with stable codes: `PDF_NOT_FOUND`, `PDF_NOT_A_FILE`, `PDF_TOO_SMALL`,
`PDF_TOO_LARGE`, `PDF_BAD_MAGIC`, `PDF_TRUNCATED`, `PDF_BAD_PAGES`.

### `pdf_fetch(url, force?, attempts?, perAttemptTimeoutMs?)`

Downloads into a **private cache under the OS temp root** with `Range` resume, retries, and a
`%%EOF` check. Returns `{ path, bytes, attempts, complete, cached, error? }`.

`complete: false` means **do not parse it**. A half-downloaded PDF is worse than a missing one: it
parses into plausible-looking garbage instead of failing.

---

## Config

Every key optional; validated eagerly, so a typo fails at the plugin row rather than mid-download.
Unknown keys are rejected.

| key | default | meaning |
|---|---|---|
| `cacheDir` | `os.tmpdir()/dsh-pdf-cache` | where `pdf_fetch` writes (resolved to absolute) |
| `maxPdfBytes` | `268435456` (256 MiB) | refuse to read larger files |
| `defaultMaxChars` | `200000` | text cap when the caller omits `maxChars` |
| `fetchAttempts` | `4` | total attempts (each resumes from the byte offset) |
| `fetchPerAttemptTimeoutMs` | `90000` | per-attempt timeout |

```yaml
- insert:
    - id: tool-pdf
      name: 'dsh-tool-pdf'
      config:
        cacheDir: /var/tmp/dsh-pdf-cache
        defaultMaxChars: 120000
```

---

## Design constraints (each learned by breaking something)

1. **Never depend on `@deepseek-ai/*` from a public registry.** Mirrors may carry an older version,
   and a second copy of `dsh-tools` means a duplicate service instance that breaks tool
   registration. This plugin resolves the host's own copy and falls back to a local, parity-tested
   compiler.
2. **A plugin must not write user files with `node:fs`.** That bypasses the host's filesystem policy.
   Downloads go to a private temp cache only; extraction is read-only.
3. **Truncation must fail loudly.** Silent garbage poisons every downstream consumer.
4. **`output.render` is mandatory** — and its absence is discovered only at boot, hence preflight.

---

## Tests

```bash
npm test           # unit: page regex, config validation, schema compile + host parity, error codes
npm run preflight  # registration-time mirror; pass a PDF path for the end-to-end stage
```

CI runs both on Node 20 and 22 with a small checked-in fixture.

---

## License

MIT — see [LICENSE](./LICENSE).

---

## See also

- [`docs/issue-draft.md`](./docs/issue-draft.md) — upstream proposal: make `defineTool()` validate
  `output.render`, so this failure mode stops taking hosts down.
