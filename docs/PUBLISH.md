# 发布清单

> **没有任何东西会自动发布。** 本仓库只在你本地：不联网、不推送、不 `npm publish`。
> 每一条命令都需要你亲自执行，且发布到哪个账号完全由你决定。

## 0. 发布前必做：把占位符换成你的账号

仓库里目前是 `OWNER` 占位符（3 处，都在 `package.json`）：

```bash
cd ~/.dsh/plugins/dsh-tool-pdf
YOUR_GH=your-github-username          # ← 改成你的账号
sed -i "s/OWNER/$YOUR_GH/g" package.json README.md
grep -n "$YOUR_GH" package.json        # 确认替换
```

同时确认：
```bash
git config user.name  ; git config user.email     # 提交者身份
gh auth status                                    # 若用 gh，需已登录你的账号
```

## 1. 选一个发布位置（三选一）

| 方案 | 适合 | 说明 |
|---|---|---|
| **A. 你自己的个人仓库** | 想作为个人作品/长期维护 | `github.com/<你>/dsh-tool-pdf` |
| **B. 你的组织仓库** | 有实验室/团队组织 | 同上，换 org |
| **C. 直接给上游提 PR** | 只想要"被 DSH 收录" | 先 fork `deepseek-ai/deepseek-harness`，插件是否接受进主仓取决于维护者；**同时**按 A 建自己的仓库更稳 |

> 建议 **A + issue**：插件放自己仓库（可控、可 star），把 `docs/issue-draft.md` 作为 issue 提给上游。
> 理由：插件依赖 `pdfjs-dist`（34 MB），上游是否愿意带入这个依赖是未知数。

## 2. 本地首次提交（已在别处做过可跳过）

```bash
cd ~/.dsh/plugins/dsh-tool-pdf
git init -b main
git add -A
git commit -m "feat: pdf_fetch + pdf_extract tools for DSH (CID/ObjStm-safe)

- pdf_extract: pdfjs-based text extraction (subsetted CID fonts, ToUnicode, /ObjStm)
- pdf_fetch: Range resume + retries + %%EOF verification
- config: cacheDir / maxPdfBytes / defaultMaxChars / fetchAttempts / fetchPerAttemptTimeoutMs
- bin/preflight.mjs: mirrors ToolRuntime.register() before a host restart
- 24 unit tests, CI on Node 20/22"
```

## 3. 建远端并推送

**用网页建**（不需要凭据）：
1. github.com → New repository → 名称 `dsh-tool-pdf` → **不要**勾选初始化 README
2. 然后：
```bash
git remote add origin git@github.com:$YOUR_GH/dsh-tool-pdf.git   # 或 https://...
git push -u origin main
```

**或用 gh CLI**（需你先 `gh auth login` 到你自己的账号）：
```bash
gh repo create dsh-tool-pdf --public --source=. --remote=origin --push
```

> ⚠️ `--public` 会立刻公开。若想先私有：`--private`，确认无误再改可见性。

## 4. 可选：发到 npm

**只有在你想让别人 `npm i dsh-tool-pdf` 时才做**。`package.json` 已含 `publishConfig.access=public`。

```bash
npm whoami                 # 确认登录的是你的 npm 账号
npm pack --dry-run         # 先看会打包哪些文件（应只有 lib/bin/docs/README/LICENSE）
npm publish --access public
```

## 5. 可选：给上游提 issue

把 `docs/issue-draft.md` 的内容按下面的结构贴（这条 issue 不需要仓库也能提）：

```
Title: defineTool() should validate output.render (missing it takes down the host at boot)

Body:
- Summary: ToolRuntime.register() requires output.render; defineTool() does not check it,
  so the throw only happens during plugin-tree load and the whole gateway fails to boot.
- Repro: (minimal 6-line snippet from the draft)
- Impact: blast radius is the host, not the plugin; --dump-config cannot catch it.
- Proposal: extract a shared assertOutputSpec() used by both.
- Two extra traps worth documenting: output.schema is an authored value-spec (not raw JSON
  Schema), and a parameter root is an implicit open object (don't add additionalProperties:false).
```

## 6. 发布后自查

```bash
# 干净克隆能否自洽？
cd /tmp && git clone https://github.com/$YOUR_GH/dsh-tool-pdf.git probe && cd probe
npm ci && npm test && npm run preflight -- ./fixtures/sample.pdf
```

三条都过 → 可发布；任一失败 → 别推。

## 我不会做的事

- 不会读取、索取或使用你的 GitHub / npm 凭据
- 不会替你 `push` / `publish`
- 不会把任何内容上传到任何账号
