/**
 * Pre-flight: mirror the host's registration-time checks **before** restarting it.
 *
 * Runs in two modes:
 *   • **host present** — loads the host's own `@deepseek-ai/dsh-tools` (resolved from
 *     `DSH_PROFILE_DIR` / `$DSH_HOME/profiles/web`) and mirrors `ToolRuntime.register()`
 *     exactly, including a parity check between our local schema compiler and the
 *     host's `defineTool()`.
 *   • **host absent** (CI, plain `git clone`) — validates the same contracts with the
 *     bundled compiler plus structural checks, and *skips* (never fails) the stages
 *     that need the host. This is the mode GitHub Actions runs in.
 *
 * Usage: node bin/preflight.mjs [sample.pdf]
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE = process.env.DSH_PROFILE_DIR || path.join(DSH_HOME, 'profiles', 'web');
const req = createRequire(path.join(PROFILE, 'package.json'));

let pass = 0;
let fail = 0;
let skipped = 0;
const ok = (c, m, extra = '') => {
  if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}${extra ? ` — ${extra}` : ''}`); }
};
const skip = (m) => { skipped++; console.log(`  – ${m}（跳过：本机无 DSH 宿主）`); };

/* ------------------------------------------------------------ host runtime */

/** @returns {Promise<{tools: any, defineTool: Function|null}|null>} */
async function loadHost() {
  try {
    const entry = req.resolve('@deepseek-ai/dsh-tools');
    const mod = await import(pathToFileURL(entry).href);
    return { tools: mod, defineTool: typeof mod.defineTool === 'function' ? mod.defineTool : null };
  } catch {
    return null;
  }
}

const host = await loadHost();
if (host) console.log(`[i] 宿主: ${PROFILE}（完整校验 + host 一致性比对）`);
else console.log('[i] 未检测到 DSH 宿主（CI / 纯 clone 环境）：只做可离线校验，依赖宿主的阶段跳过');

const plugin = await import(new URL('../lib/index.js', import.meta.url).href);

/* ------------------------------------------------------------------ stage 0 */

const defs = [];
const mockCtx = { tools: { register: (d) => { defs.push(d); return () => {}; } } };
await plugin.apply(mockCtx);
ok(defs.length === 2, `apply() 注册了 ${defs.length} 个工具`);

const rawSpecByName = new Map(plugin.toolSpecs.map((x) => [x.name, x]));

/* ------------------------------------------------------------------ stage 1 */

