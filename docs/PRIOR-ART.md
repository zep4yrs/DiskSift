# 现有产品调研

> **这个文档存在的意义**:避免新加入的开发者重复走我们的弯路 (WizTree → CCleaner → 4DDiG → ai-disk-cleanup)。
> **结论**:市场上**没有现成产品 100% 解决我们的问题**。

---

## 一、商业 / 主流产品对照

匹配度评分(1-5)针对本项目的需求(见 [REQUIREMENTS.md](REQUIREMENTS.md)),不代表产品自身好坏。

| 产品 | 流派 | 核心能力 | 业务类别识别 | 半自动批量删 | 平台 | 匹配度 |
|------|------|---------|:---:|:---:|------|:--:|
| **WizTree** | 树状图可视化 | 按 MFT 极速扫描,显示文件夹大小 | ❌ | ❌ | Win | ⭐⭐ |
| **FreeUpDisk** | 树状图可视化 | WizTree 跨平台克隆版 | ❌ | ❌ | Win+Mac | ⭐⭐ |
| **TreeSize Pro** | 树状图 + 扩展名分组 | 在 WizTree 基础上加按文件类型分组 | ⚠️ 仅扩展名 | ✅ | Win | ⭐⭐⭐ |
| **WinDirStat / SpaceSniffer** | 树状图 | 老牌可视化 | ❌ | ❌ | Win | ⭐⭐ |
| **DaisyDisk** | 树状图(Mac) | Mac 上颜值最高 | ❌ | ⚠️ | Mac | ⭐⭐ |
| **CCleaner** | 系统垃圾清理 | 老牌缓存 / 注册表 | ❌ | ⚠️ | Win+Mac | ⭐ |
| **Cleaner One Pro** | 系统垃圾清理 | CCleaner 流派 + 噱头 AI | ❌ | ⚠️ | Win | ⭐ |
| **4DDiG** | 数据恢复 | 主业是误删找回 | ❌ | ❌ | Win+Mac | ⭐ |
| **Bulk Crap Uninstaller** | **应用盘点 + 批量卸载** | 扫已装程序 / Steam / Epic,批量卸 | ✅ 应用类 | ✅ | Win | ⭐⭐⭐⭐ |
| **Revo Uninstaller** | 应用卸载器 | 同 BCU 商业版 | ✅ 应用类 | ✅ | Win | ⭐⭐⭐ |
| **[ai-disk-cleanup](https://github.com/CoderDayton/ai-disk-cleanup)**(开源) | LLM 语义识别 | 元数据发给 LLM 做语义分类 | ✅ 含开发环境 | ✅ | 跨平台 | ⭐⭐⭐⭐ |

---

## 二、GitHub `disk-cleaner` topic (TypeScript) 调研

截至 **2026-04-29**,共 6 个项目。大多是早期玩具项目:

| 项目 | ★ | 技术栈 | 核心定位 | 评估 |
|------|:--:|------|---------|------|
| [ozankasikci/rust-disk-cleaner](https://github.com/ozankasikci/rust-disk-cleaner) | 19 | Tauri + React | 通用清理(README 极简) | 唯一有点星数,但功能不明 |
| [samridhi611/nodeclear](https://github.com/samridhi611/nodeclear) | 1 | Electron + React | 专攻 `node_modules`/`dist` 残留 | 思路对,覆盖窄 |
| [thanhnv1808/LCCleanTool](https://github.com/thanhnv1808/LCCleanTool) | 1 | Electron + Vite | macOS 缓存 / `node_modules` / 大文件 | 安全设计好(走 Trash) |
| [Divish1032/junk-cleaner](https://github.com/Divish1032/junk-cleaner) | 1 | Tauri + Ollama | **本地 LLM 离线智能分析** | **理念最贴近本项目**,但仅原型 |
| [Jaden1387/cpa-clean](https://github.com/Jaden1387/cpa-clean) | 1 | Next.js | cPanel 服务器清理(跑题) | 标签错挂 |
| [gatteo/cluttered](https://github.com/gatteo/cluttered) | 0 | TypeScript | "好看的开发者磁盘清理器" | 描述模糊 |

---

## 三、关键洞察

1. **市场上没有"按业务类别盘点"的成熟产品**。商业产品分两派——"清垃圾"(CCleaner 流派)和"画树状图"(WizTree 流派)——都不在我们要做的方向上。

2. **唯一接近的开源探索是 [ai-disk-cleanup](https://github.com/CoderDayton/ai-disk-cleanup) 和 [junk-cleaner](https://github.com/Divish1032/junk-cleaner)**——均是 LLM-driven。前者已可用(Python CLI 报告),后者更激进(本地 Ollama)但仍是原型。

3. **应用卸载和文件盘点是两条不同的技术路径**。BCUninstaller 解决前者完美,后者还无人填坑。我们要把这两条路径**统一到一个工作流**里。

4. **TypeScript 生态在磁盘清理领域几乎空白**,大多 macOS 优先,Windows 用户选择极少。

---

## 四、定位声明

| 本项目 | ≠ | 因为 |
|--------|---|------|
| 本项目 | ≠ CCleaner | 我们不清缓存 |
| 本项目 | ≠ WizTree | 我们不只画图 |
| 本项目 | ≠ Duplicate Cleaner | 我们不查 hash |
| 本项目 | ≠ 4DDiG | 我们不做恢复 |
| 本项目 | ≠ ai-disk-cleanup | 我们更聚焦半自动 UX,不止于 CLI 报告 |

> **本项目 ≈ BCUninstaller + ai-disk-cleanup + 一个像 DaisyDisk 一样好用的 UI**
