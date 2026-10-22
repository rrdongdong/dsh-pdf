/**
 * 自检：不依赖 DSH 运行时，直接验证插件核心逻辑。
 * 用法：node bin/selftest.mjs <pdf> [pages]
 */
import { extractPdf, fetchPdf } from '../lib/index.js';
import { writeFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const pdf = process.argv[2];
const pages = process.argv[3];
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)); };

console.log('[1] CID 字体 PDF 正文抽取');
const r = await extractPdf(pdf, { pages, maxChars: 4000 });
console.log(`    pages=${r.pageCount} extracted=${r.pagesExtracted.length} chars=${r.chars} truncated=${r.truncated}`);
const printable = [...r.text].filter((c) => c === '\n' || (c >= ' ' && c <= '~')).length;
const ratio = printable / Math.max(1, r.text.length);
console.log(`    可打印比=${(ratio * 100).toFixed(1)}%`);
console.log('    --- 首 200 字 ---');
console.log('    ' + r.text.slice(0, 200).replace(/\n/g, ' ⏎ '));
ok(r.chars > 500, '抽出足够文本（>500 字符）');
ok(ratio > 0.9, '可打印字符占比 > 90%（排除乱码）');
ok(/[A-Za-z]{3,}/.test(r.text), '含连续英文单词（排除字形码乱码）');

console.log('[2] 错误处理');
try { await extractPdf('/nonexistent/x.pdf'); ok(false, '不存在的文件应报错'); }
catch (e) { ok(/PDF_NOT_FOUND/.test(String(e.message)), '缺失文件 → PDF_NOT_FOUND'); }
const tmp = await mkdtemp(path.join(os.tmpdir(), 'pdfbad-'));
const bogus = path.join(tmp, 'x.pdf');
await writeFile(bogus, 'not a pdf at all');
try { await extractPdf(bogus); ok(false, '非 PDF 应报错'); }
catch (e) { ok(/PDF_BAD_MAGIC/.test(String(e.message)), '非 PDF → PDF_BAD_MAGIC'); }

console.log('[3] 下载器完整性校验');
const got = await fetchPdf('http://127.0.0.1:1/nope.pdf', { attempts: 1, perAttemptTimeoutMs: 1500 });
ok(got.complete === false, '不可达 URL → complete=false（不把半截文件当好文件）');
ok(typeof got.path === 'string', '返回临时路径');

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
