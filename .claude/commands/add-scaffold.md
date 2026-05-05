---
description: 按 14-phase 工作流为指定 app 编写清理 scaffold（含需求采集、实测勘测、TOML、safety test、UI 集成）
---

为 app `$ARGUMENTS` 编写或重写一份 scaffold TOML。**严格按以下 phase 顺序执行，每个 phase 完成后向用户报告进展并在必要时确认**。绝不跳步——每一步都是上一次踩坑的产物（详见 `CLAUDE.md`）。

---

## Phase 0 — Schema + UI 边界审查

读完这三个文件再开始任何实质工作：

1. `crates/scaffold/src/lib.rs` —— `Scaffold` / `Scope` / `Mode` / `Prompt` 定义、`detect_for` 匹配逻辑、`expand_env` 路径展开
2. `apps/desktop/src/components/Studio.tsx` —— 当前 UI 如何渲染 scope（重点看 expanded card 部分调用了 `sc.scopes` 的什么字段）
3. `apps/desktop/src/types.ts` —— TS 镜像类型

**报告**：当前 UI 是否已经能渲染你计划的 scope 形态？如果差距大，**先去对齐 UI**（或者明确告诉用户"TOML 写完了 UI 看不到"），再回来。

---

## Phase 1-2 — 类别需求采集 → 落盘文档

`$ARGUMENTS` 属于哪个类别（messaging / browser / dev-tool / game / media / system / ai）？

- 如果 `docs/scaffold-requirements/<category>.md` 已存在 → 读它，确认本应用是否已在范围内、L1/L2/L3 分级是否覆盖
- 如果不存在 → 复制 `docs/scaffold-requirements/_TEMPLATE.md`，用 `AskUserQuestion` 驱动结构化访谈，把答案落进去

访谈必问项：
- 类别下要覆盖哪些应用、优先级
- L1 缓存（可重生）默认行为：勾选/不勾选、保留 N 天 / 全量
- L2 历史（用户内容）默认保留期、是否暴露 Backup
- 多账号场景如何处理
- mode 默认值（recycle / quarantine / delete）
- 红线：除通用红线外还有哪些必须豁免

---

## Phase 3 — 列出典型路径候选

为 `$ARGUMENTS` 给出**所有合理候选**：

- 安装路径（多版本、32/64 bit、用户自定义盘）
- 数据存储路径（默认 + 自定义盘）
- 缓存 / state 路径（`%APPDATA%` / `%LOCALAPPDATA%` / `~/.config` / `~/Library` 等）
- 多平台差异（Windows / macOS / Linux 如适用）

**报告**：把候选清单贴给用户，告诉他下一步要在自己机器上确认。

---

## Phase 4 — 用户确认实际路径

用 `AskUserQuestion` 让用户从候选里选 + 提供绝对路径。**不要假设默认就够**——很多人会改盘符。

---

## Phase 5 — 实测勘测（Glob/`ls` 仅列文件夹名）

逐层下钻用户给的实际路径。**严禁 `Read` 任何文件内容**（隐私 + 不必要）。重点关注：

- 顶层布局
- 多账号目录命名（`wxid_*` / `<手机号>` / `accounts/<id>` 等）
- 大头桶名称（image / video / file / cache / temp / msg / Backup / log / crashinfo / ...）
- "看起来是 DB 但其实不是" / "看起来不是 DB 但其实是" 的目录（`msg/` 在 WeChat 4.x 是用户文件，不是 DB）

把目录树贴给用户**确认你的推断**，再继续。

---

## Phase 6 — 文件夹作用推断 + L1/L2/L3 映射

把 Phase 5 实测的每个目录映射到 L1（可重生缓存）/ L2（用户历史，可选清）/ L3（不可碰红线）。**保守优先**——拿不准的进 L3。

---

## Phase 7 — 回环：修订需求文档

把 Phase 5-6 的发现追加到 `docs/scaffold-requirements/<category>.md` 的 "实测附录" 节。**这一步在写 TOML 之前完成**，不是之后。

