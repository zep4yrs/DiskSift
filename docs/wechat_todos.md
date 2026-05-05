# WeChat scaffold 后续补齐清单

对标 [CleanMyWechat](https://github.com/blackboxo/CleanMyWechat) 这类社区工具，本仓 `wechat-pc` scaffold 还有以下 gap。每条都按 CLAUDE.md 的 14-phase 走 `/scaffold-review wechat-pc`（schema 改动）或 `/add-scaffold` 同款流程（新桶）。

> 本文档由 perf/卡死修复阶段顺手梳理，不在该阶段范围内。下一轮迭代再处理。

---

## P0 — 影响"删干净不删错"的语义正确性

### 1. 时间过滤（N 天前）没接通

**现状**：`scaffolds/wechat-pc.toml` 多个 scope 已写
```toml
prompt = { kind = "days", default = 30, label = "Delete cached chat media older than (days)" }
```
但 [crates/executor/src/lib.rs](../crates/executor/src/lib.rs) 和 [apps/desktop/src-tauri/src/lib.rs::execute_scope](../apps/desktop/src-tauri/src/lib.rs) **完全不读 `prompt`**——点"清理"是按 glob 一锅端，不看 mtime。

**用户感知**：明明 scaffold 写了"默认删 30 天前的视频"，UI 也没给输入框，点下去把昨天的视频也删了。**违反用户预期，发布前必须修**。

**修复面**：
- 前端 Studio Card 在 expand 时按 `scope.prompt` 渲染输入框（数字 input + 单位）
- `execute_scope` Tauri 命令多收一个 `older_than_days: Option<u32>` 参数
- executor / scope 执行路径：jwalk 命中后再用 `metadata().modified()` 过滤
- TS types.ts 加 prompt 字段镜像

**估算**：1-2 个工作日，跨前后端 + executor。Safety test 加 mtime 边界断言。

---

### 2. 没有 `msg/image/**` 桶（4.x 接收图片）

**现状**：现在 `chat-media-cache` 覆盖 `cache/*/Message/**`（缓存层，重启会重建），**真正接收的图片**走 `wxid_*/msg/image/**`，目前没有 scope 覆盖。

**用户感知**：CleanMyWechat 有"图片"独立项；Pinkbin 用户期望也有，但点不到——只能间接从"Chat media cache"清缓存。

**修复面**：在 `scaffolds/wechat-pc.toml` 加
```toml
[[scope]]
id     = "received-images"
label  = "Received images (msg/image)"
glob   = "**/xwechat_files/wxid_*/msg/image/**"
mode   = "recycle"
prompt = { kind = "days", default = 30, label = "Delete received images older than (days)" }
```
+ 同步 `wechat_pc_safety.rs` 加正面/红线断言。

**估算**：1 小时（一个新 scope + 测试）。**强依赖 #1**：如果时间过滤没接通，删图片就是一锅端，风险更高。

---

## P1 — 用户体验差距（不影响安全，影响"想清部分"）

### 3. 多账号（多 wxid）没有 per-account 选择

**现状**：所有 scope glob 是 `**/xwechat_files/wxid_*/...`，**通配所有账号**。一台机器上有公私两个 wxid 时，没法只清一个。

**对比 CleanMyWechat**：顶部下拉选 wxid + "是否清理该账号"复选框。

**修复面**：
- 前端 Studio Card 在 expand 时枚举 `xwechat_files/wxid_*/` 子目录（用 scan tree 现有数据，不再 jwalk）
- 每个 wxid 一行复选框 + 每个 scope 桶按勾选的 wxid 集合过滤
- `execute_scope` 多收一个 `wxid_filter: Option<Vec<String>>`，不在白名单的不删

**估算**：2-3 个工作日。Safety test 要加"未勾选的 wxid 的红线路径不能被删"。

---

### 4. 路径自定义（用户把 WeChat 数据移到 D 盘）

**现状**：`detect` glob 有 `**/xwechat_files` 兜底，**移到任何盘都能扫到**——这个其实**已经覆盖**。但如果用户把目录**重命名**（不叫 xwechat_files），Pinkbin 就找不到。

**对比 CleanMyWechat**：UI 上有"+自定义路径"按钮，输入任意路径。

**修复面**：低优先级。可以延后到 v0.3。如果做，是 Studio Card 加"+自定义路径"按钮 → 写入 `localStorage.pinkbin.scaffold_overrides`，scope_sizes / execute_scope 把 override 路径也算进去。

**估算**：半天，纯前端 + Tauri 多接收一个 root 列表。

---

## P2 — 信息密度 / 工程债

### 5. 把 16 个 scope 桶的"按月份分组"暴露出来

**现状**：用户日志里能看到 `msg/file/2026-04/`、`msg/file/2026-05/` 等月份目录。一个桶（received-files）汇总了所有月份。点"清理"是把所有月份一锅端。

**对比 CleanMyWechat**：没明确分组，但配合 #1 时间过滤可达类似效果。

**修复面**：和 #1 配合即可解决，不单独做。

---

### 6. `scope_sizes` / `execute_scope` 的 jwalk 重复成本

**现状**：每次展开 Studio card → fan out N 次 `scope_sizes`（N = matches 数）→ 每次都从 root_path 重新 jwalk 子树。一个 wechat 卡片展开就会触发 3 次 jwalk（用户 3 个 location）。点"清理"再触发 3 次。每次清理后 refresh 又 3 次。

**用户感知**：在大目录上展开 / 清理时有 1-2 秒"思考"时间。可接受但不优雅。

**修复面**：让 scope_sizes / execute_scope 复用 scan 时已经构建的 `Node` 树（前端持有）——爬树过滤，不再重 jwalk。前端把 `Node` 树或路径子集传过去 / 后端缓存上次 scan 结果。

**估算**：1 个工作日。需要思考 scan 结果的缓存策略（用户重新扫之后失效）。

---

## P3 — Schema 演化债

### 7. `scope.prompt` 字段在 TS types.ts 没有完整镜像

**现状**：[apps/desktop/src/types.ts](../apps/desktop/src/types.ts) 的 `Scope.prompt` 类型可能落后于 Rust 的 `Prompt` enum（`Days` / `Bytes` / `Choice` / `Confirm` / `None`）。修 #1 时务必同步。

**违反 CLAUDE.md "Schema 一致性"硬约束**——下次任何 scope schema 变动都要 audit 这一处。

---

## 验收顺序建议

按依赖关系：
1. 先做 **#1 时间过滤**（最大语义 gap，发布前必须）
2. 再做 **#2 received-images**（依赖 #1 否则风险高）
3. 再做 **#3 多账号选择**（独立功能，可以滞后到 v0.2 后期）
4. **#6 jwalk 重复成本**（v0.2 性能尾巴）
5. **#4 / #5** 进 v0.3 路线图

---

## 也要补的边界情况

- WeChat 4.x 的 `msg/voice2/` 是否被 `msg/attach` 覆盖？需要实测验证。如果不覆盖，加单独 scope。
- 4.x 的 `business/migrate/`、`business/xeditor/` 已在 safety test 红线列表里——确认 scope glob 不会误伤。
- 跨账号数据 `all_users/sqlite/` 是红线，`all_users/head_imgs/` 是 avatar-cache 桶。两者都在 `all_users/` 下面，glob 边界要严。已在 wechat_pc_safety 测过，但加新 scope 时要重测。
