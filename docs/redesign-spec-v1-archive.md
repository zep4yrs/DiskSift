# 前端重塑规格：VS Code Workbench 骨架 × SiteLens 4.0 桌面版血统

> 状态：方向已定（用户 2026-09-27 拍板：骨架=VS Code workbench，血统=SiteLens 4.0 桌面版极简克制风）。
> 血统实测来源：`SiteLens 桌面版源码 web/css/app.css`（4.0 样式重构版，非 v0.0.1 demo）。
> 硬约束：**能力零删除**——现有组件全部保留，只换外壳、令牌与信息架构。
> 本文件是重构期间唯一事实来源；落地后追加"豁免清单"与"实施差异记录"。

## 1. 血统（SiteLens 4.0 令牌，实测值照搬）

### Light
```
--background:#fafafa; --foreground:#1a1a1a;
--primary:#3e3f3f; --primary-fg:#ffffff;          /* 主按钮是灰色——克制的核心 */
--secondary:#f1f5f9; --muted:#f8fafc; --muted-fg:#64748b;
--accent:#f1f5f9; --border:#e2e8f0; --input:#ffffff;
--ring:#3e3f3f; --card:#ffffff; --radius:.35rem;
--ok:#16a34a; --warn:#d97706; --danger:#dc2626; --info:#2563eb;
```
### Dark（碳黑中性，不是蓝）
```
--background:#0d0d0f; --foreground:#ececf1;
--primary:#e0e0e3; --primary-fg:#111113;          /* 暗色主按钮是白 */
--secondary:#1c1c20; --muted:#1c1c20; --muted-fg:#9b9ba4;
--accent:#26262b; --border:#26262b; --input:#141417; --ring:#9b9ba4; --card:#141417;
```
### 4.0 补齐的刻度（必须一并移植）
```
--radius-sm:6px; --radius-md:10px; --radius-lg:14px; --radius-pill:999px;
--space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px; --space-5:22px; --space-6:30px;
--shadow-1:0 1px 2px rgba(15,23,42,.06),0 1px 3px rgba(15,23,42,.08);
--shadow-2:0 2px 4px rgba(15,23,42,.06),0 4px 12px rgba(15,23,42,.08);
--shadow-3:0 6px 16px rgba(15,23,42,.10),0 12px 32px rgba(15,23,42,.10);
--ring-w:2px; --fw-normal:400; --fw-strong:600;
```
### 字体
`--font-sans:"LXGW WenKai","Noto Sans SC","Source Han Sans SC",-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif`（霞鹜文楷 CDN 按需 + 断网回退；沿用 SiteLens「去掉未使用字重」的降重经验）；`--font-mono` 用 SiteLens 同款栈。正文 15px / 1.6；`html[data-fs]` 字号档位（sm 13.5 / lg 16.5 / xl 18）照搬。

### 废除项
2.5px 墨线描边、5px/8px 硬投影、粉色系全部、12-16px 大圆角、Google Fonts 在线 @import、treemap 粉色色板（换 slate 渐进中性色板）、像素画旧配色。

## 2. 骨架（VS Code Workbench 五区，用户选定）

| 区 | 内容 |
| --- | --- |
| **Activity Bar**（左 icon rail 48px） | 概览 / 空间地图 / 巡查 / 清理脚本 / AI 顾问 / 操作记录；底部：设置、主题切换；活动项左缘 2px `--primary` 强调条（SiteLens .top-nav a.active::before 的手法） |
| **Side Bar**（260px 可折叠） | 随视图切换（见 §3）；`--card` 底 + 1px `--border` 分隔 |
| **Editor Area**（中央 tab 化） | 各视图主内容；地图视图含 树↔Treemap 双 tab（SiteLens .tabs/.tab.active 底边 2px 手法） |
| **Bottom Panel**（可折叠） | 扫描进度（8px pill progressbar）、诊断条、操作记录简表 |
| **Status Bar**（24px） | 根路径 · 总量/文件数 · AI provider · 脚本数 · 版本号（mono 11px，SiteLens .ver 手法） |

品牌区沿用 SiteLens 手法：mono 粗体 brand + `--ok` 色呼吸圆点（.dot，sl-breathing 动画）。

## 3. 组件词汇（SiteLens 4.0 照搬，重构时直接对齐）

`.btn`（primary/ghost/small/danger；:active translateY(2px)）、`.card`（radius-md + shadow-1）、`.cell` 摘要格、`.badge`（语义色 color-mix 8% 底 + 35% 边框）、`table.list`（表头 muted 60% 底、行 hover、55% hairline 行线）、`.progressbar`、`.skeleton` shimmer、`.empty`、`.tabs/.tab`、`.chip`、`.toast`、`.sec-title`（mono 16px）、`:focus-visible` outline 2px `--ring`（全站键盘可达）。

## 4. 六视图定义（能力零删除映射）

