<div align="center">

<img src="apps/desktop/src-tauri/icons/128x128.png" alt="DiskSift" width="96" height="96">

# DiskSift

**筛出你盘里能清的。**

秒扫整盘 · AI 分诊上色 · 已知应用脚本清 · 红线双层兜底 —— 默认进回收站，永远不读你的文件内容。

[![License](https://img.shields.io/badge/License-MIT-24C8DB.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB.svg)](https://tauri.app)
[![Platform](https://img.shields.io/badge/Windows%2010%2F11-lightgrey.svg)](#快速开始)
[![Release](https://img.shields.io/badge/Release-v26.1.3.1-005FB8.svg)](#快速开始)

**下载** · [看它长什么样](#它长什么样) · [和 Pinkbin 什么关系](#和-pinkbin-什么关系) · [四件事](#四件事) · [安全模型](#安全模型) · [从源码构建](#从源码构建)

**简体中文 | [English](README_EN.md)**

</div>

---

## 它长什么样

<p align="center">
  <img src="docs/screenshots/hero.png" alt="Trae 式工作台：空间图 treemap + 判定染色 + 树视图 + AI 侧板" width="100%">
</p>

扫完 C 盘的第一眼：中间是空间图 treemap（蓝色竖条 = AI/规则判定染色，绿色徽标 = 可清理聚合），左边资源管理器树每行带占用圆环——**图上双击下钻，树自动跟着展开；树里点目录，图跟着换根**。右边 AI 侧板随时回答"这是什么、能不能删"。

<p align="center">
  <img src="docs/screenshots/triage.png" alt="AI 分诊：五桶分诊报告 + 一键全部回收" width="100%">
</p>

扫描完自动出分诊报告：按「可清理 / 需决策 / 建议迁移 / 系统 / 不确定」分五桶。「100% 可清」桶里 Edge、Chrome、pnpm、pip 这些缓存**一键全部回收**——两步确认，全部进回收站，可还原。

<p align="center">
  <img src="docs/screenshots/dark.png" alt="暗色主题" width="100%">
</p>

---

## 和 Pinkbin 什么关系

直说：**DiskSift 是 [Pinkbin](https://github.com/cccyd2003-qwq/pinkbin)（MIT）的二次发行版**。Pinkbin 打好了最好的底子——NTFS MFT 秒扫、scaffold 红线测试、undo 台账、默认回收站，这些一字未动全部继承，感谢原作者 cccyd2003-qwq。

DiskSift 在这个底子上做了三件事：**前端整个重做、AI 从问答升级成分诊系统、安全兜底下沉到执行层**。逐项对照：

| | Pinkbin | DiskSift |
|---|---|---|
| **工作台** | 三栏布局 | Trae 式五区工作台 · 浏览器式多标签页 · 三区域独立折叠 |
| **空间认知** | treemap / 树各自独立 | 图树**双向同步导航** · 占用圆环 · 面包屑下钻 |
| **AI** | 拖文件夹问答 | **五判定分诊图层**：批量分诊 · 全站染色 · 只看可清理 · 聚合徽标 · AI 起草脚本（过红线才许保存） |
| **清理脚本** | 2 个（微信/Conda） | **36 个** + 脚本中心（启用停用 · TOML 导入导出过红线） |
| **自动化** | — | 定时自动巡查（Windows 计划任务，safe-only 无头运行） |
| **防误删** | UI 层保护区清单 | **前端 + Rust 执行层双层 fail-closed**（UI 出 bug 底层也不执行） |
| **撤销** | undo.jsonl | + 按天分组撤销中心 · 可视化还原 |
| **密钥** | 明文 localStorage | Windows **DPAPI 加密** |

版本自成一系：`年份后两位.破坏性+1.新功能+1.补丁+1`，当前 **v26.1.3.1**（[VERSIONING.md](VERSIONING.md)）。

---

## 四件事

### 1. 秒扫 + 图树联动

直读 NTFS Master File Table（`ntfs` crate），整盘 C: **2–5 秒**出图；非 NTFS 卷 jwalk 兜底。treemap 单击看详情卡、双击下钻、面包屑逐段回退，窄侧栏自动收列，树支持完整键盘导航。

### 2. AI 分诊

整盘批量分诊或拖单个文件夹细问。AI 只收**目录元数据**（路径、大小、文件数、扩展名占比、≤20 条抽样路径）——**永远不读文件内容**。BYOK 四协议（Anthropic / OpenAI / Gemini / Ollama），内置免费接入引导：本地 Ollama · GLM-4-Flash 官方免费档 · 硅基流动免费模型，点开直达设置页（不兼容 `response_format` 的端点自动回退重试）。

### 3. 脚本中心

36 个内置脚本覆盖浏览器、开发工具链、IM、云盘、游戏平台。每份脚本 = TOML 清单 + **红线集成测试**（聊天 DB、账号、收藏绝不进清理面）。可清理但没脚本覆盖的目录，AI 按 14-phase 裁剪版**起草脚本**，自动跑红线检查，不过线直接拒绝。

### 4. 定时自动巡查

Windows 计划任务无头运行：只动「安全」桶、移入回收站、写台账、退出。每小时 / 每天 / 每周日 / 每月。

---

## 安全模型

删文件的软件，信任成本全在防线上。DiskSift 的防线分五层：

| 层 | 机制 |
|---|---|
| **清单层** | 每个脚本两份断言：正向（该清的能命中）+ 红线（聊天 DB / 账号 / 收藏绝不命中），CI 必跑 |
| **引擎层** | NEVER_TOUCH 保护区（Windows / Program Files / Recovery / 用户文档…）segment 边界匹配，`C:\Windows` 与 `C:\WindowsExcl` 分得清 |
| **执行层** | Rust executor 对每条计划复跑保护区检查，命中**整单 fail-closed 拒绝**——前端 UI 出任何 bug，底层也不执行 |
| **动作层** | 默认系统回收站（可还原）；批量/危险动作两步确认；隔离区可选保留期 |
| **台账层** | 每次操作写 `undo.jsonl`，撤销中心按天分组一键还原 |

账号维度同样 fail-closed：清理弹窗取消全部账号勾选 = **整单拒绝**，不存在"不过滤=全清"。API Key 走 Windows DPAPI 加密，只存本机。

---

## 快速开始

1. 从 [Releases](https://github.com/Map1eBr1dge/DiskSift/releases/latest) 下载 `DiskSift_x.x.x_x64-setup.exe`（或 MSI）。SmartScreen 拦截时点"更多信息 → 仍要运行"；MFT 直读需要管理员，安装包已带 manifest 自动 UAC
2. 左侧活动栏底部 **⚙** 配 AI——或按引导接免费模型（不配也能用规则分诊，功能不瘫）
3. 入口页选磁盘 → **扫描**
4. 图上探索，巡查页按桶清理，删错去操作记录页还原

> 国内镜像：[CNB 仓库](https://cnb.cool/feng-qiao/DiskSift) 同步发布。

---

## 从源码构建

```bash
git clone https://github.com/Map1eBr1dge/DiskSift.git && cd DiskSift
pnpm install
pnpm tauri dev            # 桌面 app（首次编译 Rust 依赖 5-15 分钟）
pnpm -C apps/desktop dev  # 仅前端，浏览器调试，mock 后端
cargo test --workspace        # Rust 全工作空间测试
pnpm -C apps/desktop test # 前端引擎测试（分诊/树/清理规则）
```

需要 **Node 20+ · pnpm 9+ · Rust stable · Tauri 前置依赖**（Windows：VS Build Tools 2022 + WebView2）。

---

## 路线图

- [ ] **v26.1.4.0** 实时监控：USN Journal 感知目录变化
- [ ] **v26.1.5.0** 跨平台安装包矩阵（签名 + 真机验证后）
- [ ] 「建议迁移」目录一键搬到另一块盘（姐妹产品深链）
- [ ] macOS 签名证书

---

## 致谢

DiskSift 站在 [Pinkbin](https://github.com/cccyd2003-qwq/pinkbin) 的肩膀上——安全架构与最初实现全部继承自它。

灵感：[WizTree](https://diskanalyzer.com)（MFT 直读标杆）· [SpaceSniffer](http://www.uderzo.it/main_products/space_sniffer/)（treemap 先驱）· [CleanMyWechat](https://github.com/blackboxo/CleanMyWechat)（微信清理范本）· [SquirrelDisk](https://github.com/adileo/squirreldisk)（Tauri 参考）· [Trae](https://trae.ai)（工作台设计语言）

肩膀：[Tauri](https://tauri.app) · [d3-hierarchy](https://github.com/d3/d3-hierarchy) · [jwalk](https://github.com/jessegrosjean/jwalk) · [ntfs](https://github.com/ColinFinck/ntfs) · [globset](https://github.com/BurntSushi/ripgrep/tree/master/crates/globset) · [trash-rs](https://github.com/Byron/trash-rs) · [react-markdown](https://github.com/remarkjs/react-markdown) · [Lucide](https://lucide.dev)

协作：[@jtlyu](https://github.com/jtlyu)（上游性能优化 + WeChat 4.x 重写 + scaffold harness 基建）

---

## 赞助商 · Sponsor

<div align="center">

<a href="https://api.novadiffusion.com/"><img src="docs/sponsors/novadiffusion.png" alt="NovaDiffusion API — 全网最靠谱、最安全、几乎最实惠的满血 Claude / GPT" width="640"></a>

**全网最靠谱、最安全、几乎最实惠的满血 Claude / GPT** · 👉 **[api.novadiffusion.com](https://api.novadiffusion.com/)**

</div>

---

## License

[MIT](LICENSE) · 欢迎 fork、商用、闭源衍生。改 scaffold 时记得同步改它的 safety test——红线断言是防止误删用户数据的最后一道闸。
