# Pinkbin · Diskwise

> **The open-source disk cleaner that knows what your folders actually are.** Native NTFS-MFT scanner (WizTree-class speed) · 38 hand-tuned cleanup scaffolds for the apps that hoard your bytes (WeChat 3.x + 4.x · Steam · Chrome · Docker · HuggingFace · conda envs · …) · BYOK AI advisor that explains every unknown directory before you delete it · everything goes through the system Recycle Bin first.

<p align="center">
  <img src="apps/desktop/src-tauri/icons/128x128.png" alt="Pinkbin — pink pixel-art trash can" width="128" height="128" />
</p>

<p align="center">
  <a href="https://github.com/cccyd2003-qwq/pinkbin/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/cccyd2003-qwq/pinkbin?style=for-the-badge&labelColor=0d1117&color=ffd700&logo=github&logoColor=white" /></a>
  <a href="https://github.com/cccyd2003-qwq/pinkbin/network/members"><img alt="Forks" src="https://img.shields.io/github/forks/cccyd2003-qwq/pinkbin?style=for-the-badge&labelColor=0d1117&color=2ecc71&logo=github&logoColor=white" /></a>
  <a href="https://github.com/cccyd2003-qwq/pinkbin/issues"><img alt="Issues" src="https://img.shields.io/github/issues/cccyd2003-qwq/pinkbin?style=for-the-badge&labelColor=0d1117&color=ff6b6b&logo=github&logoColor=white" /></a>
  <a href="https://github.com/cccyd2003-qwq/pinkbin/pulls"><img alt="Pull Requests" src="https://img.shields.io/github/issues-pr/cccyd2003-qwq/pinkbin?style=for-the-badge&labelColor=0d1117&color=9b59b6&logo=github&logoColor=white" /></a>
  <a href="https://github.com/cccyd2003-qwq/pinkbin/graphs/contributors"><img alt="Contributors" src="https://img.shields.io/github/contributors/cccyd2003-qwq/pinkbin?style=for-the-badge&labelColor=0d1117&color=3498db&logo=github&logoColor=white" /></a>
  <a href="https://github.com/cccyd2003-qwq/pinkbin/commits/main"><img alt="Last commit" src="https://img.shields.io/github/last-commit/cccyd2003-qwq/pinkbin?style=for-the-badge&labelColor=0d1117&color=8e44ad&logo=git&logoColor=white" /></a>
</p>

<p align="center">
  <a href="https://github.com/cccyd2003-qwq/pinkbin/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/cccyd2003-qwq/pinkbin?style=flat-square&color=ff69b4&label=release&include_prereleases" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" /></a>
  <a href="#内置-cleanup-scaffolds"><img alt="Scaffolds" src="https://img.shields.io/badge/scaffolds-38-orange?style=flat-square" /></a>
  <a href="#ai-顾问byok"><img alt="AI providers" src="https://img.shields.io/badge/AI-Anthropic%20%C2%B7%20OpenAI%20%C2%B7%20Gemini%20%C2%B7%20Ollama-black?style=flat-square" /></a>
  <a href="#安装"><img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-lightgrey?style=flat-square" /></a>
  <a href="https://tauri.app"><img alt="Built with Tauri" src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white" /></a>
</p>

<p align="center"><b>简体中文</b> · <a href="README_EN.md">English</a> <sub>(待翻译)</sub></p>

---

## 这个工具为什么存在

