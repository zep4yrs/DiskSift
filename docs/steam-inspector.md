# Steam Inspector · 设计稿（review 用）

> 这是 review 文档，不是已落地特性。先签字，再动代码。
>
> **状态**：Phase 0 设计稿（2026-05-06 创建，待 review）。

## 1. 这是什么

一个**只读**的 Steam 游戏库面板，给用户一份"我装了哪些游戏 / 多大 / 上次玩是什么时候"的可排序视图，行内提供"在 Steam 中卸载"deep link，**不**直接 `rm` 任何游戏文件。

定位上跟现有的 conda envs 卡片是同一类东西：**非 scaffold 的元数据视图**。Steam 缓存清理（`shadercache/` 等）单独走一份普通 scaffold（`scaffolds/steam.toml`），跟 Inspector 解耦。

## 2. 为什么不做成 scaffold

现有 scaffold = "TOML 描述要删的 glob"。Steam 游戏目录每个动辄几十 GB，scaffold 模型要么诱导用户误删（一勾全删），要么我们要硬写一堆"哪些子目录可清"的特例（脆弱、维护成本高）。Inspector 的本质是**展示决策面板 + 把动作甩给 Steam 客户端**——schema 形状跟 scaffold 完全不同，强塞进去会拧坏 `Scope.glob` 的语义。

