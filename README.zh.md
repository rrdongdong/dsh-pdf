# dsh-tool-pdf

给 DSH 用的两个工具：`pdf_fetch`（带断点续传与完整性校验的下载）与 `pdf_extract`（PDF 正文抽取）。
存在理由：CVPR/CVF 与部分 IEEE 论文的 PDF 使用**子集化 CID 字体 + 压缩对象流（/ObjStm）**，
手写正则抽取器会字体映射为 0（抽不出正文）并把 12–14MB 的矢量图形流误当正文而假死。
`pdfjs-dist` 原生处理 ToUnicode CMap，86ms 即可加载 11MB 论文。

| 工具 | 作用 | 关键行为 |
|---|---|---|
| `pdf_extract(path, pages?, maxChars?)` | 抽正文 | 先判 `%%EOF`→`PDF_TRUNCATED`；再判 `%PDF-` 魔数→`PDF_BAD_MAGIC`；只读 |
| `pdf_fetch(url, force?, attempts?, perAttemptTimeoutMs?)` | 下 PDF | `Range` 断点续传、多次重试、`%%EOF` 校验；只写 `os.tmpdir()/dsh-pdf-cache` |

## 安装（三步，需要重启 dsh 才生效）

```bash
# 1) 依赖（已在本目录完成）
cd ~/.dsh/plugins/dsh-tool-pdf && npm i

# 2) 让 profile 能解析到本包（用符号链接，避免 npm 重写 profile 的依赖树）
ln -s ~/.dsh/plugins/dsh-tool-pdf ~/.dsh/profiles/web/node_modules/dsh-tool-pdf

# 3) 在 profile 的 patch 里插入一行（先备份）
cp ~/.dsh/profiles/web/cordis.patch.yml ~/.dsh/profiles/web/cordis.patch.yml.bak
cat >> ~/.dsh/profiles/web/cordis.patch.yml <<'YAML'
- insert:
    - id: tool-pdf
      name: 'dsh-tool-pdf'
YAML
```

然后重启 `dsh web`，会话里应出现 `pdf_extract` / `pdf_fetch`。

## 自检（不需要 DSH，不需要重启）

```bash
node bin/selftest.mjs /path/to/paper.pdf 1-3
```

## 设计约束

- **不依赖 `@deepseek-ai/*`**：公网镜像是旧的 `0.0.1-rc.1`，装进来会与 profile 的 `0.1.0-rc.7`
  形成双实例而破坏工具注册。工具定义写成普通对象即可。
- **不写用户文件**：下载仅落在系统临时目录的私有缓存；抽取只读。
- **无配置项**：不导出 `Config`。
