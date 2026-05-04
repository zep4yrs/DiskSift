# 慢 / 卡死 全面排查与修复计划

针对开源前社区开发者反馈的"扫盘慢、软件卡死"问题。两个观察样本：

- **开发者 A**：游戏本，运行时间短，偶尔卡死，未走 MFT。
- **开发者 B**：轻薄本，运行时间是 A 的 ~10×，每次都卡死，未走 MFT。

下文按"卡死贡献度 + 命中范围"排序，**不只看扫描器**——IPC、前端渲染、executor 都被纳入嫌疑面。

---

## 一、IPC 维度——最大头，跟扫盘无关却被用户当成"扫盘卡"

### 1.1 `tagScaffolds` 对每个目录节点都打一次 IPC（致命）

[apps/desktop/src/App.tsx:127-137](../apps/desktop/src/App.tsx#L127-L137)

```ts
const tagScaffolds = async (n, depth = 0) => {
  const id = n.is_dir ? await api.detectScaffold(n.path).catch(() => null) : null;
  const cap = depth < 2 ? 100 : depth < 4 ? 50 : 20;
  return { ...n, scaffold_id: id,
    children: await Promise.all((n.children ?? []).slice(0, cap).map((c) => tagScaffolds(c, depth+1))),
  };
};
```

- 在 `await api.scan(...)` **之后**才开始跑，所以进度条已经到底、按钮还在转——这是用户看到的"扫完之后又卡很久"的主因。
- `Promise.all` + 递归扇出，瞬间往 Tauri IPC 队列里灌成百上千个 `detect_scaffold` 调用，全都打到同一个命令线程。
- 全树展开上限：`100×100×50×50×20 ≈ 5e7`，实际 5k–50k 节点，每个走一趟 IPC。

### 1.2 `detect_scaffold` 是**同步 command**，且每次现编 globset

[apps/desktop/src-tauri/src/lib.rs:128-131](../apps/desktop/src-tauri/src/lib.rs#L128-L131)、[crates/scaffold/src/lib.rs:99-129](../crates/scaffold/src/lib.rs#L99-L129)

```rust
#[tauri::command]                            // ← 不是 async，没有 spawn_blocking
fn detect_scaffold(state, path) -> Option<String> {
    detect_for(&state.scaffolds.lock().unwrap(), Path::new(&path))
}

// detect_for 内：
for s in scaffolds {
    for d in &s.detect {
        let pat = norm(&expand_env(d)).to_lowercase();
        if let Ok(set) = make_globset(&[pat.as_str()]) {     // ← 每次都重编译 GlobSet
            ...
        }
    }
    if !s.matcher.must_have_child.is_empty() {
        s.matcher.must_have_child.iter().all(|c| path.join(c).exists())  // ← 同步 stat
    }
}
```

每节点的开销：`38 scaffolds × 平均 3 个 detect = 114 次 globset 正则编译 + N 次 stat`。乘 1.1 的扇出量 → **几十万次正则编译 + 几万次 stat**，全在 Tauri 命令工作线程，阻塞所有其他 IPC（包括 `scan-progress` 事件分发）。轻薄本弱核 + 单线程 = 几分钟级卡死。

### 1.3 整棵 Node 树通过 IPC JSON 序列化跨进程

[apps/desktop/src-tauri/src/lib.rs:26-44](../apps/desktop/src-tauri/src/lib.rs#L26-L44)

`scan_path` 返回 `Result<Node, String>`。Tauri v2 默认走 IPC channel + JSON。一棵 C: 全盘树（数万目录 × 每目录 500 文件叶子）轻松上百 MB 字符串，进 webview 后再 `JSON.parse` → 主线程长阻塞 + 内存中至少 3 份（Rust serde buf、IPC 字符串、JS 对象）。

### 1.4 `estimateSize` 和真扫描**同时**跑两遍 jwalk

[apps/desktop/src/App.tsx:106-113](../apps/desktop/src/App.tsx#L106-L113) + [apps/desktop/src-tauri/src/lib.rs:54-74](../apps/desktop/src-tauri/src/lib.rs#L54-L74)

子目录扫描时前端 fire-and-forget 触发 `estimate_size`，然后立刻 `await api.scan(...)`。两个 `spawn_blocking` 各自把同一棵树用 jwalk 走一遍。在低端 SSD 上 IO 直接打满 + 互相挤 page cache → 各自比单跑还慢。

### 1.5 没有 cancel 通道

点了扫描就回不了头，发现卡死只能杀进程。开源用户第一印象是"软件烂"。

---

## 二、Scanner 维度——CPU/内存爆点

### 2.1 `accs: HashMap<PathBuf, DirAcc>` 在单线程消费循环里累加

[crates/scanner/src/lib.rs:115-171](../crates/scanner/src/lib.rs#L115-L171)

walker 并行枚举，但 `for entry in walker.into_iter().flatten()` 单线程消费。每文件做 `O(depth)` 次 HashMap upsert + 3 次 `ext.clone()`。在 NVMe + 强核上走得快（开发者 A），在弱核 + 慢盘上 walker 队列堆积、HashMap 涨爆 → 内存压力（开发者 B）。

### 2.2 `acc.files.push((file_name, size))` 不实时裁剪

[crates/scanner/src/lib.rs:144-146](../crates/scanner/src/lib.rs#L144-L146)

```rust
acc.files.push((file_name, size));  // 全量保留
```

`keep_files_per_dir = Some(500)` 只在 [build_tree:223-224](../crates/scanner/src/lib.rs#L223-L224) 才裁剪。一个 npm/pnpm/Windows Installer/WinSxS 平铺目录可以是几万文件名 String 常驻内存。**轻薄本 16G 内存被这条吃掉是大概率事件**。

### 2.3 `build_tree` 又对全树串行 `std::fs::read_dir`

[crates/scanner/src/lib.rs:211-217](../crates/scanner/src/lib.rs#L211-L217)

扫描完成后第二趟全盘 IO，单线程递归。`progress="done"` 之后前端啥也不显示，看着就是卡死。NVMe 命中 cache 没事，QLC/HDD 上等于"扫两遍"。**这一步前端进度条已经停了，是用户最直观的"卡死"**。

### 2.4 `skip_hidden(false)` + 没有黑名单

[crates/scanner/src/lib.rs:115-117](../crates/scanner/src/lib.rs#L115-L117)

C: 全盘扫会进：

| 路径 | 后果 |
|---|---|
| `C:\Windows\WinSxS` | 百万级硬链接，`metadata().len()` 重复累加 → 大小失真 + 巨慢 |
| `C:\Windows\Installer` | 几十 GB MSI 缓存 |
| `C:\hiberfil.sys` / `pagefile.sys` / `swapfile.sys` | 单文件几 GB，stat 慢 |
| `C:\$Recycle.Bin`、`System Volume Information` | ACL 拒绝时 jwalk 静默吞错误，但仍消耗时间 |
| 老 Windows junction（`Documents and Settings`、`%LOCALAPPDATA%\Application Data`） | 即便 `follow_links(false)`，jwalk 在不同 Windows 版本表现不一致，可能重复进入 |

triage.ts 里其实已经列了 `NEVER_TOUCH_PATH_FRAGS`（[apps/desktop/src/triage.ts:31-46](../apps/desktop/src/triage.ts#L31-L46)），但**这只用于分类，不影响扫描**——扫描器自己没这份黑名单。

### 2.5 MFT 路径静默 fallback

[crates/scanner/src/lib.rs:103-106](../crates/scanner/src/lib.rs#L103-L106)

非管理员启动必然失败，`tracing::warn!` 用户看不到。"MFT 模式可让 C: 盘秒扫"这件事开源后用户根本不知道。建议在前端加个"管理员模式"提示。

### 2.6 进度节流只看文件数

[crates/scanner/src/lib.rs:163-170](../crates/scanner/src/lib.rs#L163-L170)

`total_files - last_emit >= 5000` 触发。如果卡在某个慢目录的 metadata 调用，files_seen 不动 → progress 长时间不更新 → 用户以为卡死了。建议同时按时间触发（比如每 500ms 至少一次）。

---

## 三、前端渲染维度——扫完后压垮浏览器主线程

### 3.1 `Studio` 对每个 scaffold 做全树 DFS

[apps/desktop/src/components/Studio.tsx:111-124](../apps/desktop/src/components/Studio.tsx#L111-L124) + [Studio.tsx:70-96](../apps/desktop/src/components/Studio.tsx#L70-L96)

```ts
const allCards = useMemo(() =>
  scaffolds.map(sc => ({ scaffold: sc, match: detectedNodeFor(root, sc), ... })),
  [scaffolds, root]);
```

`detectedNodeFor` 是全树递归 DFS。**38 scaffolds × 全树节点 = 一次性遍历 38 倍树**，每次 root 变化重跑，纯主线程同步，**没分片**。在轻薄本上 100 万节点级树是秒级到十秒级阻塞。

### 3.2 `TreeView` 没有虚拟滚动

[apps/desktop/src/components/TreeView.tsx:135-144](../apps/desktop/src/components/TreeView.tsx#L135-L144)

`children.slice(0, 500)` 顶层就 500 行 DOM，递归打开后 DOM 节点指数级。建议接 `react-window` / `@tanstack/react-virtual`。

### 3.3 `scaffold_id` 字段在后端永远是 `None`

[crates/scanner/src/lib.rs:248](../crates/scanner/src/lib.rs#L248) + [crates/scanner/src/lib.rs:233](../crates/scanner/src/lib.rs#L233)

scanner 里 `scaffold_id: None` 写死。**一切 scaffold 检测都被前端绕路 round-trip**，这是 1.1 + 1.2 存在的根本原因。直接在 Rust 端扫描完成后批量调一次 `detect_for` 填上即可，零 IPC、零正则重编译（globset 可以复用）。

### 3.4 ChatPanel / Settings 在 root 变化时的重渲染

如果它们 `useStore(s => s.root)` 订阅根节点对象，每次扫完整根重 set 都会触发它们重渲染，外加 React reconcile 一棵巨树 vnode 树。需要确认订阅粒度。

---

## 四、Executor / 副作用——开源后的二号"卡死"场景

### 4.1 `execute_plan` 是同步 `#[tauri::command]`

[apps/desktop/src-tauri/src/lib.rs:149-156](../apps/desktop/src-tauri/src/lib.rs#L149-L156)

不是 async、没有 `spawn_blocking`。`std::fs::remove_dir_all` 删一个 `node_modules` 是几万次同步 IO，全占 Tauri 命令线程。等同于**清理操作期间 UI 完全死**。

### 4.2 `copy_dir_recursive` 单线程 + 跨盘 fallback

[crates/executor/src/lib.rs:137-150](../crates/executor/src/lib.rs#L137-L150)

quarantine 跨盘时退化到全量复制再删，单线程。再加上 4.1，能让 quarantine 一个大文件夹卡死十分钟级。

---

## 五、为什么 A 偶尔卡 / B 必卡（差异归因）

| 维度 | 游戏本 A | 轻薄本 B |
|---|---|---|
| **2.3 二次 read_dir** | NVMe + 大 cache，几乎瞬间 | QLC/低端 SSD + cache 已被吃光，重读全盘 |
| **2.2 + 1.3 内存峰值** | 32G 内存有空间 | 16G/8G 直接到 swap |
| **1.1 + 1.2 IPC 雪崩** | 多核 + 强单核，分钟内消化 | 弱核数分钟到十分钟 |
| **2.4 黑名单缺失** | 短跑没扫到 WinSxS | 长跑 10× 必到 WinSxS / Installer / Recycle.Bin |
| **3.1 Studio DFS** | 主线程一秒过 | 与 IPC 雪崩叠加 → 几十秒级冻结 |

A 是这些问题**单独**触发其中一两个、且硬件能扛；B 是**全部**触发、硬件扛不住。

---

## 六、修复优先级建议（按 ROI 排序，开源前必修分级）

### 必修 / 公开发布前（一周内）

1. **scanner 自带 scaffold 检测**（消灭 1.1 / 1.2 / 3.3）：在 Rust 端扫描结束时跑一次批量 `detect_for`（globset 预编译并复用），填到 `Node.scaffold_id`。前端删掉 `tagScaffolds`。预计省掉 80% 的"扫完之后还卡几分钟"。
2. **build_tree 复用 jwalk 第一趟数据**（消灭 2.3）：扫描时把目录关系用 `HashMap<PathBuf, Vec<PathBuf>>` 收集，build_tree 不再 `read_dir`。预计省掉 30%–60% 实际"扫盘耗时"。
3. **`acc.files` 实时按 size top-K 维护**（消灭 2.2）：用 `BinaryHeap` 维护每目录前 N 大文件，不再全量保留 String。
4. **加系统目录黑名单**（消灭 2.4）：默认跳过 `Windows\WinSxS`、`Windows\Installer`、`$Recycle.Bin`、`System Volume Information`、`hiberfil.sys`、`pagefile.sys`、`swapfile.sys`。给个 advanced toggle 让用户能关掉。
5. **`execute_plan` 改 async + `spawn_blocking`**（消灭 4.1）：清理大目录期间 UI 不能死。

### 强烈建议（两周内）

6. **去掉 `estimateSize` 双跑**（消灭 1.4）：要么不要 ETA，要么从 scanner 实时进度算 ETA，不要再走第二遍 jwalk。
7. **加 cancel 通道**（消灭 1.5）：`scan_with` 接 `Arc<AtomicBool>` 中止信号，前端给"取消扫描"按钮。
8. **Studio 全树 DFS 改成 scanner 时一次性收集**：scanner 完成时同时返回 `BTreeMap<scaffold_id, Vec<PathBuf>>`，Studio 直接拿。
9. **TreeView 虚拟滚动**：接 `@tanstack/react-virtual`。

### 体验优化

10. **MFT fallback 暴露给前端**：返回 `{ tree, mode: "mft" | "walkdir" }`，前端在 walkdir 模式提示用户"以管理员启动可秒扫"。
11. **进度节流加时间维度**：500ms 兜底，避免长慢目录看起来卡死。
12. **scanner 累加并行化**（消灭 2.1）：jwalk `process_read_dir` 回调里直接累加到分片 acc，最后合并。这一步收益大但改动也大，建议放到 v0.2。

---

## 七、可观察验证清单（动手前先量一遍）

在 B 的轻薄本上插桩，确认嫌疑大小：

- [ ] `scan_with` 入口/出口、`build_tree` 入口/出口分别打 `tracing::info` + 时间戳——量出 build_tree 占总时间的比例。
- [ ] 前端 `console.time('tagScaffolds') ... timeEnd`、`console.time('Studio.useMemo')`——量出 IPC 雪崩 / Studio DFS 各占多久。
- [ ] 任务管理器看进程峰值内存 + 是否进 swap——验证 2.2 / 1.3。
- [ ] 关掉 Studio 渲染（临时注释掉 `<Studio />`）再扫一次——验证 3.1 影响。
- [ ] 临时把 `tagScaffolds` 改成 noop（直接 `return n`）再扫一次——验证 1.1 / 1.2 影响。
