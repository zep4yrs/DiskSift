<div align="center">

<img src="apps/desktop/src-tauri/icons/128x128.png" alt="Diskwise" width="96" height="96" />

# Diskwise

**WizTree 的扫描速度 + AI 一个个解释每个文件夹是什么 · 能不能删 · 怎么删 + 微信/Chrome/Steam/npm... 等 13 款 App 的专属清理脚本**

[![CI](https://github.com/OWNER/diskwise/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/diskwise/actions/workflows/ci.yml)
[![Release](https://github.com/OWNER/diskwise/actions/workflows/release.yml/badge.svg)](https://github.com/OWNER/diskwise/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-ff6fa8.svg)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/OWNER/diskwise/total?color=ff6fa8)](https://github.com/OWNER/diskwise/releases)

[**📥 下载 Windows 安装包**](https://github.com/OWNER/diskwise/releases/latest) ·
[macOS](https://github.com/OWNER/diskwise/releases/latest) ·
[Linux](https://github.com/OWNER/diskwise/releases/latest) ·
[贡献清理脚本](docs/SCAFFOLD-AUTHORING.md) ·
[问题反馈](https://github.com/OWNER/diskwise/issues)

</div>

---

## 这个工具能干嘛？

**一句话**：以前你用 WizTree 扫完 C 盘，看到一堆陌生的大文件夹，要一个一个截图问 AI"这是什么、能删吗"——Diskwise 把这一步**做成软件了**。

它会：

1. ⚡ **像 WizTree 一样秒扫磁盘** — 出彩色 treemap + 树状图。
2. 🤖 **巡查每个大于 1 GB 的文件夹** — 已知的 App（微信、Chrome、Steam、npm…）直接显示**专属清理面板**；不认识的文件夹**调你配的 AI**（OpenAI / Anthropic / 本地 Ollama）来解释。
3. 🛡️ **删除默认进回收站** + 7 天隔离区 + 操作日志（可撤销）。
4. 🔌 **脚手架可贡献** — 一个 `.toml` 文件加一个 App 的支持，欢迎 PR。

> 受 [blackboxo/CleanMyWechat](https://github.com/blackboxo/CleanMyWechat) 启发，但范围更广 —— 不止微信。

## 截图

| 主界面（扫描完成 · treemap） | 自动巡查（专属脚本面板） | AI 解释陌生文件夹 |
|---|---|---|
| ![scan](docs/screenshots/01-scan.png) | ![scaffold](docs/screenshots/02-scaffold.png) | ![advisor](docs/screenshots/03-advisor.png) |

> 截图占位 — 第一次发布前补上。可临时用浏览器预览模式（见下文）截图。

## 安装与使用

### 普通用户（Windows）

1. 打开 **[Releases 页面](https://github.com/OWNER/diskwise/releases/latest)**。
2. 下载 `Diskwise_0.x.x_x64-setup.exe`（NSIS 安装器）或 `.msi`。
3. 双击安装，桌面会出现 Diskwise 图标。
4. 第一次打开 → 点右上角 ⚙ → 配 AI（推荐先用本地 Ollama，免费免 key；或填 OpenAI / Anthropic 的 API Key）。
5. 选一个磁盘 → 点「扫描」→ 点「开始巡查」→ 一个一个文件夹审阅。

### macOS / Linux 用户

同样去 Releases 下载 `.dmg` 或 `.AppImage` / `.deb`。

### 浏览器先看看（不装也能玩）

```bash
git clone https://github.com/OWNER/diskwise && cd diskwise
pnpm install
pnpm -C apps/desktop dev
```

打开 <http://127.0.0.1:1420>。会看到模拟数据，所有按钮都能响应。**在右上角设置里填 AI Key 后，AI 卡片会调真实接口**。这种模式下"删除"是假的，不会动你的真实文件。

## AI 提供商对比

| 提供商 | 费用 | 隐私 | 推荐场景 |
|---|---|---|---|
| **Ollama**（本地） | 免费 | 全部本地，不上网 | 装了 Ollama 的人 |
| **OpenAI** | 按 token 付费（gpt-4o-mini 一次约 ¥0.001） | 路径会发到 OpenAI（不发文件内容） | 没装 Ollama 但想要好效果 |
| **Anthropic Claude** | 类似 OpenAI（Haiku 最便宜） | 同上 | 偏好 Claude 风格 |

无论哪种，**Diskwise 只发目录元数据**：路径、大小、文件数、扩展名占比、20 条样本路径——**绝不读文件内容**。

## 内置清理脚本

| 类别 | 脚本 ID | 作用 |
|---|---|---|
| 通讯 | `wechat-pc` | 微信 PC 端 FileStorage 媒体缓存（图/视频/接收的文件） |
| 浏览器 | `chrome` `edge` `firefox` | HTTP cache · Code cache · GPUCache · Service Worker |
| 包管理 | `npm` `pnpm` `yarn` `pip` `cargo` | 各种 cache / store / registry |
| 容器 | `docker` | buildx / scout / log |
| IDE | `jetbrains` | caches / logs / system（不动配置） |
| 游戏 | `steam` | downloading / shadercache / workshop temp |
| AI | `huggingface` | 已下载的模型/数据集缓存 |

**没找到你想清的 App？** [开个 Issue](https://github.com/OWNER/diskwise/issues/new?template=scaffold-request.yml)，或者照 [docs/SCAFFOLD-AUTHORING.md](docs/SCAFFOLD-AUTHORING.md) 自己写一个 `.toml` 提 PR。

## 注意事项

- 微信脚本**仅清理 FileStorage 下的媒体缓存**，不会触碰聊天记录数据库。已删的图片/视频在旧聊天里会显示缺失。
- Docker 缓存属于"高风险"——建议先用官方的 `docker system prune`。
- HuggingFace 缓存属于"中风险"——里面是已下载的模型权重，删了重下可能很费流量。
- 第一次"清理"前建议先勾选 **dry-run（模拟运行）** 模式确认。
- 所有删除默认进**系统回收站**，可在回收站恢复。

## 常见问题

<details>
<summary><strong>Q：扫描有 WizTree 那么快吗？</strong></summary>

v0.1 用的是跨平台的 `walkdir`，比 WizTree 慢 5-10 倍（WizTree 直读 NTFS MFT）。**v0.2 会加 MFT 直读**，速度对齐 WizTree。
</details>

<details>
<summary><strong>Q：AI Key 安全吗？会不会上传？</strong></summary>

桌面 app 模式下：Key 存在本地 Tauri 状态里，不写磁盘。  
浏览器预览模式：Key 存在 `localStorage`（你这台电脑的浏览器里）。  
两种模式下，发给 AI 的请求里都**只有目录元数据**——路径名、大小、文件数、文件扩展名分布——**绝不发文件内容**。
</details>

<details>
<summary><strong>Q：删错了能恢复吗？</strong></summary>

可以。所有删除默认进系统回收站，从回收站还原即可。如果你选了"隔离"模式，文件会被移到 `~/.diskwise/quarantine/` 放 7 天。所有操作都写到 `~/.diskwise/undo.jsonl`，未来版本会做"撤销"按钮。
</details>

<details>
<summary><strong>Q：为什么没找到我的某个 App？</strong></summary>

只支持有"清理脚本"的 App。其他文件夹会走 AI 通用判断（你需要先配 Key）。想加新 App 支持就提 PR——schema 在 [docs/SCAFFOLD-AUTHORING.md](docs/SCAFFOLD-AUTHORING.md)，**一个 TOML 文件就够了**。
</details>

<details>
<summary><strong>Q：Windows SmartScreen 拦截了怎么办？</strong></summary>

v0.1 没有 EV 代码签名。点"更多信息" → "仍要运行"。后续版本会签名。
</details>

## 开发

需要 **Node 20+**, **pnpm 9+**, **Rust stable**, **Tauri 前置依赖**（Win 上是 VS Build Tools 2022 + WebView2）。

```bash
git clone https://github.com/OWNER/diskwise && cd diskwise
pnpm install
pnpm tauri dev          # 启动桌面 app（首次会编译 Rust 依赖，5-15 分钟）
cargo test --workspace  # Rust 单测
pnpm -C apps/desktop dev # 仅前端，浏览器调试用
```

详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 项目结构

```
diskwise/
  apps/desktop/         Tauri 2 桌面应用
    src/                React + TypeScript 前端
    src-tauri/          Tauri Rust 后端
  crates/
    scanner/            磁盘扫描器
    scaffold/           TOML 脚本加载器 + 路径匹配
    executor/           回收站/隔离/永久删 + undo 日志
    advisor/            AI 顾问（OpenAI/Anthropic/Ollama）
    scaffold-lint/      脚本校验 CLI
  scaffolds/            13 个内置脚本（*.toml）
  docs/
  .github/workflows/    CI + Release
```

## 路线图

- [x] v0.1 — 基础扫描 + 13 脚本 + AI 顾问 + 自动巡查
- [ ] v0.2 — Windows NTFS MFT 直读（WizTree 同等速度）
- [ ] v0.2 — 撤销 UI
- [ ] v0.2 — 可下钻的 zoomable treemap
- [ ] v0.3 — 更多脚本（QQ / DingTalk / Slack / Discord / OBS / Adobe / Unity / Android SDK ...）
- [ ] v0.3 — 0 配置：自动检测本地 Ollama

## 鸣谢

- [WizTree](https://diskanalyzer.com) — 灵感来源
- [SquirrelDisk](https://github.com/adileo/squirreldisk) — Tauri + Rust 实现参考
- [CleanMyWechat](https://github.com/blackboxo/CleanMyWechat) — 微信脚本范本
- [Tauri](https://tauri.app), [d3-hierarchy](https://github.com/d3/d3-hierarchy)

## License

[MIT](LICENSE) · 欢迎 fork、商用、闭源衍生。

---

<div align="center">
<sub>用 ❤️ 和 💻 写于 2026 · 喜欢就给个 ⭐</sub>
</div>
