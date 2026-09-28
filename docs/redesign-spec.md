# 前端重塑规格 v2（定稿）：Trae 工作台行为模型 × 浏览器式多 tab

> 状态：交互基准 = v5 HTML 预览（docs/redesign-preview.html），用户五张 Trae 截图为布局目标。
> 硬约束：**能力零删除**；图标一律 Lucide 真图标（从 node_modules/.pnpm/lucide-react@0.577.0*/dist/esm/icons 提取，**禁止手绘 SVG**）；字体系统栈**零 CDN**。
> 交互模型铁律：**活动栏只切侧栏；编辑器是独立的 tab 床；两者零重复。**
> 旧版规格（SiteLens 4.0 令牌 + wave-3 workbench）归档于 docs/redesign-spec-v1-archive.md。

## 1. 色板（Trae light_modern / dark_modern 实测值，本机 theme-defaults 提取）

| Token | Light | Dark | 用途 |
| --- | --- | --- | --- |
| `--chrome` | `#F8F8F8` | `#181818` | 活动栏/侧栏/顶带/底面板/状态栏 |
| `--editor` | `#FFFFFF` | `#1F1F1F` | 编辑区/活动 tab 底 |
| `--fg` | `#3B3B3B` | `#CCCCCC` | 主文字 |
| `--fg-muted` | `#616161` | `#9D9D9D` | 次级文字/图标（表头图标一律此色，禁止染强调色） |
| `--fg-inactive` | `#868686` | `#868686` | 非活动 tab |
| `--border` | `#E5E5E5` | `#2B2B2B` | 唯一描边：1px 分区 hairline |
| `--accent` | `#005FB8` | `#0078D4` | **只用于**：主按钮、活动 tab 顶部 2px 线、活动栏左缘条、焦点环、链接、扫描进度条填充（语义：进行中状态） |
| `--accent-fg` | `#FFFFFF` | `#FFFFFF` | |
| `--hover` | `rgba(0,0,0,.05)` | `rgba(255,255,255,.06)` | hover 单属性变化 |

字体：`"Segoe UI",system-ui,"Microsoft YaHei",sans-serif`；mono: `Consolas,"Cascadia Mono","Microsoft YaHei",monospace`（中文落雅黑，与 styles.css §1 同步）。**禁止在线字体 CDN**。
图标：Lucide 提取（见硬约束）；语义色（ok/warn/danger/info）只用于状态，禁止装饰。

## 2. 骨架与行为（五区独立折叠）

| 区 | 几何 | 内容与行为 |
| --- | --- | --- |
| **顶带** 35px | 品牌（mono 粗体+呼吸点）· 菜单占位（文件/编辑/查看/扫描/帮助）· 区域三开关（**icon-only**：panel-left/panel-bottom/panel-right，选中=白底浮起 shadow-1）· 主题切换 | 开关对应三区独立折叠 |
| **活动栏** 48px | explorer(目录树) / queue(巡查队列) / scripts(脚本列表) / records(记录筛选)；底部 设置 | **只切侧栏**；active=左缘 2px accent |
| **侧栏** 240px 可折叠 | 随活动栏切换的四面板（ explorer=目录树、queue=队列 n/N+已释放+阈值、scripts=脚本卡片列表、records=筛选分段控件） | 分段控件 `.seg`（icon+文字，white-space:nowrap） |
| **编辑器 tab 床** | 浏览器式多 tab：多开/可关/`[＋]`新标签页/`[⌂]`回入口页；活动 tab=editor 底色+顶部 2px accent；每 tab 带类型图标 | tab 种类：空间图(map)/巡查(walk)/脚本详情(script)/操作记录(records) |
| **入口页**（无 tab 时的空态） | 居中：大标题「开始清理 C:」+ 提示行 + **六卡格**（上三下三）：空间图(新扫描)/巡查/脚本库/操作记录/空间图(D:)/设置 | 点卡=开对应 tab；对标浏览器新标签页 |
| **底面板** 150px 可折叠 | tab 化：输出 / 诊断 / 记录(undo 简表) | 扫描时自动展开显示进度 |
| **右 AI 面板** 300px 可折叠 | ChatPanel 全量（多轮/图片/总览）；表头：bot 图标 + 动作图标组（新对话/历史/搜索/关闭） | 对标 TRAE 右面板 |
| **状态栏** 22px | 根路径 · 大小/文件数 · AI provider · 脚本数 · 字号档(A·md) · 版本 | mono 11px |

**独立折叠规则**：侧栏/底面板/右 AI 面板三开关任意组合（用户 Trae 截图五态全部可达）；点活动栏同项=折叠/展开侧栏。

## 3. tab 模型（store）

```
openTabs: { id, kind:'map'|'walk'|'script'|'records', title, crumb? }[]
activeTabId: string | null        // null = 入口页
openTab(kind,title) 去重→激活；closeTab(id)；activateTab(id)
扫描完成 → 自动开/聚焦对应「空间图」tab
侧栏联动：点分诊桶→开巡查 tab；点脚本卡片→开脚本详情 tab
```
持久化：openTabs 快照 + activeTabId 存 localStorage（kind+title 可恢复，payload 重建）。

## 4. 能力零删除映射

| 既有组件 | 新位置 |
| --- | --- |
| TreeView（含右键删除） | 侧栏 explorer |
| Treemap | 空间图 tab（容器实测尺寸） |
| ChatPanel（多轮/图片/总览） | 右 AI 面板 |
| Studio 检测/卡片逻辑 | 侧栏脚本列表 + 脚本详情 tab（buildScaffoldCards 复用） |
| TriageView / AutoWalk | 巡查 tab（armed 确认不回退） |
| RecordsView + 后端三命令 | 记录 tab + 底面板记录简表 |
| CleanupModal / Settings / SteamInspector* / ContextMenu / 拖拽 | 原样保留挂载 |
| 扫描进度 / DiagnosticsBar | 底面板 |

## 5. 工程纪律

令牌纪律（组件只消费语义令牌，硬编码登记 spec §7 豁免清单）· 图标纪律（Lucide 提取，禁手绘）· 两步确认纪律 · 字体零 CDN · 不引入 Tailwind/组件库 · `transition: all` 禁用。

## 6. 落地顺序

1 store tab 模型 → 2 令牌层换 Trae 色板 + 外壳 CSS → 3 App.tsx 五区重写 → 4 六视图/入口页/右面板接线 → 5 门禁（tsc/build/cargo test --workspace/lint）→ 6 复核（能力零删除逐项核对）。

## 7. 豁免清单

（沿用第三波登记；新增残留在此登记）

- §7.2 风险梯度硬编码色 **已消灭**（2026-09-28）：AdvisorCard / ScaffoldPanel / ChatPanel / triage.ts(BUCKET_META.tone) / TriageView 原先四套互不相同的风险 hex（#ffa3c7/#ffb37a/#ff5d7a/#a17a8d、#5fcf95、#16a34a/#d97706/#ca8a04、#5fc88a/#ff9f5e/#ffd166/#7a6675/#5b8def）全部收敛到 styles.css §1 的 `--risk-low/--risk-med/--risk-high`（桥 --ok/--warn/--danger）与既有 `--fg-muted/--info` 令牌，不再需要豁免登记。
