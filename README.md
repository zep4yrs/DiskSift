<div align="center">

<img src="apps/desktop/src-tauri/icons/128x128.png" alt="DiskSift" width="96" height="96">

# DiskSift

**筛出你盘里能清的。** 秒扫 · AI 分诊 · 红线保护 · 一条一条放心删。

> **DiskSift 是 [Pinkbin](https://github.com/cccyd2003-qwq/pinkbin)（MIT）的重构发行版**：保留其全部安全架构（scaffold 红线断言 / 两步确认 / 默认回收站 / undo 台账），前端工作台与视觉完全重塑（IDE 式工作台 · 浏览器式多标签页 · AI 侧板），并新增 AI 分诊图层、脚本中心、定时自动巡查。感谢原作者 cccyd2003-qwq 与贡献者 jtlyu。

开源磁盘清理工具。秒扫整盘看空间分配，AI 分诊把目录按「可清理 / 需决策 / 建议迁移 / 系统」自动上色，已知应用走专属清理脚本按 scope 逐项放心删——默认进回收站，永远不读你的文件内容。当前版本 **v26.1.3.1**。

[![License](https://img.shields.io/badge/License-MIT-24C8DB.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB.svg)](https://tauri.app)
[![Platform](https://img.shields.io/badge/Windows-lightgrey.svg)](#下载)
[![Release](https://img.shields.io/badge/Release-v26.1.3.1-005FB8.svg)](#下载)

[下载](#下载) · [看效果](#看效果) · [四件事](#四件事) · [安全](#安全怎么做) · [怎么用](#怎么用) · [架构](#架构) · [路线图](#路线图) · [参与贡献](#参与贡献) · [致谢](#致谢)

**简体中文 | [English](README_EN.md)**

</div>

---

## 💎 赞助商 · Sponsor

<div align="center">

<a href="https://api.novadiffusion.com/"><img src="docs/sponsors/novadiffusion.png" alt="NovaDiffusion API — 全网最靠谱、最安全、几乎最实惠的满血 Claude / GPT" width="760"></a>

**全网最靠谱、最安全、几乎最实惠的满血 Claude / GPT** · 👉 **[api.novadiffusion.com](https://api.novadiffusion.com/)**

</div>

---

## 下载

<p align="center">
  <a href="https://github.com/Map1eBr1dge/DiskSift/releases/latest"><img src="https://img.shields.io/badge/⬇_下载最新版_(Windows)-005FB8?style=for-the-badge&logo=windows&logoColor=white" height="42"></a>
</p>

| 平台 | 文件 | 备注 |
|---|---|---|
| **Windows 10 / 11 (x64)** | [`DiskSift_x.x.x_x64-setup.exe`](https://github.com/Map1eBr1dge/DiskSift/releases/latest)（NSIS）<br>[`DiskSift_x.x.x_x64_en-US.msi`](https://github.com/Map1eBr1dge/DiskSift/releases/latest)（MSI） | 首次启动 SmartScreen 拦截：点"更多信息"→"仍要运行"。NTFS MFT 直读需要管理员权限，安装包带 manifest 自动 UAC |

> 国内镜像：[CNB 仓库](https://cnb.cool/feng-qiao/DiskSift) 同步发布。macOS / Linux 暂无预编译版（签名 + 真机验证未就绪），可自行 `pnpm tauri build`。

---

## 看效果

<p align="center">
  <img src="docs/screenshots/hero.png" alt="IDE 式工作台 · 空间图 treemap + 树视图 + AI 侧板" width="100%">
</p>

<p align="center"><sub>IDE 式工作台 · 左：资源管理器树（每行占用圆环 + 判定色条）· 中：空间图 treemap（判定染色 / 单击详情卡 / 双击下钻）· 右：AI 侧板 · 顶带三区域可独立折叠 · 底部 输出/诊断/记录 三面板</sub></p>

<p align="center">
  <img src="docs/screenshots/triage.png" alt="AI 分诊 · 五桶分诊报告 + 一键全部回收" width="100%">
</p>

<p align="center"><sub>扫描诊断 · 按风险与可清性分 5 桶，「100% 可清」桶支持一键全部回收（两步确认，全部进回收站可还原）</sub></p>

<p align="center">
  <img src="docs/screenshots/dark.png" alt="暗色主题 · dark_modern 色板" width="100%">
</p>

---

## 四件事

简单、简单、简单，以及**看得见的安全**。

### 1. 把磁盘空间分配看清楚

Windows 上直读 NTFS Master File Table（其他平台 jwalk 兜底），整盘 C: **2–5 秒**扫完。空间图 treemap 与树视图**双向同步导航**——图上双击下钻，树自动展开跟随；树里点目录，图跟着换根。每个目录带占用圆环、判定色条、AI 聚合徽标。

### 2. AI 分诊：看不懂的目录让 AI 按桶分类

拖任意文件夹给 AI（或整盘批量分诊），AI 按 **可清理 / 需决策 / 建议迁移 / 系统 / 不确定** 五判定上色，图、树、巡查报告三处同步。「只看可清理」一键聚焦；可清理但没脚本覆盖的目录，AI 直接**起草清理脚本**并自动跑红线检查，不过线不许保存。

BYOK——Anthropic / OpenAI / Gemini / Ollama 四协议，内置**免费接入引导**（本地 Ollama · GLM-4-Flash 官方免费档 · 硅基流动免费模型），点开直达设置页。**DiskSift 只发目录元数据**（路径、大小、文件数、扩展名占比、≤20 条抽样路径）——**永远不读文件内容**。

### 3. 已知应用走专属清理脚本（脚本中心）

**36 个内置清理脚本**（浏览器缓存 / 开发工具链 / IM / 云盘 / 游戏平台…），每份都是 TOML 清单 + 红线集成测试。脚本中心支持启用/停用、TOML 导入导出（导入自动过红线检查）。代表脚本：

- **微信 PC**（3.x + 4.x 双兼容）—— 清缓存/接收媒体，永不动聊天 DB / 收藏 / 朋友圈
- **Conda / pip / npm / pnpm / Cargo / Go / Gradle / Maven / NuGet** —— 各语言包管理缓存
- **Chrome / Edge / Firefox / Brave** —— 浏览器缓存（保留登录态）
- **Docker / HuggingFace** —— 镜像缓存与模型仓库

### 4. 定时自动巡查

注册 Windows 计划任务，后台无头巡查：只动「安全（safe）」目录、移入回收站（可还原）、写操作台账后退出。频率每小时 / 每天 / 每周日 / 每月，随时可关。

---

## 安全怎么做

- **NEVER_TOUCH 双层防线**：系统保护区清单（Windows / Program Files / Recovery / 用户文档…）前端 segment 边界匹配 + **Rust executor 执行层整单 fail-closed 拒绝**——就算 UI 出 bug，底层也不执行
- **账号 fail-closed**：清理弹窗取消全部账号勾选 = 整单拒绝，绝不"不过滤=全清"
- **默认回收站**：所有删除进系统回收站可还原；每一次操作写 `undo.jsonl` 台账，操作记录页可按天回溯、可还原
- **两步确认**：所有批量/危险动作首击进入预备态，再击才执行
- **隐私红线**：AI 只收元数据，永不上传文件内容；API Key 走 Windows DPAPI 加密存本机

---

## 怎么用

1. **下载安装**（上面），双击安装
2. **左侧活动栏底部 ⚙ 配 AI**——填 API Key，或按引导接免费模型（不配也能用规则分诊）
3. **入口页选磁盘 → 点「扫描」**——几秒后空间图 + 树就出来了
4. **看图**：双击下钻、面包屑回退、图/树自动互随；「AI 分诊」一键批量上色
5. **清理**：巡查页按桶审阅（或「一键全部回收」）；脚本库挑已知应用按 scope 清；删错去操作记录页还原

---

## 架构

> 想看人话解释（不堆术语，普通用户也能看懂）：📖 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**

```
┌────────────────────┐     ┌─────────────────────┐
│   React + Tauri    │────>│  Rust workspace     │
│   (前端 UI)         │<────│  (4 crates)         │
└────────────────────┘     └──────────┬──────────┘
                                      │
        ┌─────────────────┬───────────┼──────────────┬──────────────┐
        │                 │           │              │              │
   ┌────▼────┐    ┌──────▼─────┐  ┌──▼──────┐  ┌────▼────┐  ┌──────▼──────┐
   │ scanner │    │  scaffold  │  │executor │  │advisor  │  │scaffold-lint│
   │ NTFS MFT│    │ TOML 加载   │  │Recycle/ │  │AI 顾问   │  │ CI 校验     │
   │ + jwalk │    │ + globset  │  │Quarant. │  │4 协议   │  │              │
   └─────────┘    └────────────┘  └─────────┘  └─────────┘  └─────────────┘
```

| 层 | 技术栈 |
|---|---|
| 前端 | React 18 + TypeScript + Tauri 2 + react-markdown（IDE 工作台 · 浏览器式多标签） |
| 后端 | Rust workspace（4 crates）+ Tauri IPC |
| 扫描器 | Windows: NTFS MFT 直读（`ntfs` crate）/ 跨平台: `jwalk` |
| AI | BYOK · Anthropic · OpenAI · Gemini · Ollama 四协议 · response_format 自动回退兼容 |
| 数据 | 用户本机 `~/.pinkbin/`（undo.jsonl + quarantine/ + secure.json + triage-cache.json）· 不上云 |

---

## 路线图

- [x] 整盘秒扫 + 空间图 treemap / 树视图双向同步导航
- [x] AI 分诊图层（规则秒判 + AI 批量分诊 + 详情卡 + 免费接入引导）
- [x] 脚本库 36 个 + 脚本中心（启用停用 / TOML 导入导出 / AI 起草脚本过红线）
- [x] 定时自动巡查（Windows 计划任务，safe-only）
- [x] 撤销中心按天分组、一键还原；API Key DPAPI 加密
- [ ] 实时监控（USN Journal，目录变化即时感知）→ v26.1.4.0
- [ ] 跨平台安装包矩阵（macOS / Linux，签名 + 真机验证后）→ v26.1.5.0
- [ ] BlueTidy 姐妹产品深链：「建议迁移」目录一键搬到另一块盘

版本规则：`年份后两位.破坏性 +1 . 新功能 +1 . 补丁 +1`（详见 [VERSIONING.md](VERSIONING.md)）。

---

## 参与贡献

最有价值的贡献是**写新的清理脚本**。每加一个 App 支持就是一份 PR：

1. 在 [`docs/scaffold-requirements/`](docs/scaffold-requirements/) 写需求文档（红线清单：聊天 DB？账号 key？用户收藏？）
2. 在你机器上跑这个 App，列出真实目录结构，找出 cache vs 用户数据的边界
3. 抄 [`scaffolds/_templates/scaffold.toml`](scaffolds/_templates/scaffold.toml) 写 TOML
4. 抄 [`crates/scaffold/tests/_templates/scaffold_safety.rs`](crates/scaffold/tests/_templates/scaffold_safety.rs) 写 safety test（**正向断言 + 红线断言**，CI 必跑，没测试不收）
5. `pnpm tauri dev` 目视确认
6. 提 PR

详细流程：[`.claude/commands/add-scaffold.md`](.claude/commands/add-scaffold.md)。

### 开发

```bash
git clone https://github.com/Map1eBr1dge/DiskSift.git && cd DiskSift
pnpm install
pnpm tauri dev            # 桌面 app（首次编译 Rust 依赖，5-15 分钟）
pnpm -C apps/desktop dev  # 仅前端，浏览器调试，mock 后端
cargo test --workspace    # 全工作空间测试
pnpm -C apps/desktop test # 前端引擎测试（分诊/树/清理规则）
```

需要 **Node 20+ · pnpm 9+ · Rust stable · Tauri 前置依赖**（Windows 上是 VS Build Tools 2022 + WebView2）。

---

## 致谢

- **上游**：[Pinkbin](https://github.com/cccyd2003-qwq/pinkbin)（MIT）—— DiskSift 的安全架构（scaffold 红线 / 两步确认 / undo 台账）与最初实现全部继承自它，感谢 cccyd2003-qwq
- **灵感来源**
  - [WizTree](https://diskanalyzer.com) —— NTFS MFT 直读思路与速度标杆
  - [SpaceSniffer](http://www.uderzo.it/main_products/space_sniffer/) —— treemap 可视化先驱
  - [CleanMyWechat](https://github.com/blackboxo/CleanMyWechat) —— 微信清理脚本范本
  - [SquirrelDisk](https://github.com/adileo/squirreldisk) —— Tauri + Rust 实现参考
- **依赖巨人的肩膀**：[Tauri](https://tauri.app) · [`d3-hierarchy`](https://github.com/d3/d3-hierarchy) · [`jwalk`](https://github.com/jessegrosjean/jwalk) · [`ntfs`](https://github.com/ColinFinck/ntfs) · [`globset`](https://github.com/BurntSushi/ripgrep/tree/master/crates/globset) · [`trash-rs`](https://github.com/Byron/trash-rs) · [react-markdown](https://github.com/remarkjs/react-markdown) · [Lucide](https://lucide.dev)
- **协作**：[@jtlyu](https://github.com/jtlyu)（性能优化 + WeChat 4.x 重写 + scaffold harness 工作流基建）

---

## License

[MIT](LICENSE) · 欢迎 fork、商用、闭源衍生。改 scaffold 时记得同步改它的 safety test——红线断言是防止误删用户数据的最后一道闸。
