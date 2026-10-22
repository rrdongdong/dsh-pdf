# Proposal: validate `output.render` in `defineTool()`, not only at `ToolRuntime.register()`

**Area:** `@deepseek-ai/dsh-tools` (plugin authoring ergonomics)
**Version observed:** `@deepseek-ai/dsh-tools@0.1.0-rc.7`
**Severity:** high for plugin authors — the failure mode takes down the whole gateway, not the plugin

## Summary

`ToolDefinition.output` requires `render`. The requirement is enforced only inside
`ToolRuntime.register()`:

```js
// dsh-tools/lib/index.js (register)
if (output === void 0 || typeof output !== "object" || typeof output.render !== "function"
    || output.presentationMeta !== void 0 && typeof output.presentationMeta !== "function")
  throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
assertSupportedJsonSchema(output.schema);
```

`defineTool()` — the documented authoring helper — does **not** perform this check. A plugin author
who follows the type for `render`-as-optional (or who writes a plain object definition, which the
runtime also accepts) gets no feedback until the host **boots the plugin tree**, at which point the
throw aborts startup. Observed symptom in a real deployment:

- `dsh web` never serves; the agent sits in `connecting` forever
- the reverse proxy still accepts connections on its port, so the failure looks like a network
  problem rather than a plugin problem
- the only signal is one line in the host log

## Minimal reproduction

```js
import { defineTool } from '@deepseek-ai/dsh-tools';

const def = defineTool({
  name: 'hello',
  description: 'hello',
  parameters: {},
  output: { schema: { type: 'object', properties: { ok: { type: 'boolean', required: true } } } },
  async execute() { return { ok: true }; },
});
// no error here …
await ctx.plugin({ name: 'p', inject: ['tools'], apply: (c) => c.tools.register(def) });
// … and the host dies here:
// TypeError: tool "hello" must declare output { schema, render, presentationMeta? }
```

## Impact

- **Blast radius is the host, not the plugin.** One malformed tool definition prevents the entire
  profile from booting. On a headless/embedded deployment with no supervisor, that is an outage
  until a human intervenes.
- **The error is delayed past every cheap checkpoint.** Lint, typecheck, unit tests and
  `--dump-config` all pass; only boot fails.
- **`--dump-config` cannot catch it** either: composing the patch layers never builds tool
  definitions, so a config that composes cleanly can still be unbootable.

## Proposal (in order of preference)

### 1. Fail fast in `defineTool()`

Move — or duplicate — the `output.render` assertion into `defineTool()`. Authors then get the error
at module evaluation time, which every test harness and every `import` of the plugin hits, long
before boot.

```js
export function defineTool(options) {
  const { output, name } = options;
  if (output === undefined || typeof output !== 'object' || typeof output.render !== 'function'
      || (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function'))
    throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
  return { ...options /* …existing compilation… */ };
}
```

This is the same check already in `register()`; a plausible one-line extraction into a shared
`assertOutputSpec(name, output)` used by both keeps a single source of truth. **No behaviour change
for correct plugins.**

### 2. Make the boot failure attributable

If a row fails to load, the host log should name the **plugin row id**, the **module specifier**, and
the offending **tool name**, plus a one-line hint. Today the log shows the raw `TypeError`, which is
enough for an expert and not enough for anyone else.

### 3. Document `render` as required, with a complete example

The type is `render(args, value): ContentBlock[]` — required, and easy to miss next to an optional
`presentationMeta`. A minimal complete `defineTool` example in the README and in the tool-authoring
guide would have prevented this report.

### 4. Optional: give the loader a per-row "must not break the host" mode

A `required: false` (or `optional: true`) row attribute that logs a failed row and continues booting
would let operators install third-party plugins without risking the whole profile. Best-effort
semantics need to be explicit, though — silently degrading a tool set can be worse than failing.

## Pre-flight pattern for plugin authors (workaround until 1 ships)

Until `defineTool()` validates, plugin authors can mirror the registration-time check in a
pre-restart script. The check is short and needs no boot:

```js
import { assertSupportedJsonSchema, parameterSchemaSpecToJsonSchema, defineTool } from '@deepseek-ai/dsh-tools';

const def = defineTool(spec);
if (typeof def.output?.render !== 'function') throw new Error('output.render missing');
assertSupportedJsonSchema(def.output.schema);
assertSupportedJsonSchema(parameterSchemaSpecToJsonSchema(spec.parameters ?? {}));
```

Two extra traps discovered while building that pattern, both worth documenting:

- **`output.schema` is authored as a value-spec** (`required: true` on a property node) and is
  compiled by `defineTool()`. Validating the *authored* form with `assertSupportedJsonSchema()` is a
  false alarm; validating only the *compiled* form hides authoring mistakes. Check both.
- **A parameter root is an implicit open object.** A hand-rolled compiler must not add
  `additionalProperties: false`, or the fallback becomes stricter than the host and silently rejects
  extra arguments. Byte-for-byte parity with `defineTool()` is the only safe target.

## Environment

- `@deepseek-ai/dsh-tools@0.1.0-rc.7`, `@deepseek-ai/cordis@4.x`
- Node 24.19, Linux
- Reproduced on a `web` profile with one third-party plugin row; the row was added to
  `cordis.patch.yml`, `--dump-config` succeeded, boot failed.

Happy to open a PR for (1) plus README changes if the shape of the shared assertion is agreed on.