WizTree、SpaceSniffer、TreeSize 都能告诉你**哪个文件夹大**——颜色块铺满屏幕，500GB 的盘里那个 80GB 的方块直勾勾盯着你看。然后呢？你看着 `C:\Users\<你>\Documents\xwechat_files\wxid_abc123\` 这个名字 80GB 的文件夹，**没人告诉你能不能删**。打开 360 清理大师只会告诉你"垃圾文件 0.3GB"，因为它不认识这个目录。最后你只好截图发给 ChatGPT，问它一个一个解释。

**Pinkbin 把"截图问 AI"这一步做成了软件。** 它做三件事：

1. **像 WizTree 一样秒扫磁盘**——Windows 上直读 NTFS Master File Table（不走文件系统），扫整个 C 盘 2–5 秒，跟 WizTree 同档。出彩色 treemap + 树状视图。
2. **38 个内置清理 scaffold**——已知的 App（微信 3.x/4.x、QQ、Steam、Chrome、Docker、conda envs、HuggingFace 模型、npm/pnpm/yarn 缓存…）直接显示**专属清理面板**，每个 scaffold 都把"哪些是缓存可清"vs"哪些是聊天记录绝对不动"明确写死，并由集成测试守住红线。
3. **不认识的文件夹甩给 AI**——OpenAI / Anthropic / Google Gemini / 本地 Ollama 任挑一个（你提供 Key）。Pinkbin 只发**目录元数据**给 AI（路径名、大小、文件数、扩展名占比、20 条样本路径），**永远不读文件内容**。

所有删除默认进**系统回收站**，可恢复；可选 7 天隔离区；每一个动作写入 `~/.diskwise/undo.jsonl`。

---

## At a glance

| | 你能用到的 |
|---|---|
| **磁盘扫描器** | Windows 直读 NTFS MFT（jwalk 跨平台 fallback）—— 整盘 C: 2–5 秒，跟 WizTree 同档；进度条按"已扫文件 / 总文件估计"实时更新，**不会**一上来就显示 100% |
| **38 个清理 scaffold** | WeChat 3.x · WeChat 4.x · QQ · 飞书 · 钉钉 · Slack · Discord · Telegram · Teams · Chrome · Edge · Firefox · Brave · VSCode · Cursor · JetBrains · Steam · Epic · Battle.net · HuggingFace · Ollama · Spotify · OBS · Docker · npm · pnpm · yarn · pip · conda · cargo · go-mod · gradle · maven · nuget · node-modules · windows-temp · windows-old · recycle-bin · crash-dumps |
| **AI 顾问（BYOK）** | Anthropic Claude（官方 / LuckyAPI 反代）· OpenAI GPT（官方 / OpenRouter / one-api 自建）· Google Gemini · 本地 Ollama —— 4 种协议任挑，Key 仅存本机 localStorage **绝不上传** |
| **WeChat 3.x + 4.x 双兼容** | 4.x 13 个 scope（cache/Message · HttpResource · WeAppIcon · Emoticon · temp · avatar · apm · 4 个 msg 媒体桶 · Backup · 漫游 log/crashinfo/update）+ **3.x 9 个 scope**（FileStorage 下 Image/Video/File/Voice2/MsgAttach/Stickers/Temp/Cache + 漫游 Log/Update）。变体由扫描结果自动检测，不显示你机器上没有的桶 |
| **conda env 卡片** | 列出所有 conda env、自动按 `conda-meta/history` mtime 标记 stale（>90 天），整目录回收（1 条回收站记录 vs 几万条文件级记录） |
| **WeChat 多账号过滤** | 多个 wxid 共存时按账号勾选；"删几天前的"输入框，配置持久化到 localStorage |
| **安全机制四件套** | (1) Scope 红线集成测试 · (2) UI 两步确认（不依赖 `window.confirm`，Tauri webview 不稳）· (3) `<ErrorBoundary>` 包裹所有破坏性按钮 · (4) 默认 `mode = "recycle"`（永删模式必须用户主动选） |
| **撤销日志** | `~/.diskwise/undo.jsonl` 按行 append；隔离模式把文件移到 `~/.diskwise/quarantine/` 放 7 天再清 |
| **跨平台** | Windows 10/11（含 NTFS MFT fast-path）· macOS · Linux · 浏览器预览模式（mock 后端，UI 调试用） |
| **协作工作流** | 仓库内 14-phase scaffold authoring SOP · `/add-scaffold <id>` slash command · 14 项 PR checklist · `docs/scaffold-requirements/STATUS.md` 进度台账 |
| **License** | MIT · 欢迎 fork、商用、闭源衍生 |

---

## Demo

<table>
<tr>
<td width="50%">
<img src="docs/screenshots/01-scan.png" alt="01 · 扫描完成" /><br/>
<sub><b>主界面</b> —— 左侧 WizTree 风格树状视图（黄色文件夹 + 单行 22px 高），中间是 AI 主聊天面板，右侧 Studio 卡片按已检出 scaffold 大小排序。底部进度条按 NTFS MFT 实测进度，不是假动画。</sub>
</td>
<td width="50%">
<img src="docs/screenshots/02-scaffold.png" alt="02 · Studio 面板" /><br/>
<sub><b>Studio 多桶面板</b> —— WeChat 卡片展开后显示 13 个 4.x 桶（或 9 个 3.x 桶，按你机器上的版本自动切换），每个桶单独显示 size + 文件数 + 一键清理按钮。两步确认：第一次点变红"再点确认"，5 秒内再点真清。</sub>
</td>
</tr>
<tr>
<td width="50%">
<img src="docs/screenshots/03-advisor.png" alt="03 · AI 解释陌生文件夹" /><br/>
<sub><b>AI 顾问</b> —— 不在 38 个 scaffold 里的文件夹（比如某个 80GB 的 game studio 缓存），把目录元数据甩给 AI。AI 答："这是 Unreal Engine 的 DerivedDataCache，可以删，下次打开项目会自动重建。"</sub>
</td>
<td width="50%">
<img src="docs/screenshots/04-conda.png" alt="04 · conda env 卡片" /><br/>
<sub><b>conda env 卡片</b> —— 自动列出所有 env，base 灰显不可勾，过 90 天没动过的自动默认勾选。整目录回收 = 1 条回收站记录，不是几万条文件级记录把回收站打爆。</sub>
</td>
</tr>
</table>

> 截图仍为占位，第一次正式 release 前会替换为真实截图。

---

## 安装

### 普通用户

直接去 [**Releases**](https://github.com/cccyd2003-qwq/pinkbin/releases/latest) 下载对应平台的安装包：

| 平台 | 文件 | 备注 |
|---|---|---|
| **Windows 10/11** | `Diskwise_x.x.x_x64-setup.exe`（NSIS）<br/>或 `Diskwise_x.x.x_x64_en-US.msi` | 首次启动 SmartScreen 拦截：点"更多信息" → "仍要运行"。NTFS MFT 直读需要管理员权限，安装包已带 manifest 自动 UAC 提权 |
| **macOS** | `Diskwise_x.x.x_universal.dmg` | 首次需在系统设置 → 隐私与安全里允许运行 |
| **Linux** | `Diskwise_x.x.x_amd64.AppImage` 或 `.deb` | AppImage `chmod +x` 后双击；fallback 到 jwalk 扫描，速度比 Windows 慢 |

打开后：右上角 ⚙ → 配 AI（推荐先用本地 [Ollama](https://ollama.com/download)，不上网无 key）→ 选磁盘 → 扫描 → 点 Studio 卡片审阅。

### 浏览器预览（不装也能玩 UI）

```bash
git clone https://github.com/cccyd2003-qwq/pinkbin.git
cd pinkbin
pnpm install
pnpm -C apps/desktop dev
```

打开 <http://127.0.0.1:1420>。这种模式下后端是 mock，所有按钮都响应但"删除"是假的；AI 调用会真实发到你配的接口。适合贡献 scaffold UI 改动时本地调试。

---

## AI 顾问（BYOK）

**Pinkbin 不内置任何 LLM API**——你提供 Key（或本地跑 Ollama）。设置面板里 3 档可选：

| Source | 协议 | 推荐场景 | 费用 | 隐私 |
|---|---|---|---|---|
| **官方直连** | Anthropic / OpenAI / Gemini | 你已经有官方 Key | 按 token 付费（Haiku / gpt-4o-mini ¥0.001/次量级） | 路径名+大小发到云端，文件内容**绝不**上传 |
| **第三方中转** | LuckyAPI（仿 Anthropic）· OpenRouter（仿 OpenAI）· one-api 自建 · Azure OpenAI | 国内中转或团队共享 Key | 看你的中转价 | 路径名经过中转方 |
| **本地 Ollama** | Ollama HTTP | 完全离线、零成本 | 免费 | 全部本地，**完全不上网** |

设置里有"常见中转预设"下拉，一键填好 baseUrl + 协议。Key 仅存本机 localStorage（浏览器预览模式）或 Tauri 内存（桌面模式），**永远不会上传到我们任何服务器**——因为我们没有服务器。

---

## 内置 cleanup scaffolds

每份 scaffold 是 [`scaffolds/<id>.toml`](scaffolds/) 一个文件，包含 detect glob、match 规则、scope 列表（每个 scope 一条 glob + 风险等级 + 可选的"删 N 天前的" prompt）。Studio 卡片按 scaffold 渲染，scope 按 `category` 分组（缓存 / 媒体 / 备份）。

### 通讯（重点维护，因为最大）

| Scaffold | 版本支持 | 风险 | 主要 scope |
|---|---|---|---|
| [`wechat-pc`](scaffolds/wechat-pc.toml) | **3.x ✓ 4.x ✓**（自动检测） | low | 4.x：cache/Message · HttpResource · WeAppIcon · Emoticon · temp · avatar · apm · msg 媒体（图/视频/文件/语音）· Backup · 漫游 log/crashinfo/update <br/>3.x：FileStorage 下 Image · Video · File · Voice2 · MsgAttach · Stickers · Temp · Cache + 漫游 Log/Update |
| [`qq-pc`](scaffolds/qq.toml) | NT 版本 | low | 缓存与媒体 |
| [`feishu`](scaffolds/feishu.toml) `dingtalk` `slack` `discord` `telegram` `teams` | 各家最新 | low | cache · log |

WeChat scaffold 的红线（**集成测试守护**，详见 [`crates/scaffold/tests/wechat_pc_safety.rs`](crates/scaffold/tests/wechat_pc_safety.rs)）：

- 4.x：`db_storage/**`（聊天 DB）· `business/{favorite,sns,xweb,xeditor,migrate}/**`（收藏/朋友圈/Web 视图状态）· `config/**` · `login/**` · `All Users/**` · `XPlugin/**`
- 3.x：`Msg/**` · `MultiMsg/**`（聊天 DB）· `Accounts/**` · `Favorites/**` · `FileStorage/Fav/**` · **`FileStorage/CustomEmotion/**`**（用户主动保存的"我的表情"，软红线）· `AccInfo.dat`

测试断言上述每条路径都**零命中**任何 scope。任何 PR 改 scaffold 都会被 CI 跑一遍。

### 浏览器

`chrome` `edge` `firefox` `brave` —— Cache · Code Cache · GPUCache · Service Worker。书签、密码、历史记录不动；可能会让你重新登录某些网站。

### 开发者（占大头）

`vscode` `cursor` `jetbrains`（IDE 缓存与索引）· `npm` `pnpm` `yarn` `pip` `conda` `cargo` `go-mod` `gradle` `maven` `nuget`（包管理器缓存）· `docker`（buildx / scout / log，**vhdx 文件不直接删，要走 docker prune**）· `node-modules`（**high risk**，建议手动选具体哪个旧项目）

`conda` 卡片有特殊 UI：列出所有 env，自动标记 stale，整目录回收。详见 [`scaffolds/conda.toml`](scaffolds/conda.toml) 和 [`crates/scaffold/tests/conda_safety.rs`](crates/scaffold/tests/conda_safety.rs)。

### 游戏 · 多媒体 · 系统

`steam`（downloading / shadercache / workshop temp，**游戏本体不动**）· `epicgames` · `battlenet` · `huggingface`（模型权重，**删了要重下几十 GB**，建议 `huggingface-cli delete-cache`）· `ollama` · `spotify` · `obs` · `windows-temp` · `windows-old` · `recycle-bin` · `crash-dumps`

### 没找到你想清的 App？

[开 Issue](https://github.com/cccyd2003-qwq/pinkbin/issues/new) 或自己写一个。schema 在 [`docs/SCAFFOLD-AUTHORING.md`](docs/SCAFFOLD-AUTHORING.md)，14-phase 工作流在 [`.claude/commands/add-scaffold.md`](.claude/commands/add-scaffold.md)。**每份新 scaffold 必须配 safety test**，否则 CI 拒收——这是项目的硬约束（[`CLAUDE.md`](CLAUDE.md) Hard Rule #2）。

---

## 防误删机制

磁盘清理工具最大的失败模式是**删错用户数据**。Pinkbin 不靠"用户自己小心"——用四层机器可执行的约束：

- **Scope 红线集成测试**——每份 scaffold 必须在 `crates/scaffold/tests/<id>_safety.rs` 落一份测试，包含**正向断言**（每个 scope 至少一条命中路径）+ **红线断言**（一组路径必须 zero match）。WeChat 测试里写死了 28 条红线（聊天 DB · 收藏 · 朋友圈 · 加密物料 · plugin 运行时 …）。改 glob 时不小心碰到红线 → 测试挂 → CI 红 → PR 进不去。
- **`must_have_child` 路径校验**——光按文件夹名识别会误报（WPS 的 `uploadwechatfile` 子目录、安装目录的 `WeChatPlayer.bin` 都含 "wechat"）。Scaffold 强制要求该目录必须有特定子目录（WeChat 要 `all_users`），假目标自动被排除。
- **UI 两步确认 + ErrorBoundary**——任何调用 `execute_scope` / `execute_plan` 的按钮：第一次点变红"再点确认"，5 秒内不点自动还原；包裹在 `<ErrorBoundary>` 里，前端崩了显示 stack trace 而不是默默清盘。**不允许用 `window.confirm`**（Tauri webview 行为不稳）。
- **默认走回收站**——Scope 默认 `mode = "recycle"`（删进系统回收站可恢复）。永删模式（`Delete`）只有 scaffold 作者显式标注、用户进阶设置主动开启才生效。Conda env 这种"目录级"清理硬锁 `Recycle`，无视 scope.mode——重建一个 conda env 太贵了。
- **隐私不变量**——枚举用户目录时**只用 `Glob` / `ls` 列文件夹名**，**绝不 `Read` 用户内容**（聊天 DB / 媒体文件 / Key），即使你跟 Claude Code 一起调试 bug 也不行（[`CLAUDE.md`](CLAUDE.md) Hard Rule #4）。

---

## 和别的工具比

| 维度 | WizTree | SpaceSniffer | TreeSize | 360 清理大师 / CCleaner | **Pinkbin** |
|---|---|---|---|---|---|
| License | 闭源 / 个人免费 | 闭源 / 免费 | 闭源 / 商业 | 闭源 / 免费 | **MIT 开源** |
| 平台 | Windows | Windows | Windows / iOS / Android | Windows / Mac | **Win + Mac + Linux** |
| 扫描速度（C 盘 NTFS） | ★★★★★（MFT 直读） | ★★★ | ★★★★ | ★★ | **★★★★★（MFT 直读）** |
| treemap 可视化 | ✅ | ✅ | ✅ | ❌ | **✅ d3-hierarchy** |
| **解释每个文件夹是啥** | ❌ | ❌ | ❌ | 部分（写死规则） | **✅ AI + 38 scaffold** |
| 删除前默认进回收站 | 选项 | 选项 | 选项 | 默认永删 | **默认 ✅，永删需主动选** |
| 撤销日志 | ❌ | ❌ | ❌ | ❌ | **✅ `undo.jsonl`** |
| 隔离模式 | ❌ | ❌ | ❌ | ❌ | **✅ 7 天 quarantine** |
| 红线测试守护 | ❌ | ❌ | ❌ | ❌ | **✅ Rust 集成测试 / CI** |
| 用户数据上传 | ❌ | ❌ | ❌ | **❗有遥测** | **❌ 只发目录元数据给你配的 AI** |
| 可贡献新规则 | ❌ | ❌ | ❌ | ❌ | **✅ 一份 TOML 文件 + safety test** |
| WeChat 3.x + 4.x | ❌ 不识别 | ❌ 不识别 | ❌ 不识别 | 部分 3.x | **✅ 双版本 22 scope** |
| AI 顾问 | ❌ | ❌ | ❌ | ❌ | **✅ BYOK Anthropic / OpenAI / Gemini / Ollama** |

我们**不是**要替代 WizTree——WizTree 仍然是最快的扫描器，单一职责做到极致。Pinkbin 是"WizTree 的扫描层 + 一组**可贡献的清理规则** + AI 兜底"——目标是当你扫完 C 盘看到一堆陌生大文件夹时，**不用再截图发给 ChatGPT 一个一个问**。

---

## 工作流：怎么贡献新 scaffold

每加一个 App 支持就是一份 PR。完整流程在 [`.claude/commands/add-scaffold.md`](.claude/commands/add-scaffold.md)（14 phase），简化版：

1. **写需求文档** —— 在 [`docs/scaffold-requirements/`](docs/scaffold-requirements/) 建一份 markdown，列出该 App 的红线（聊天 DB？账号 key？用户收藏？）
2. **路径勘测** —— 在你机器上跑一次该 App，用 `Glob` 列出真实目录结构，找出 cache vs 用户数据的边界
3. **写 TOML** —— 抄 [`scaffolds/_templates/scaffold.toml`](scaffolds/_templates/scaffold.toml)，填 `detect` / `match` / `scope`
4. **写 safety test** —— 抄 [`crates/scaffold/tests/_templates/scaffold_safety.rs`](crates/scaffold/tests/_templates/scaffold_safety.rs)，正向断言 + 红线断言
5. **跑 CI 闭环** —— `cargo test -p diskwise-scaffold` 全绿 + `cargo run -p diskwise-scaffold-lint -- scaffolds/<id>.toml` 0 error
6. **UI 验证** —— `pnpm tauri dev`，确认卡片渲染、scope 数字非零、删除两步确认生效
7. **提 PR** —— 模板会帮你逐项 checklist

如果你已经在用 [Claude Code](https://claude.com/claude-code)：直接在仓库根目录敲 `/add-scaffold <id>`，会自动启动 14-phase 工作流。

---

## 开发

需要 **Node 20+**, **pnpm 9+**, **Rust stable**, **Tauri 前置依赖**（Win 上是 VS Build Tools 2022 + WebView2）。

```bash
git clone https://github.com/cccyd2003-qwq/pinkbin.git
cd pinkbin
pnpm install

# 桌面 app（首次会编译 Rust 依赖，5-15 分钟）
pnpm tauri dev

# 或仅前端，浏览器调试用
pnpm -C apps/desktop dev

# 全工作空间测试
cargo test --workspace

# Scaffold lint（CI 必跑）
cargo run -p diskwise-scaffold-lint -- scaffolds/*.toml

# 类型检查
pnpm -C apps/desktop exec tsc --noEmit
```

CI 矩阵：`cargo fmt`/`clippy` · `cargo test --workspace`（Ubuntu + macOS + Windows）· scaffold-lint · `pnpm -C apps/desktop build`。详见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)。

---

## 项目结构

```
pinkbin/
├── apps/desktop/                 Tauri 2 桌面应用
│   ├── src/                      React + TS 前端
│   │   ├── components/Studio.tsx 多桶面板（WeChat/Conda/通用三种渲染）
│   │   ├── components/ChatPanel.tsx 中间 AI 聊天面板
│   │   ├── components/TreeView.tsx WizTree 风格树
│   │   └── components/ErrorBoundary.tsx 防御三件套之一
│   └── src-tauri/src/lib.rs      IPC 命令（scan_path · scope_sizes · execute_scope · advise · …）
├── crates/
│   ├── scanner/                  jwalk + Windows NTFS MFT 直读
│   ├── scaffold/                 TOML schema · detect · compile_all
│   ├── executor/                 Recycle / Quarantine / Delete + undo.jsonl
│   ├── advisor/                  AI 顾问（4 协议）
│   └── scaffold-lint/            scaffold 校验 CLI（CI 必跑）
├── scaffolds/                    38 个 .toml + _templates/
├── docs/
│   ├── scaffold-requirements/    每类需求文档 + STATUS.md 进度台账
│   ├── HOWTO.md                  给新 collaborator 的入门
│   └── research/                 生态调研（Python · IDE · 通讯 …）
└── .claude/commands/             /add-scaffold + /scaffold-review slash command
```

---

## 路线图

- [x] **v0.1** —— 基础扫描 + 38 scaffold + AI 顾问 + Studio 多桶 UI
- [x] **v0.2 性能** —— Windows NTFS MFT 直读 · scaffold 检测 88× 提速 · WeChat 4.x 重写 · conda env 卡片
- [ ] v0.3 —— 撤销 UI（消费 `undo.jsonl`）
- [ ] v0.3 —— 可下钻的 zoomable treemap
- [ ] v0.3 —— 0 配置：自动检测本地 Ollama
- [ ] v0.4 —— 更多 scaffold：QQ 优化 · OBS · Adobe · Unity · Android SDK · Visual Studio · Xcode 模拟器 · …
- [ ] v0.5 —— macOS / Linux 也用 native fast scanner（APFS Spotlight / btrfs subvol enumeration）
- [ ] v0.6 —— scaffold marketplace（用户提交、社区验证）

---

## FAQ

<details>
<summary><strong>Q: 我的微信是 3.x 老版本，能用吗？</strong></summary>

可以。`wechat-pc` scaffold 同时识别 4.x（`xwechat_files/`）和 3.x（`WeChat Files/`），UI 自动检测你的版本只显示对应的桶——4.x 用户看不到 3.x 桶反之亦然。3.x 9 个 scope 覆盖 FileStorage 下的 Image / Video / File / Voice2 / MsgAttach / Stickers / Temp / Cache，外加漫游目录的 Log 和 Update。聊天记录（`Msg/`、`MultiMsg/`）和用户收藏（`Favorites/`、`CustomEmotion/`）由集成测试守护，**永远**不会被任何 scope 命中。
</details>

<details>
<summary><strong>Q: 扫描有 WizTree 那么快吗？</strong></summary>

Windows 上**有**——v0.2 后 Pinkbin 直读 NTFS MFT，扫整个 C 盘 2–5 秒，跟 WizTree 同档。需要管理员权限（安装包带 manifest 自动 UAC）。macOS / Linux 现在还是 jwalk 跨平台 walker，比 Windows 慢 5–10×；APFS / btrfs 的 native 路径在 v0.5 路线图。
</details>

<details>
<summary><strong>Q: AI Key 安全吗？会不会被上传？</strong></summary>

Key 仅存本机：浏览器预览模式存在 `localStorage`，桌面模式存在 Tauri 进程内存。**Pinkbin 没有任何服务器**——发往 AI 的请求直接从你电脑出，到你配的 AI 服务商（或本地 Ollama）。请求体里**只有目录元数据**——路径名、大小、文件数、扩展名分布、最多 20 条样本路径名——**绝不发文件内容**。代码层面这是 [`CLAUDE.md`](CLAUDE.md) Hard Rule #4。
</details>

<details>
<summary><strong>Q: 删错了能恢复吗？</strong></summary>

可以。所有删除默认进**系统回收站**，从回收站还原即可。如果你选了"隔离"模式，文件会被移到 `~/.diskwise/quarantine/` 放 7 天再清。每个动作都写 `~/.diskwise/undo.jsonl`，未来版本会做"撤销"按钮。**强烈建议第一次用某个 scaffold 时先勾选 dry-run（模拟运行）确认。**
</details>

<details>
<summary><strong>Q: 为什么有些 App 没有 scaffold？</strong></summary>

要么是没人写过——欢迎 PR。要么是太长尾（每个 IDE fork 各做一份 scaffold 没意义，38 个已经覆盖 80% 痛点）。不在 scaffold 内的文件夹会走 AI 通用判断（你需要先配 Key）。详见我们的产品哲学回顾：[`docs/research/python-dev-cleanup-landscape.md`](docs/research/python-dev-cleanup-landscape.md) §3。
</details>

<details>
<summary><strong>Q: Windows SmartScreen 拦截了怎么办？</strong></summary>

v0.x 没有 EV 代码签名（一份 EV 证书 ¥2000+/年，作者还没出血）。点"更多信息" → "仍要运行"。后续版本会上签名。源码 100% 公开，你也可以自己 `cargo tauri build` 编译你信得过的二进制。
</details>

<details>
<summary><strong>Q: 我的 conda env 被自动勾选了，会不会误删？</strong></summary>

不会。`conda` scaffold 的 stale 判定是 `<env>/conda-meta/history` 的 mtime 超过 90 天没更新——这意味着这 90 天里你没在这个 env 里 `conda install / pip install` 过任何东西。Base env 永远灰显不可勾。整目录走回收站可恢复。但删 conda env 的真正成本是**重建要重新下几百 MB 包**——所以即使勾选了，UI 也会两步确认。
</details>

---

## 致谢

- **架构 & 灵感**
  - [WizTree](https://diskanalyzer.com) —— NTFS MFT 直读思路与速度标杆
  - [SquirrelDisk](https://github.com/adileo/squirreldisk) —— Tauri + Rust 实现参考
  - [SpaceSniffer](http://www.uderzo.it/main_products/space_sniffer/) —— treemap 可视化先驱
  - [Tauri](https://tauri.app)、[`d3-hierarchy`](https://github.com/d3/d3-hierarchy)、[`jwalk`](https://github.com/jessegrosjean/jwalk)、[`ntfs`](https://github.com/ColinFinck/ntfs)、[`globset`](https://github.com/BurntSushi/ripgrep/tree/master/crates/globset)、[`trash-rs`](https://github.com/Byron/trash-rs) —— 站在巨人的回收站盖子上
- **Scaffold 起源**
  - [CleanMyWechat](https://github.com/blackboxo/CleanMyWechat) —— 微信 3.x 清理脚本范本，messaging.md 的 P0/P1 盘点参考它
  - 各家 App 官方文档与社区调研报告（详见 [`docs/scaffold-requirements/`](docs/scaffold-requirements/)）
- **协作与工作流**
  - [Claude Code](https://claude.com/claude-code) —— 仓库内 14-phase scaffold authoring SOP 由它驱动
  - [@jtlyu](https://github.com/jtlyu) —— WeChat 4.x 重写、性能 88× 提速、conda env UI、scaffold harness 工作流基建

---

## License

[MIT](LICENSE) · 欢迎 fork、商用、闭源衍生。但 **scaffold safety test 是社会契约**——你 fork 后改 scaffold，请保持 safety test 同步更新。删红线断言换"看起来更激进的清理"是我们专门防的失败模式。

---

<p align="center">
<sub>用 <span style="color:#ff69b4">❤️</span> 写于 2026 · 喜欢就给个 ⭐ 让搜索引擎知道<br/>"WizTree 的速度 + AI 解释 + 可贡献规则"这条路有人走</sub>
</p>