如果实测推翻了 Phase 1-2 的假设（例：某个被列为红线的目录其实是用户内容），**显式标注修订**，并更新主 §2 红线节。

---

## Phase 8 — 写 TOML

复制 `scaffolds/_templates/scaffold.toml` 到 `scaffolds/<id>.toml`，按 Phase 7 的需求文档填充：

- `id`: kebab-case，全仓库唯一
- `risk`: low（仅清缓存/废弃文件）/ medium / high
- `disclaimer`: 显式列出"绝不删 X / Y / Z"，不要用"安全"这种空话
- `detect`: 含默认路径 + 通配（`**/<datafolder>`）兼容自定义盘 + 多版本
- `[[scope]]` 块：每个 L1/L2 桶一块，glob 用 `**/<account-pattern>/<bucket>/**` 形态兼容多账号
- `prompt`: L1 cache 用 `days` 默认 30（视频可 7）；全量清用 `none`；L2 Backup 类用 `confirm`

跨版本兼容（例：3.x + 4.x）：在同一份 TOML 内**追加 legacy scope**，glob 用旧版路径，4.x 用户那边自然 0 命中。

---

## Phase 9 — Lint

```bash
cargo run -p pinkbin-scaffold-lint -- scaffolds/<id>.toml
```

必须 `ok:`。任何错误先修。

---

## Phase 10 — Safety test

复制 `crates/scaffold/tests/_templates/scaffold_safety.rs` 到 `crates/scaffold/tests/<id>_safety.rs`，填入：

- **正向断言**：每个 scope id 至少一条 `(scope_id, "/realistic/path/that/should/match")`
- **红线断言**：一组绝不应被任何 scope 命中的路径（聊天 DB、config、login、Favorite、用户原创文件夹、各家平台特有红线）

```bash
cargo test -p pinkbin-scaffold --test <id>_safety
```

必须 1 passed; 0 failed。如果红线被命中，**收紧对应 scope 的 glob**，不要放宽测试。

---

## Phase 11 — Schema 一致性

如果 Phase 8-10 改了 `crates/scaffold/src/lib.rs` 的结构，验证：

```bash
cargo check -p pinkbin-desktop                  # Rust 编译干净
pnpm -C apps/desktop exec tsc --noEmit          # TS 镜像类型对齐
```

特别留意 `serde(rename ...)` ——deserialize/serialize 双向 rename 必须分开写，否则 JSON 字段名漂移会让前端拿到 undefined。

---

## Phase 12 — UI 集成（如必要）

如果 Phase 0 发现 UI 缺渲染：

- 后端：可能要加 Tauri 命令（如 `scope_sizes` 计算每个 scope 实际占用、`execute_scope` 按 glob 过滤后再清）
- 前端：在 `Studio.tsx` 卡片展开区加 scope 列表渲染；务必：
  - 套 `<ErrorBoundary>`
  - 用 useEffect + cancellation flag 拉数据
  - 破坏性按钮用**两步确认**（首点变红色"再点确认"，5s 内再点真清），**不要 `window.confirm`**

---

## Phase 13 — 前端测试

```bash
pnpm -C apps/desktop exec tsc --noEmit
pnpm -C apps/desktop exec vite build
pnpm tauri dev   # 跑起来打开桌面 app，目视确认 scope 列表 + 大小 + 清理按钮
```

---

## Phase 14 — Commit + 更新 STATUS

按工作类别拆 commit：

- 业务 commit：`scaffolds/<id>.toml` + `docs/scaffold-requirements/<category>.md` + `crates/scaffold/tests/<id>_safety.rs`（+ 必要的 schema 改动）
- UI commit（如有）：Tauri 命令 + Studio.tsx + types.ts + ErrorBoundary 等

更新 `docs/scaffold-requirements/STATUS.md`，把 `<id>` 行从 `[ ]` 改成 `[x]`、记录 commit hash。

---

**完成后向用户汇报**：scaffold id、scope 数、safety test 命中的红线条数、实测时发现的与初始假设不同的点（这些是宝贵的"实测附录"内容）。
