# Third-party notices

This package contains **no vendored third-party source code**. Dependencies are installed by npm and
remain under their own licenses.

## Runtime dependency

| Package | Version | License | Project |
|---|---|---|---|
| `pdfjs-dist` | 6.4.299 (pinned) | **Apache-2.0** | [mozilla/pdf.js](https://github.com/mozilla/pdf.js) |

`pdfjs-dist` is used as a library: `import('pdfjs-dist/legacy/build/pdf.mjs')`. Its source is not
copied into this repository, and its Apache-2.0 notice is retained in the installed package
(`node_modules/pdfjs-dist/LICENSE`).

Apache-2.0 obligations apply if you **redistribute a bundle** that inlines pdf.js: include its
`LICENSE` and state any modifications. Installing this package from npm does not bundle it.

## Referenced, not copied

`bin/preflight.mjs` reproduces the *behaviour* of the registration-time validation in
`@deepseek-ai/dsh-tools` (MIT, part of [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness))
— the same assertion that `ToolRuntime.register()` performs. The implementation here is independent
(local schema compiler plus a parity check); no upstream source was copied. The upstream license is
MIT, so any future divergence in licensing would not restrict this notice.

## Fixtures

`fixtures/sample.pdf` is generated programmatically by this project (`%PDF-1.4`, one page, Helvetica,
two lines of text) and contains no third-party content. It exists solely so CI can run the
end-to-end extraction stage without network access.