| 视图 | Side Bar | Editor Area | 承接组件 |
| --- | --- | --- | --- |
| 概览 | 卷信息大数字 | 扫描入口、分诊五桶摘要卡、诊断摘要 | volume_info、triage 摘要、DiagnosticsBar |
| 空间地图 | TreeView（explorer） | Treemap↔列表 双 tab + 面包屑 | TreeView、Treemap、ContextMenu、拖拽 |
| 巡查 | walkQueue 进度 n/N、已释放 | TriageView 分桶 → AutoWalk 卡片流 | TriageView、AutoWalk、ScaffoldPanel、AdvisorCard |
| 清理脚本 | scaffold 卡片列表（检测态） | 卡片展开详情 + CleanupModal 入口 + Steam 工具卡 | Studio、CleanupModal、SteamInspector* |
| AI 顾问 | 当前聚焦对象卡 | ChatPanel 全量（多轮/图片/总览） | ChatPanel、AdvisorCard |
| 操作记录 | 筛选（动作/时间） | undo.jsonl 表格；隔离条目一键还原（源存在则阻断）；回收站条目引导 | 后端新增 list/restore 命令 |

Modal 全保留（CleanupModal dry-run 预览、Settings、SteamInspectorModal）。两步确认纪律全量保留；树视图右键删除（#22①）新增时必须走 armed 模式。

## 5. 工程纪律（血）

1. 令牌纪律：组件只消费语义令牌；硬编码颜色/阴影登记到"豁免清单"。
2. CSS 文件分层注释（令牌/基础/外壳/组件/页面差异），学 app.css 的组织方式。
3. 不引入 Tailwind/组件库；vanilla CSS + 语义令牌。
4. 门禁：tsc + vite build + cargo test --workspace + scaffold-lint + 复核员通读（能力零删除核对）。

## 6. 落地顺序（第三波）

1. 令牌层 + 基础元素 + 品牌区 → 2. Workbench 五区骨架 + 路由 → 3. 六视图迁移（逐视图 tsc）→ 4. 操作记录后端 + Rust 三处 low 修补 + top-K 回归测试 → 5. 深色硬编码审计 → 6. 五道门禁 + 复核 + 报告。

## 7. 豁免清单

（登记纪律见 §5.1：组件只消费语义令牌；以下是未能令牌化的残留，逐条给出理由与去向。第三波换血落地时登记。）

### 7.1 本次换血新增（styles.css §4 组件词汇层）

| 位置 | 值 | 理由 / 去向 |
| --- | --- | --- |
| `.btn.danger.armed`（含 :hover） | `#c43358` / `#fff` / `#8a1d3a` | 两步确认 armed 语义红，与 §5 遗留层 `.cleanup-execute.armed` 同源同值；随 armed 家族在深色审计时统一令牌化（候选：--danger 深色变体） |

### 7.2 styles.css §5 遗留层既有字面量（原样保留 + 机械替换后仍存；六视图迁移逐类替换时清除）

| 位置 | 值 | 理由 |
| --- | --- | --- |
| `.bucket-actions .primary.armed` / `.cleanup-execute.armed` / `@keyframes pulse-armed` | `#c43358` / `#8a1d3a` / `rgba(196,51,88,.5→0)` | armed 两步确认语义红（含脉冲光晕）；红底/白字在明暗两模式均可读 |
| `.studio-scope-btn.armed`（含 :hover） | `#d94862` / `#c43757` | armed 家族变体 |
| `.progress-button.is-error` | `#fff`（红底 `var(--danger)` 上的文字） | 语义：danger 红底白字，明暗两模式均需白字 |
| ~~`.cleanup-disclaimer`、`.cleanup-row.within-retention`、`.cleanup-coverage-row.protected`、`.steam-row.ghost` / `.steam-ghost-banner`~~ | **已修复除名**（第二轮复核·深色审计）：改语义色 color-mix（warn/info 8–10% 底、35–45% 边，badge 同款配方），明暗自适应 | 修复优于登记 |
| ~~`var(--text-muted, #888)`~~ | **已修复除名**：别名桥补 `--text-muted: var(--muted-fg)`，`#888` 回退不再生效 | 修复优于登记 |

### 7.3 未改动文件的既有内联色（非本次新增；落地顺序第 5 步「深色硬编码审计」统一处理）

| 位置 | 内容 |
| --- | --- |
| `TreeView.tsx` FolderGlyph / FileGlyph | 内联 SVG 文件/文件夹图标配色（fill/stroke hex 数处） |
| `triage.ts` BUCKET_META `tone` | 五桶语义色，经 TriageView 内联 `borderColor` 使用 |
| `AdvisorCard.tsx` | risk 分级内联色 |
| `ChatPanel.tsx`（AdviceCard） | risk 内联色 |
| `ScaffoldPanel.tsx` | risk 内联色 |
| ~~`ErrorBoundary.tsx`~~ | **已修复除名**（第二轮复核·深色审计）：`#a40036`/`#fff0f5`（后者兼属废除的粉色系）改 `var(--danger)` / `color-mix(danger 6%, var(--background))` |