参考先例：[crates/scaffold/src/lib.rs](crates/scaffold/src/lib.rs) 的 `Scope` 跟 [apps/desktop/src-tauri/src/lib.rs:701](apps/desktop/src-tauri/src/lib.rs#L701) 的 `CondaEnv` 是两个独立 schema，conda envs 通过 `list_conda_envs` 命令暴露给前端，**不**经过 scaffold scope 系统。Steam Inspector 走相同结构。

## 3. 目标 & 非目标

### 目标（in scope）

- 列出本机所有 Steam 库（默认 + 通过 `libraryfolders.vdf` 配置的额外库）
- 每款游戏展示：中文名（best-effort）/ 英文 installdir / 占用 / 上次启动 / 安装路径
- 默认按"上次玩 + 占用"加权排序（>30 GB 且 ≥6 个月没玩 = 推荐高亮）
- 行内 `[在 Steam 中卸载]` 按钮 → 触发 `steam://uninstall/<appid>` deep link
- 行内 `[在 Explorer 中打开]` → 复用现有 `revealInExplorer` 命令
- 检测"鬼魂安装"（`appmanifest` 存在但 `installdir` 缺失/损坏）单独标灰

### 非目标（out of scope，故意不做）

- ❌ **任何破坏性操作**——不 `rm`、不 recycle、不 quarantine 游戏目录
- ❌ Workshop 内容管理（订阅 / 删除 mod）
- ❌ 云存档相关（让 Steam 自己处理）
- ❌ 游戏内文件清理（驱逐特定关卡的缓存等，太脆弱）
- ❌ 多 Steam 账号场景（一台机器一个 Steam 账号是 99% 情况）
- ❌ 手动改 ACF 修复"鬼魂安装"——只展示，不修

### Hard rule（必须满足）

- Inspector 调用的所有命令是 **read-only**——没有 `recycle / delete / quarantine` 路径
- 唯一"动作类"调用是 `steam://` URL scheme（系统 protocol handler 处理）和 `revealInExplorer`
- 因此 **不需要** `<ErrorBoundary>` 两步确认那套（CLAUDE.md 第 3 条针对的是破坏性 Tauri 命令）

## 4. 数据源

### 4.1 Steam 安装根

Windows 默认：`C:\Program Files (x86)\Steam\`。注册表 fallback：

- `HKEY_CURRENT_USER\Software\Valve\Steam\SteamPath`（forward slash 形式）
- `HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Valve\Steam\InstallPath`

如果两个都拿不到 → Inspector 显示"未检测到 Steam 安装"空状态。

### 4.2 多库枚举

`<steam_root>\config\libraryfolders.vdf`（Valve KeyValues 格式）—— 列出所有库根：

```
"libraryfolders"
{
    "0" { "path" "C:\\Program Files (x86)\\Steam"  "apps" { "730" "..." ... } }
    "1" { "path" "D:\\SteamLibrary"                "apps" { "1245620" "..." ... } }
}
```

每个库的 `<library_root>\steamapps\` 下放 `appmanifest_<appid>.acf` 文件。

### 4.3 单游戏元数据：appmanifest_*.acf

KeyValues 文本（同样的格式）。我们**只读**这些字段：

| 字段 | 用途 |
|---|---|
| `appid` | 唯一 ID，做 deep link + 翻译 cache key |
| `name` | 英文游戏名（fallback 显示） |
| `installdir` | 子目录名（拼接 `<library>/steamapps/common/<installdir>` 是实际安装路径） |
| `SizeOnDisk` | bytes |
| `LastPlayed` | Unix 秒时间戳，0 表示从未启动 |
| `LastUpdated` | Unix 秒时间戳（备用） |
| `BytesToDownload` / `BytesDownloaded` | 检测下载未完成的孤儿 |
| `StateFlags` | bitmask，4 = fully installed；非 4 是各种"下载中/需更新/损坏" |

**绝不**读 `userdata/`、`steamapps/common/<game>/` 内部文件、saved games、workshop content。仅 ACF 元数据 + 目录大小。

### 4.4 上次启动时间的几个坑

- `LastPlayed = 0`：从未启动，或者 Steam 重装过丢失记录。UI 显示"从未启动"或"未知"，**不**当成"6 年没玩"参与排序权重
- `LastPlayed` 是当前 Steam 账号在**这台机器**上的记录。云存档/家庭共享场景可能不准——文档中明示这是"本机记录"，不是"所有设备的总和"
- 用户重装 Steam 后所有 `LastPlayed` 会归零——空状态加一句提示"如果你最近重装过 Steam，'上次启动'数据可能不准"

## 5. 后端契约

### 5.1 新 crate：`crates/steam-inspector/`

跟 `crates/scaffold/` 平级，独立 crate。包含：

- `discover_steam_root() -> Option<PathBuf>`（注册表 + 默认路径）
- `parse_libraryfolders(vdf_path) -> Vec<PathBuf>`（库列表）
- `parse_appmanifest(acf_path) -> Result<RawAppManifest>`（结构化字段）
- 单元测试：用 fixture .acf / .vdf 文件（放到 `crates/steam-inspector/tests/fixtures/`）

KeyValues 解析建议用 `keyvalues-parser` crate（手写也行，格式很简单）——评估时优先看 license + 最近 commit。

### 5.2 Rust 结构体（`crates/steam-inspector/src/lib.rs`）

```rust
#[derive(serde::Serialize, Clone)]
pub struct SteamGame {
    pub appid: u32,
    pub name_en: String,           // ACF 里的 name 字段
    pub name_cn: Option<String>,   // 翻译后填，前端命中
    pub install_dir: String,       // 实际目录路径，forward-slash normalized
    pub size_bytes: u64,           // SizeOnDisk
    pub last_played_ts: Option<u64>, // None 表示 LastPlayed=0
    pub library_root: String,      // 所属库根
    pub state_flags: u32,
    pub is_fully_installed: bool,  // state_flags == 4
    pub is_ghost: bool,            // ACF 存在但 install_dir 不存在
    pub default_recommended: bool, // 后端的"推荐用户处理"建议（见 §7）
}

#[derive(serde::Serialize, Clone)]
pub struct SteamLibrary {
    pub root: String,
    pub games: Vec<SteamGame>,
    pub total_size_bytes: u64,
}

#[derive(serde::Serialize, Clone)]
pub struct SteamInventory {
    pub steam_root: Option<String>, // None = 未检测到 Steam
    pub libraries: Vec<SteamLibrary>,
}
```

### 5.3 Tauri 命令（`apps/desktop/src-tauri/src/lib.rs`）

```rust
#[tauri::command]
async fn list_steam_games() -> Result<SteamInventory, String>;
```

**零参数**——后端自己负责发现 Steam（用户 99% 不需要手填路径）。如果后续有用户报"我装在自定义位置"，再加个 optional `steam_root_override`。

### 5.4 翻译命令（独立，可选调用）

```rust
#[tauri::command]
async fn translate_steam_names(
    appids: Vec<u32>,
) -> Result<HashMap<u32, String>, String>;
```

调用流程（见 §7）：先查本地 cache → 调 Steam Web API → 失败的 fallback 到 advisor LLM。命令本身是幂等的，前端可以批量调一次拿全部翻译。

## 6. 前端契约 & 交互设计

> 整个前端按 memory 里的 [前端设计参考 NotebookLM](../../.claude/projects/c--Users-lvjin-Desktop-vibe-coding-pinkbin/memory/feedback_frontend_notebooklm.md) 走——交互质量是硬指标。这一节先列 8 条原则在 Inspector 的具体落点（§6.0），review 时**按这张表检查**；之后才是类型/API/布局细节。

### 6.0 NotebookLM 原则 → Inspector 落点

| NotebookLM 原则 | Inspector 里的具体组件 |
|---|---|
| **Sources as citations** | 每行展开后 detail rail 显示 `appmanifest_<appid>.acf` 完整路径（mono 字体），点击 → `revealInExplorer`；翻译来源标小灰字 "Steam Storefront API" / "Advisor LLM" |
| **Distillation 动作** | 顶部 [导出沉睡报告（Markdown）] 按钮 + 左侧"透视"切换（沉睡分 / 大小 / 库根 / 最后启动月份） |
| **Inline detail expansion** | 行点击展开**右侧 detail rail**（NotebookLM 第三栏样式），**不弹 modal**——保留主列表上下文 |
| **Teaching empty state** | 首次进入显示扫描按钮 + 预期路径 + 注册表 fallback 说明；扫描完成顶部一句话引导（"47 款游戏 · 建议从沉睡分排序"，3s 自动收起）；未检测到 Steam 显示我们查过的所有路径 |
| **Transparent progress** | 扫描分阶段进度条："发现 2 个库 · 解析 ACF 23/47 · 翻译 3/12"；**每阶段独立可见**，每个库扫完先渲染先出 |
| **No paternalism** | 推荐高亮 + **一行具体理由**（"60GB · 8 个月未启动"），但默认不预选；决定权全在用户点击 |
| **键盘 first** | `↑↓` 切行 / `Enter` 展开 / `Esc` 收起 / `O` Explorer / `U` Steam 卸载 / `C` 复制路径 / `R` 重扫 / `/` 搜索 / `1-4` 切透视 |
| **微动效 + breathing** | 行 hover 0.15s 浅色过渡 / detail rail 0.2s ease-out 滑入 / 翻译完成中文名 200ms fade 渐显（**不闪烁替换**） |

**Review 硬规则**：上面任何一行没有具体组件对应 → 设计未完成，不进实现阶段。

### 6.1 类型镜像（`apps/desktop/src/types.ts`）

照 `CondaEnv` 的注释样式：

```typescript
/// Mirror of Rust's SteamGame (crates/steam-inspector/src/lib.rs).
/// Returned by list_steam_games. Pure metadata — Inspector never deletes.
export interface SteamGame {
  appid: number;
  name_en: string;
  name_cn?: string | null;
  install_dir: string;
  size_bytes: number;
  last_played_ts: number | null;
  library_root: string;
  state_flags: number;
  is_fully_installed: boolean;
  is_ghost: boolean;
  default_recommended: boolean;
}

export interface SteamLibrary {
  root: string;
  games: SteamGame[];
  total_size_bytes: number;
}

export interface SteamInventory {
  steam_root: string | null;
  libraries: SteamLibrary[];
}
```

### 6.2 API wrapper（`apps/desktop/src/api.ts`）

```typescript
listSteamGames: () =>
  isTauri ? invoke<SteamInventory>('list_steam_games') : Promise.resolve(mocks.STEAM_INVENTORY),

translateSteamNames: (appids: number[]) =>
  isTauri ? invoke<Record<number, string>>('translate_steam_names', { appids }) : Promise.resolve({}),
```

### 6.3 UI 入口 → **Studio "工具" 卡 + modal**（2026-05-06 修订）

**最终方案**：Studio 右侧面板里加一个 ToolCard "Steam Inspector"，点击打开全屏 modal 承载 Inspector。

#### 为什么不是顶层 tab

第一版尝试过顶层 header 加 `🎮 Steam` toggle 按钮 → 用户立即否决，理由：

- Pinkbin header 心智模型是"主操作"（选目录 / 扫描 / AI tag / 设置），不放 view mode 切换
- 右侧 Studio 列表是**所有功能的统一入口**，新面板不走这条路就破坏一致性
- 跟微信等其他 scaffold 在 UI 上分隔会让用户产生"为什么 Steam 是个特殊东西"的认知摩擦

记忆登记：[feedback_studio_card_plus_modal.md](../../.claude/projects/c--Users-lvjin-Desktop-vibe-coding-pinkbin/memory/feedback_studio_card_plus_modal.md) — 后续新面板默认 Studio + modal。

#### 三栏布局怎么放进 modal

modal 尺寸 92vw × 88vh（capped at 1400 × 900），足够撑三栏 220px / 1fr / 360px。实现：[apps/desktop/src/components/SteamInspectorModal.tsx](apps/desktop/src/components/SteamInspectorModal.tsx) 提供 backdrop + dialog chrome + Esc + X 关闭，body flex column 让 SteamInspector 用 `height: 100%` 填充。

#### ToolCard 模式

新组件 `ToolCard`（在 [Studio.tsx](apps/desktop/src/components/Studio.tsx) 内），跟 scaffold Card 同款外观但：

- 不展开（点击直接调 `onClick` 开 modal）
- 没有 detection 元数据（无 "X 个位置 · YY GB"）
- lavender 边框 + lavender 图标背景 → 视觉区分"工具"和"清理脚本"

未来 Inspector / 报告类常驻入口都走这个模式（Epic Inspector / 库报告等）。

### 6.4 三栏布局 + 行交互

NotebookLM 三栏（Sources / Chat / Studio）→ Inspector 三栏（Filters/透视 / 主列表 / Detail rail）：

```
┌─────────────────┬───────────────────────────────────┬──────────────────┐
│ Filters & 透视  │ 主列表（每行 = 一款游戏）          │ Detail rail      │
│ ──────────────  │ ─────────────────────────────────  │ ────────────────  │
│ 库根：           │ ⚡ Cyberpunk 2077    72GB   3y     │ 选中游戏：        │
│ □ All           │   Counter-Strike 2   35GB   今天    │  · 中文名+英文名 │
│ □ C: (Steam)    │   Hades             2.5GB   6mo    │  · 元数据卡片    │
│ □ D: (Library2) │   ...                              │  · 推荐理由      │
│                 │                                    │  · Sources（acf）│
│ 透视：           │                                    │  · 操作按钮组    │
│ ◉ 沉睡分        │                                    │                  │
│ ○ 大小          │                                    │                  │
│ ○ 库根          │                                    │                  │
│ ○ 最后启动月    │                                    │                  │
└─────────────────┴───────────────────────────────────┴──────────────────┘
```

**主列表行**（决策必需的最少信息）：

- 图标位（recommendation 标 ⚡，ghost 标 ⚠，普通游戏空）
- 名字：中文优先 / 英文 installdir fallback；hover 显示**反向**那个名字（中文行 hover 露英文，反之亦然）
- 大小：右对齐数字 + 单位
- 上次启动：相对时间字符串（"今天" / "本月" / "3 个月前" / "3 年前" / "从未"）
- **推荐理由（如果有）**：一行小字，深色（"60GB · 8 个月未启动"）

行没有内嵌操作按钮——主操作只有"行点击 → 展开 detail rail"。这是 NotebookLM 主列表区不堆按钮的同款克制。

**Detail rail（右侧 320-400px 宽）**：

```
┌──────────────────────────┐
│  [cover 占位]            │
│  Cyberpunk 2077          │
│  Cyberpunk 2077 (en)     │  ← 英文 installdir，小字
│ ──────────────────────── │
│  appid:        1091500    │
│  大小:         72.3 GB    │
│  上次启动:      2023-04 (3 年前) │
│  库根:         D:/SteamLibrary  │
│ ──────────────────────── │
│  💡 为什么建议处理        │
│  72GB · 占该库 23%       │
│  · 3 年未启动             │
│ ──────────────────────── │
│  Sources                  │
│  📄 appmanifest_1091500.acf  ← 点击 reveal in Explorer
│  🌐 翻译：Steam Storefront │  ← 来源标注
│ ──────────────────────── │
│  [在 Steam 中卸载（U）]   │
│  [Explorer 打开（O）]     │
│  [复制路径（C）]          │
└──────────────────────────┘
```

Ghost 状态时 detail rail 顶部插红色 banner：

> ⚠ 检测到鬼魂安装：ACF 元数据存在但安装目录已缺失或不完整。建议在 Steam 中右键卸载，或属性 → 验证文件完整性。Inspector 第一版不替你清 ACF。

**主列表只显示决策必需的 4-5 项，富信息进 detail rail**——把 NotebookLM 主对话区不堆 metadata 的同款克制借过来。

### 6.5 排序权重（"沉睡分"）+ 推荐理由

默认排序按 `dormancy_score = size_gb * months_since_last_played`：

- 从未启动且 size > 5GB → 给一个 fixed 高分（按"6 个月没玩"算）
- 系统级游戏（Steam 自己的工具，比如 SteamVR Driver）排除在 default_recommended 外

`default_recommended` 由后端给出（前端不重算），规则：

```
size_gb >= 30 AND months_since_last_played >= 6  →  推荐
size_gb >= 50 AND months_since_last_played >= 3  →  推荐
is_ghost                                          →  推荐（让用户去 Steam 强制重装/卸载）
```

UI 渲染时推荐行加 ⚡ 图标 + 浅色背景，**不预选 checkbox**（Inspector 没有批量勾选——每个游戏单独决定）。

**推荐理由是硬要求**（NotebookLM 第 #1 条 sources-as-citations + #6 no paternalism）：每条 `default_recommended = true` 必须带**具体**理由，不是"建议处理"四个字。后端 `SteamGame` 多一个字段：

```rust
pub recommendation_reason: Option<String>,  // 例: "60GB · 8 个月未启动"
```

理由格式约束：

- 必须命中"size + 时间"两个数字事实
- 不要情绪化文案（"占用太多了！"）
- 不要带建议词（"建议卸载"——决定权给用户）
- ghost 例外：理由是 "ACF 存在但安装目录缺失"

NotebookLM 的 source citation 是同款冷静客观——给事实，不给结论。

### 6.6 状态机（每个状态都要显式设计）

NotebookLM 没有"转菊花拉倒"的状态。Inspector 同样要求：

| 状态 | 设计 |
|---|---|
| **首次进入** | 居中 "扫描你的 Steam 库" 大按钮 + 灰字"预期路径：C:/Program Files (x86)/Steam（也会查注册表 `Valve\Steam\SteamPath`）"——告诉用户数据从哪来 |
| **扫描中** | 顶部多阶段进度条 + 当前阶段文字（"发现 2 个库根 · 解析 ACF 23/47 · 翻译 3/12"）；每个库扫完先渲染先出，不等全部 |
| **扫描完成 - 有结果** | 顶部一句话引导 banner（"47 款游戏 · 建议从'沉睡分'排序看推荐处理"），3s 后自动渐隐 |
| **扫描完成 - 零结果** | "未发现 Steam 游戏。Steam 在 ___，但 steamapps/ 下没有 appmanifest_*.acf 文件。" + [重新扫描] 按钮 |
| **未检测到 Steam** | 列出我们查过的所有路径 + 注册表 key + "如果你的 Steam 装在其他位置，[手动指定]"（按钮第一版禁用，配文 "v2 支持，§11 已登记"） |
| **翻译进行中** | 主列表行内中文名位置显示**骨架屏**（不是 spinner）；完成后渐显（200ms fade）替换 |
| **翻译失败** | 静默 fallback 到英文名；detail rail 的 sources 处标小灰字 "翻译失败：Storefront API 超时"（不打扰用户） |
| **deep link 无响应** | 点 [在 Steam 中卸载] 后 800ms 没看到 Steam 前置 → toast 提示 "Steam 未启动？请先打开 Steam 客户端"；不阻塞 UI 不弹 modal |
| **Ghost game 行** | 行尾 ⚠ 图标 + 浅灰底；展开后 detail rail 红色 banner（见 §6.4） |

### 6.7 Distillation 动作

NotebookLM 的 "Audio Overview" / "Briefing Doc" / "Mind Map" 模式：noisy 输入 → 一键结构化产物。Inspector 第一版做两个：

#### 6.7.1 沉睡报告导出（Markdown）

顶部按钮 [导出沉睡报告 (Markdown)]，写到本地 .md 文件（用户选保存位置，**不上传任何东西**）：

```markdown
# Steam 沉睡报告 · 2026-05-06

总计：47 款游戏 · 总占用 320 GB · 沉睡（>6 个月未启动）总占用 180 GB

## Top 推荐处理

| # | 游戏 | 大小 | 上次启动 | 推荐理由 |
|---|---|---|---|---|
| 1 | Cyberpunk 2077 | 72 GB | 3 年前 | 72GB · 3 年未启动 |
| 2 | Red Dead Redemption 2 | 119 GB | 18 个月前 | 119GB · 18 个月未启动 |
| ... |

## 按库根分布

- D:/SteamLibrary：12 款，220 GB
- C:/Program Files (x86)/Steam：35 款，100 GB
```

典型场景：用户在飞书/钉钉里贴给自己或对象，"我该删哪个"问朋友。

#### 6.7.2 透视切换（左侧 Filters 区）

NotebookLM 的"换个角度看同一份数据"。第一版四种透视：

| 透视 | group-by 渲染 |
|---|---|
| 沉睡分（默认） | 推荐 ⚡ 排前 / 普通中 / "今天玩过"沉底 |
| 大小 | top 大小段：>50GB / 20-50GB / <20GB / <5GB |
| 库根 | 按库分组，组头显示该库总占用和总数 |
| 最后启动月份 | 时间线倒序："今天" / "本月" / "上月" / "3 个月前" / "6+ 个月前" / "从未" |

切透视用左侧 radio + 快捷键 `1-4`，主列表顶部带过渡动画（rows 重排 0.3s ease-in-out）。

### 6.8 键盘交互

主操作必须有快捷键。第一版 quick wins：

| 键 | 动作 |
|---|---|
| `↑` `↓` | 切换选中行 |
| `Enter` | 展开/收起 detail rail |
| `Esc` | 收起 detail rail |
| `O` | 在 Explorer 中打开当前选中游戏 |
| `U` | 唤起 Steam 卸载（先 toast "正在打开 Steam..."，800ms 无响应再提示 Steam 未启动） |
| `C` | 复制安装路径到剪贴板 |
| `R` | 重新扫描 |
| `/` | 焦点搜索框（按游戏名过滤） |
| `1-4` | 切换透视模式 |

**Cmd-K 命令面板**第一版**不做**（动作 ≤ 9 个，菜单足够），§11 登记触发条件：动作数 > 10 时再加。

提示位置：detail rail 操作按钮组每个按钮的标签里写 `（U）`/`（O）` 这类括号提示——NotebookLM 同款"shortcut hint inline in label"风格。

## 7. 翻译流程

### 7.1 三级 fallback

1. **本地 cache**（`<app-data>/pinkbin/steam-name-cache.json`，per-appid 持久化）
   - schema：`{ "<appid>": { "name_cn": "...", "fetched_at": <unix> } }`
   - TTL：永久（游戏中文名几乎不会变）
2. **Steam Storefront API**（无需 key）
   - `https://store.steampowered.com/api/appdetails?appids=<id>&l=schinese&cc=cn`
   - 返回 `{"<id>": {"success": true, "data": {"name": "中文名"}}}`
   - 限流：Steam 官方 ~200 req/5min，我们一次开机最多调一次（appid 没翻过的批），手动节流到 2 req/sec
   - 不支持批量多 appid；要逐个调（异步并发 4 个）
3. **Advisor LLM fallback**（`pinkbin_advisor` 现成 provider）
   - 仅当 Storefront API 返回 `success: false`（极少数下架游戏）才走
   - prompt：纯英文 → 中文，不暴露任何路径/用户信息
   - 用户没配 advisor 就直接显示英文 name —— **不**强制要 API key

### 7.2 数据卫生

发出去的内容**仅限**英文游戏名（来自 ACF 的 `name` 字段，本身就是 Steam 商店公开数据）。**绝不**发送：

- 任何路径（库根、install_dir、用户名）
- LastPlayed 时间戳
- 占用大小
- 用户机器上有的游戏列表的全集（避免侧信道；只发"翻不出来的那几个 appid"）

### 7.3 离线/无网络

整套 Inspector **不依赖**翻译——Storefront API 不通就显示英文 installdir 名，UI 完全可用。翻译是 enhancement，不是核心路径。

## 8. 隐私 & 红线

按 CLAUDE.md 第 4 条：

- ✅ 读 `appmanifest_*.acf`（Valve 公开元数据格式）
- ✅ 读 `libraryfolders.vdf`
- ✅ 读注册表 `Valve\Steam\SteamPath`
- ✅ Glob/`fs::read_dir` 列 `steamapps/common/` 子目录名（用于 ghost detection）
- ✅ `fs::metadata` 取目录 size（递归 du 在 ACF 里已有 `SizeOnDisk`，优先用 ACF 值）
- ❌ 读 `userdata/` 任何文件
- ❌ 读 `steamapps/common/<game>/` 内任何具体文件
- ❌ 读 Steam 登录凭据 / `Steam/config/loginusers.vdf` 详细字段
- ❌ 把游戏列表完整发出去（翻译只发 fallback 的少数英文名）

## 9. 安全/正确性测试

虽然不是 scaffold，但仍需要：

- **`crates/steam-inspector/tests/parse.rs`**：fixture .acf / .vdf 解析正确性
- **`crates/steam-inspector/tests/safety.rs`**：用 fixture 模拟一个完整 Steam 库布局，断言：
  - 解析输出**不包含** `userdata/`、`config/loginusers.vdf` 内容的任何字段
  - `SteamGame` 的所有字段都是 ACF 元数据，没有泄露的具体游戏文件路径
- **手测脚本**：`docs/cross-device-test-checklist.md` 加一节"Steam Inspector"——多库 / 自定义路径 / 鬼魂安装 / 中文翻译 fallback 各跑一次

## 10. 开放问题 → 已决（2026-05-06，由 Claude 代决，执行中可改）

> 用户授权"代我决定先做"。下面 5 条决定生效；如果实测发现问题随时回来改这一节并同步代码。

### A. UI 入口位置 → ~~(1) 顶层 tab~~ → **Studio 工具卡 + modal**（2026-05-06 二次修订）

第一版选了顶层 tab 被用户当场否决。修订到 Studio "工具" section 的 ToolCard，点击打开 modal 承载 Inspector。完整理由 + 实现见 §6.3。

### B. 翻译默认开关 → **(1) 默认开启，Storefront API + 本地永久 cache**

理由：95% 用户零感知拿到中文名，不需要配 API key；§7.2 数据卫生约束已经够紧（只发英文游戏名公开数据，不发路径/时间戳）。Settings 里加一个"关闭翻译"开关给隐私偏执用户。

### C. Ghost game → **(1) 仅标记 + 推荐去 Steam 处理**

理由：保 Inspector read-only 红线（§3 Hard rule），写 ACF 会拉整个组件回到 ErrorBoundary + 两步确认那套架构。已在 §11.3 登记"未来想做就走普通 scaffold"。

### D. 多 Steam 账号 / 家庭共享 → **第一版不支持**

理由 + 触发信号已登记 §11.1。

### E. 命名 → **directory `crates/steam-inspector/`，package `pinkbin-steam-inspector`**

理由：directory 跟现有 `scaffold/`、`scanner/` 等无前缀；package 跟 `pinkbin-scaffold` 同款 `pinkbin-` 前缀。前端组件 `SteamInspector.tsx`，跟文档同名。

## 11. Known limitations & future work

> 这一节是**显式登记**——明确决定"第一版不做"的事必须写在这，避免悄悄消失。每一条要带"为什么先不做"和"什么信号触发再做"两个字段，未来 Claude 或其他人接手时能判断是否到点。

### 11.1 多 Steam 账号 / 家庭共享支持

**第一版状态**：不支持。Inspector 假设单账号单机器，`LastPlayed` 字段直接当成"这台机器上这个游戏的最后启动时间"，不区分账号。

**为什么先不做**：

- 99% 用户单账号单机器，加进来 ROI 极低
- 多账号下 `LastPlayed` 的语义会变成"任意账号最后启动" vs "当前账号最后启动" vs "所有账号 max"，UI 选择题增多
- Steam Family Sharing 的"借玩"游戏 ACF 行为复杂（appmanifest 可能在出借方机器上、借玩状态下 LastPlayed 由 Steam 服务端记），需要专门勘测
- `Steam/config/loginusers.vdf` 含账号 SteamID64 和登录态，碰它会把隐私红线（CLAUDE.md 第 4 条）拉得更紧

**触发信号**（什么时候应该重新评估）：

- 收到 ≥3 个用户报告"我有多个 Steam 账号，Inspector 显示的'上次启动'不对"
- 用户主动要求按账号过滤
- 项目支持 Steam Family Library Sharing 列表的需求（让用户区分自购 vs 借玩游戏）

**接手要点**：

- 不要在第一版 schema 里预留"未来扩展槽位"——按 80% 哲学，单账号实现完保持简单，多账号场景到时候独立加 `account_id: Option<String>` 字段，前端按账号分组渲染
- 实测先：多账号机器上把 ACF 实际行为搞清楚（Steam 自己怎么处理多用户 LastPlayed？切账号后会改 ACF 还是只改 userdata/?），再设计 schema

### 11.2 Steam 重装后 LastPlayed 归零

**第一版状态**：UI 用空状态文案兜底（"如果你最近重装过 Steam，'上次启动'数据可能不准"），不主动检测/修复。

**为什么先不做**：没有可靠的"刚重装过 Steam"信号——Steam 不在 ACF 里记安装日期。硬要做就得对比 `Steam.exe` 文件 mtime 之类的启发式，不稳。

**触发信号**：用户大量反馈"为什么我的游戏全显示从未启动"且实际不是。

### 11.3 Ghost game 的写操作（清 .acf 文件）

**第一版状态**：仅标记 + 提示用户去 Steam 处理，Inspector 不写 ACF。

**为什么先不做**：保 Inspector "read-only" 红线（§3 Hard rule）。Inspector 一旦能写 ACF，整个组件就要回到 ErrorBoundary + 两步确认 + recycle 模式那套——架构复杂度跃升一个量级，跟"展示决策面板"的定位冲突。

**触发信号**：用户大量反馈"Steam 自己处理 ghost 太麻烦"。如果真要做，方案应该是：把 ghost ACF 走**普通 scaffold** 的 recycle mode（不是 Inspector 内联），跟其他破坏性操作走相同的 UI 路径。

### 11.4 第三方启动器（Epic / GOG / Battle.net / Xbox）

**第一版状态**：Inspector 只支持 Steam。

**为什么先不做**：每家启动器的元数据格式不同（Epic 用 `.item` JSON，GOG 用 GOG Galaxy SQLite，Battle.net 用 `Battle.net.config`），加进来会让 `crates/steam-inspector/` 退化成大杂烩。

**触发信号**：Steam Inspector 用户量稳定且明确请求"我也想看 Epic 库"。届时**新开 crate**（`crates/epic-inspector/` 等），共用前端表格组件抽象，不要塞回 steam-inspector。

### 11.5 Cmd-K 命令面板

**第一版状态**：不做。Inspector 第一版主操作 ≤ 9 个，单字母快捷键 + detail rail 按钮已经够用（见 §6.8）。

**为什么先不做**：Cmd-K 命令面板有自己的设计成本（fuzzy 搜索权重、动作分组、近期动作记忆），现阶段 ROI 不够。

**触发信号**：Inspector + 其他视图加起来主动作数 > 10，或者用户开始抱怨"找不到 X 操作"。届时考虑做**全局** Cmd-K（不只 Inspector），跟 Studio / Settings 共用。

### 11.6 国内网络下 Steam Web API 不可达（UU 加速器用户群）

**第一版状态**：当下做到的兜底——

1. Windows 系统代理探测（HKCU 注册表）→ 挂 Clash/V2Ray 等改写系统代理的用户能直接吃到加速
2. 一次自动重试（800ms 退避）→ 抗瞬时抖动
3. localStorage 永久 cache → 任何用户成功获取一次后，之后跑 demo / 离线都能秒出名字
4. 失败 graceful degrade 到 `#<id>` 显示，灰色横条 + [重试] 按钮
5. 工坊 modal 核心功能（size / 上次更新 / [在 Steam 中打开]）**不依赖**名字解析，名字是 enhancement

**为什么先不做更多**：

- 普通用户用 UU 加速器 / 雷神 / 腾讯网游加速器这类**只加速注册过的游戏进程**的工具，对 Pinkbin 这种第三方桌面 app 完全没效果（UU 不接管非游戏进程的流量，不路由 `api.steampowered.com` 这种 web 基础设施域名）
- 修复需要服务端基础设施（Cloudflare Worker / VPS 中继 / 自建 API），有运维责任
- 用户没明确反馈"看不到名字很烦"——名字目前是 bonus 不是核心

**触发信号**（什么时候应该真做）：

- ≥3 个用户报告"打开工坊看不到名字"
- demo / 营销场景需要保证录制时名字总能出现
- 合伙人产品判断"工坊作为亮点功能必须有名字"

**实现路径（接手者直接照做）**：

1. **部署 Cloudflare Worker**（约 30 行，免费 100k req/day）：

   ```javascript
   // pinkbin-steam-relay.js
   export default {
     async fetch(req) {
       if (req.method !== 'POST') return new Response('only POST', { status: 405 });
       const body = await req.text();
       const upstream = await fetch(
         'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/',
         { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }
       );
       return new Response(upstream.body, {
         status: upstream.status,
         headers: { 'Content-Type': 'application/json' },
       });
     },
   }
   ```

2. **Pinkbin 改两处**（`apps/desktop/src-tauri/src/lib.rs::fetch_workshop_titles`）：

   - 加常量 `STEAM_API_RELAY: Option<&str> = Some("https://你的-relay.workers.dev")`（编译期写死，避免给小白用户加 Settings 选项 → 违反"UI 不做选择题"）
   - 直连两次都失败后，再对 relay URL 试一次（同样的 form body 直接 POST 过去，Worker 透传）
   - 仍失败 → 现有 [重试] UI

3. **隐私**：发出去的只有公开 workshop ID，CF Worker 配置关掉 logging（dashboard → Workers → Settings → 取消 Workers Logs），保险起见也可以加一行 `caches.default` 缓存 24h 减压。

4. **降级路径不变**：cache + 灰色重试条 + ID-only fallback 全部保留，relay 是新增层不替换现有任何逻辑。

**反例 / 不要做的事**：

- ❌ 不要在 Settings 里加"自定义 API 代理"输入框给用户填——99% 的用户不知道这是啥，违反"80% 痛点聚焦 + UI 不做选择题"
- ❌ 不要尝试把 Pinkbin 进程伪装成 cs2.exe 骗 UU 加速——UU 按域名+目标 IP 路由，不路由 web 基础设施域名，伪装无效
- ❌ 不要 bundle 静态名字数据库（top 10K 工坊项）——Steam 工坊百亿级，覆盖率低收益差

### 11.7 游戏内文件粒度清理

**第一版状态**：不做。Inspector 只管"整个游戏卸不卸"。

**为什么先不做**：每个游戏的"哪些子目录可清"差异巨大（CS2 的 demos/ vs Cyberpunk 的 mods/），脆弱且需要持续维护。

**触发信号**：明确不会做，除非有人愿意为单个超级头部游戏（CS2 / Dota 2）单写一份 scaffold。

---

> §11 顺序按"影响人群规模 / 修复优先级"大致排：11.1（多账号）和 11.6（UU 用户群）影响真实用户最多，11.5（Cmd-K）和 11.7（游戏内粒度）是边缘 polish。Cmd-K 原 §11.5 → 编号未动，新加的 11.6 + 11.7 在原 11.5/11.6 之后顺延。

---

## 12. 实现顺序（review 通过后）

1. `crates/steam-inspector/` 骨架 + ACF/VDF 解析 + 单测
2. Tauri 命令 `list_steam_games` 接进 `apps/desktop/src-tauri/src/lib.rs`
3. TS 类型镜像 + api.ts wrapper + mocks
4. `SteamInspector.tsx` 组件（先纯英文 name，跑通显示）
5. 翻译流程（Storefront API → cache → advisor fallback）
6. UI 接到顶层入口 + 排序逻辑 + ghost 标识
7. 安全测试 + 手测 checklist
8. 配套 `scaffolds/steam.toml`（缓存清理，独立工件，走 `/add-scaffold steam` 14-phase）

每步完成后跑 `cargo check -p pinkbin-desktop` + `pnpm -C apps/desktop exec tsc --noEmit`，schema 改动一定要双向编译干净。