console.log('[1] output 契约：{ schema, render, presentationMeta? }');
for (const def of defs) {
  const { name, output } = def;
  const badOutput = output === undefined || typeof output !== 'object'
    || typeof output.render !== 'function'
    || (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function');
  ok(!badOutput, `${name}: output { schema, render, presentationMeta? } 合规`,
    badOutput ? 'rc.7 会抛 must declare output { schema, render, presentationMeta? }' : '');
  if (badOutput) continue;

  if (host) {
    try { host.tools.assertSupportedJsonSchema(output.schema); ok(true, `${name}: output.schema 通过 assertSupportedJsonSchema（注册期视图）`); }
    catch (e) { ok(false, `${name}: output.schema 被拒`, e.message); }
  } else {
    // Offline equivalent: object root, object `properties`, string[] `required`.
    const s = output.schema;
    const structurallyOk = s?.type === 'object' && typeof s.properties === 'object'
      && (!s.required || (Array.isArray(s.required) && s.required.every((k) => typeof k === 'string')));
    ok(structurallyOk, `${name}: output.schema 结构合法（离线校验）`);
    ok(!Object.values(s?.properties ?? {}).some((p) => p && typeof p === 'object' && 'required' in p),
      `${name}: 编译后不应残留属性级 required`);
  }

  try {
    plugin.compileValueSpec(rawSpecByName.get(name).output.schema);
    ok(true, `${name}: 作者态 output.schema 可编译（本地编译器）`);
  } catch (e) { ok(false, `${name}: 作者态 output.schema 编译失败`, e.message); }

  if (def.timeoutMs !== undefined) ok(Number.isFinite(def.timeoutMs) && def.timeoutMs > 0, `${name}: timeoutMs 合法`);
  ok(name !== 'run_code', `${name}: 未占用保留名 run_code`);
}

/* ------------------------------------------------------------------ stage 2 */

console.log('[2] 参数 schema（作者态编译 / 编译后复核）');
for (const raw of plugin.toolSpecs) {
  try {
    const compiled = plugin.compileParameters(raw.parameters ?? {});
    const okShape = compiled.type === 'object' && typeof compiled.properties === 'object';
    ok(okShape, `${raw.name}: 参数可编译为 object schema（必填: ${(compiled.required ?? []).join(',') || '无'}）`);
    if (host) {
      let hostSchema;
      try { hostSchema = host.tools.parameterSchemaSpecToJsonSchema(raw.parameters ?? {}); } catch { /* ignore */ }
      if (hostSchema) ok(JSON.stringify(hostSchema) === JSON.stringify(compiled), `${raw.name}: 参数编译与 host 一致`);
      else skip(`${raw.name}: host 参数编译比对`);
    }
  } catch (e) { ok(false, `${raw.name}: 参数编译失败`, e.message); }

  const compiledDef = defs.find((d) => d.name === raw.name);
  if (compiledDef && host) {
    try {
      host.tools.assertObjectJsonSchema(compiledDef.parameters);
      host.tools.assertSupportedJsonSchema(compiledDef.parameters);
      ok(true, `${raw.name}: defineTool 编译后的参数 schema 合规`);
    } catch (e) { ok(false, `${raw.name}: 编译后参数 schema 被拒`, e.message); }
  }
}

/* ------------------------------------------------------------------ stage 3 */

console.log('[3] render 返回合法 ContentBlock[]');
for (const def of defs) {
  const blocks = def.output.render({ path: '/tmp/x.pdf', url: 'http://x' }, {
    pageCount: 1, pagesExtracted: [1], chars: 3, truncated: false, text: 'abc',
    path: '/tmp/x.pdf', bytes: 10, attempts: 1, complete: true, cached: false,
  });
  ok(Array.isArray(blocks) && blocks.length > 0 && blocks.every((b) => b?.type === 'text' && typeof b.text === 'string'),
    `${def.name}: render → ContentBlock[]`);
}

/* ------------------------------------------------------------------ stage 5 */

console.log('[5] 回退编译器与 host defineTool 的一致性');
if (!host?.defineTool) {
  skip('host defineTool 一致性比对');
} else {
  for (const raw of plugin.toolSpecs) {
    const hostDef = host.defineTool({ ...raw, output: { ...raw.output } });
    const oursParams = plugin.compileParameters(raw.parameters);
    const oursOutput = plugin.compileValueSpec(raw.output.schema);
    ok(JSON.stringify(hostDef.parameters) === JSON.stringify(oursParams), `${raw.name}: 参数编译与 host 一致`);
    ok(JSON.stringify(hostDef.output.schema) === JSON.stringify(oursOutput), `${raw.name}: output.schema 编译与 host 一致`);
  }
}

/* ------------------------------------------------------------------ stage 4 */

if (process.argv[2]) {
  console.log(`[4] 端到端（${path.basename(process.argv[2])}）`);
  try {
    const r = await plugin.extractPdf(process.argv[2], { pages: '1', maxChars: 200 });
    ok(r.chars > 20, `extract 成功：${r.pageCount} 页 / ${r.chars} 字符`);
    const rendered = defs.find((d) => d.name === 'pdf_extract').output.render({ path: process.argv[2] }, r);
    ok(rendered[0].text.length > 20, 'render 输出非空');
  } catch (e) { ok(false, 'extract 失败', e.message); }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败${skipped ? ` / ${skipped} 跳过` : ''}`);
process.exit(fail === 0 ? 0 : 1);
