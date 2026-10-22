/**
 * 起飞前验证（不启动服务、不碰线上进程）。
 *
 * 逐行镜像 dsh-tools@rc.7 的 ToolRuntime.register() 校验：
 *   1) output 必须是 { schema, render, presentationMeta? }
 *   2) assertSupportedJsonSchema(output.schema)
 *   3) timeoutMs 若声明必须是正有限数
 *   4) 工具名不能是保留的 run_code
 * 并额外验证：参数 spec 可转 JSON Schema、render 返回合法 ContentBlock[]、execute 真能跑。
 *
 * 用法: node bin/preflight.mjs [样张.pdf]
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE = process.env.DSH_PROFILE_DIR || path.join(DSH_HOME, 'profiles', 'web');
const req = createRequire(`${PROFILE}/package.json`);
const load = (spec) => import(pathToFileURL(req.resolve(spec)).href);

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => {
  c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}${extra ? ' — ' + extra : ''}`));
};

const tools = await load('@deepseek-ai/dsh-tools');
const plugin = await import(new URL('../lib/index.js', import.meta.url).href);

const defs = [];
const mockCtx = { tools: { register: (d) => { defs.push(d); return () => {}; } } };
await plugin.apply(mockCtx);
ok(defs.length === 2, `apply() 注册了 ${defs.length} 个工具`);

const rawSpecByName = new Map(plugin.toolSpecs.map((x) => [x.name, x]));
console.log('[1] 镜像 register() 的 output 契约校验');
for (const def of defs) {
  const { name, output } = def;
  const badOutput = output === undefined || typeof output !== 'object'
    || typeof output.render !== 'function'
    || (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function');
  ok(!badOutput, `${name}: output { schema, render, presentationMeta? } 合规`,
     badOutput ? 'rc.7 会抛 must declare output { schema, render, presentationMeta? }' : '');
  if (!badOutput) {
    try { tools.assertSupportedJsonSchema(output.schema); ok(true, `${name}: output.schema 通过 assertSupportedJsonSchema（注册期视图）`); }
    catch (e) { ok(false, `${name}: output.schema 被拒`, e.message); }
    // 作者态 spec 必须能编译成合法 JSON Schema（defineTool 的职责，这里独立复核）
    try {
      const compiledByUs = plugin.compileValueSpec(rawSpecByName.get(name).output.schema);
      tools.assertSupportedJsonSchema(compiledByUs);
      ok(true, `${name}: 作者态 output.schema 可编译（本地编译器）`);
    } catch (e) { ok(false, `${name}: 作者态 output.schema 编译失败`, e.message); }
  }
  if (def.timeoutMs !== undefined) {
    ok(Number.isFinite(def.timeoutMs) && def.timeoutMs > 0, `${name}: timeoutMs 合法`);
  }
  ok(name !== 'run_code', `${name}: 未占用保留名 run_code`);
}

console.log('[2] 参数 schema（raw spec → JSON Schema；编译后 definition 复核）');
for (const raw of plugin.toolSpecs) {
  try {
    const js = tools.parameterSchemaSpecToJsonSchema(raw.parameters ?? {});
    tools.assertObjectJsonSchema(js);
    ok(true, `${raw.name}: raw spec 可编译为 object schema（必填: ${(js.required ?? []).join(',') || '无'}）`);
  } catch (e) { ok(false, `${raw.name}: raw spec 非法`, e.message); }
  const compiled = defs.find((d) => d.name === raw.name);
  if (compiled) {
    try {
      tools.assertObjectJsonSchema(compiled.parameters);
      tools.assertSupportedJsonSchema(compiled.parameters);
      ok(true, `${raw.name}: defineTool 编译后的参数 schema 合规`);
    } catch (e) { ok(false, `${raw.name}: 编译后参数 schema 被拒`, e.message); }
  }
}

console.log('[3] render 返回合法 ContentBlock[]');
for (const def of defs) {
  const blocks = def.output.render({ path: '/tmp/x.pdf', url: 'http://x' }, {
    pageCount: 1, pagesExtracted: [1], chars: 3, truncated: false, text: 'abc',
    path: '/tmp/x.pdf', bytes: 10, attempts: 1, complete: true, cached: false,
  });
  ok(Array.isArray(blocks) && blocks.length > 0 && blocks.every((b) => b?.type === 'text' && typeof b.text === 'string'),
     `${def.name}: render → ContentBlock[]`);
}

console.log('[5] 回退编译器与 host defineTool 的一致性（关键：回退路径不能更宽松/更严格）');
{
  const hostDefine = await (async () => {
    const anchors = [`${PROFILE}/package.json`];
    for (const a of anchors) {
      try {
        const e = req.resolve('@deepseek-ai/dsh-tools');
        const mod = await import(pathToFileURL(e).href);
        if (typeof mod.defineTool === 'function') return mod.defineTool;
      } catch { /* ignore */ }
    }
    return null;
  })();
  if (!hostDefine) {
    console.log('  – 无法解析 host defineTool，跳过一致性比较（回退路径已由 [1][2] 独立校验）');
  } else {
    for (const raw of plugin.toolSpecs) {
      // structuredClone 不能克隆函数：指向同一函数的浅拷贝即可
      const hostDef = hostDefine({ ...raw, output: { ...raw.output } });
      const ours = {
        parameters: plugin.compileParameters(raw.parameters),
        outputSchema: plugin.compileValueSpec(raw.output.schema),
      };
      const sameParams = JSON.stringify(hostDef.parameters) === JSON.stringify(ours.parameters);
      const sameOutput = JSON.stringify(hostDef.output.schema) === JSON.stringify(ours.outputSchema);
      ok(sameParams, `${raw.name}: 参数编译与 host 一致`);
      ok(sameOutput, `${raw.name}: output.schema 编译与 host 一致`);
      if (!sameParams) console.log('    host:', JSON.stringify(hostDef.parameters), '\n    ours:', JSON.stringify(ours.parameters));
      if (!sameOutput) console.log('    host:', JSON.stringify(hostDef.output.schema), '\n    ours:', JSON.stringify(ours.outputSchema));
    }
  }
}

if (process.argv[2]) {
  console.log(`[4] 端到端（真实 PDF: ${process.argv[2]}）`);
  const sample = process.argv[2];
  try {
    const r = await plugin.extractPdf(sample, { pages: '1', maxChars: 200 });
    ok(r.chars > 20, `extract 成功：${r.pageCount} 页 / ${r.chars} 字符`);
    const rendered = defs.find((d) => d.name === 'pdf_extract').output.render({ path: sample }, r);
    ok(rendered[0].text.length > 20, 'render 输出非空');
  } catch (e) { ok(false, 'extract 失败', e.message); }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
