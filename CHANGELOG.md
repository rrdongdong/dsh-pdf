# Changelog

## 0.3.0 — 2026-10-22

### Changed
- **Requires Node ≥ 22.13.** `pdfjs-dist@6` needs `Promise.withResolvers`, which Node 20 lacks.
  CI now runs Node 22/24 instead of 20/22 (the failing cell was a test-matrix bug, not a code bug).
  `engines.node` was declared loosely before, so `npm` never warned.

### Added
- `assertRuntimeSupported()` — raises a named `NODE_TOO_OLD` error at plugin load on an unsupported
  runtime, instead of a cryptic failure deep inside pdfjs. Called from both `apply()` and
  `loadPdfjs()`; injectable `versions` argument for tests. Covered by two unit tests.
- `bin/preflight.mjs` is now **host-optional**: when no DSH runtime is resolvable (CI, plain clone)
  the host-mirroring stages are *skipped* rather than crashing, and offline equivalents run instead.

### Fixed
- `package-lock.json` regenerated against `registry.npmjs.org`; it had been generated on a host
  pointing at an internal mirror, so CI failed with `ENOTFOUND` before running a single test.

## 0.2.1 — 2026-10-21

### Fixed
- **Small valid PDFs were reported as incomplete.** `fetchPdf()` treated any body
  under 1024 bytes as a failed download, so a legitimate 635-byte PDF ended up as
  `complete: false` with the file left as `.part`. Found by dogfooding the plugin
  against its own fixture. The size floor is now 64 bytes; `%%EOF` remains the
  real integrity signal.

### Added
- Four download-path tests against a throwaway local `node:http` server: small-PDF
  completion, cache hit, missing-trailer body stays `.part`, and Range resume from
  a pre-seeded partial file.

## 0.2.0 — 2026-10-21

Packaging for release after the first real deployment.

### Added
- `config` support (validated eagerly): `cacheDir`, `maxPdfBytes`, `defaultMaxChars`,
  `fetchAttempts`, `fetchPerAttemptTimeoutMs`. Unknown keys and wrong types throw at the plugin row.
- `bin/preflight.mjs`: mirrors `ToolRuntime.register()`'s checks **before** a host restart, plus a
  host-parity stage comparing the local schema compiler against `defineTool()`.
- `compileValueSpec` / `compileParameters`: local authoring-spec → JSON Schema compiler, used only
  when the host's `dsh-tools` cannot be resolved.
- Unit tests (19) covering config, page expressions, schema compilation, the boot-fatal
  `output.render` contract, error codes, and download failure semantics.
- English README, LICENSE (MIT), CI workflow, upstream issue draft.

### Fixed
- **Boot-fatal:** `output.render` is required by `ToolRuntime.register()`. It was missing, which
  aborted the whole gateway during plugin-tree load — the reverse proxy still listened, so it looked
  like a network fault.
- `pdf_fetch` output schema now declares `error`, so a failed download no longer violates
  `additionalProperties: false`.
- Resolving `@deepseek-ai/dsh-tools`: never from a public registry (mirrors may serve an older
  version, and a duplicate instance breaks registration); resolve the host's copy, fall back to the
  local compiler.
- Fallback compiler no longer sets `additionalProperties: false` on a parameter root: the host treats
  it as an implicitly open object, and the mismatch silently rejected extra arguments.

## 0.1.0 — 2026-10-21

First version: `pdf_extract` (pdfjs-based, handles subsetted CID fonts, ToUnicode CMaps and
`/ObjStm`) and `pdf_fetch` (Range resume, retries, `%%EOF` verification), plus a truncation check
that fails loudly instead of returning mojibake.
