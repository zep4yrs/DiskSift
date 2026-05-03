# 2026-05-03 · WeChat scaffold + 工作流基建

## 这次做了什么

两个 commit，业务和基建分开。

### Commit `de20d35` · WeChat 业务（14 文件 / +841 / -25）

- **TOML 重写**：`scaffolds/wechat-pc.toml` 从 4 个 scope 扩成 16 个，同时覆盖 4.x（`xwechat_files` / `Weixin.exe`）和 3.x legacy
- **类别需求文档**：`docs/scaffold-requirements/messaging.md`，含 L1/L2/L3 分级 + WeChat 实测路径附录
- **安全测试**：`crates/scaffold/tests/wechat_pc_safety.rs`，20 条正向断言 + 28 条红线断言
- **UI 接通**：`Studio.tsx` 展开后渲染"脚本可清的桶"列表（label + 实测大小 + 单独清理按钮），两步式确认（首点变红、5s 内再点真清）
- **后端命令**：新增 `scope_sizes` / `execute_scope` Tauri 命令
- **ErrorBoundary**：`main.tsx` + Studio 各套一层
- **修了一个潜伏 bug**：Rust 的 `#[serde(rename = "scope")]` 单向写导致 JSON 字段是 `scope`、TS 的 `sc.scopes` 永远 undefined。老 UI 不读 scopes 没暴露，新 UI 一加就白屏。改成 `rename(deserialize = "scope", serialize = "scopes")` 修复

### Commit `5b39d8c` · 工作流基建（8 文件 / +697 / -5）

把"为常用软件编写清理 scaffold"的 14-phase 工作流固定下来：

- `CLAUDE.md` · 仓库级硬约束，Claude Code 每次会话自动读
- `.claude/commands/{add-scaffold,scaffold-review}.md` · 两个 slash command
- 三套模板（TOML / safety test / req doc）放子目录避开 `load_dir` 和 cargo test 自动发现
- `docs/scaffold-requirements/STATUS.md` · 38 scaffold 进度台账
- `.github/PULL_REQUEST_TEMPLATE.md` 扩成 14-phase 逐项确认
- `docs/HOWTO.md` · 我自己用的速查（人类视角）

### 几个关键发现

- **WeChat 4.x 的 `msg/` 不是聊天 DB**，而是用户接收的文件/视频/语音附件（与 3.x 完全相反）。原本计划列入红线的 `**/Msg/**` 在 4.x 会误伤用户内容——这种发现只能通过实测得出。我们已在需求文档里显式修订
- **Schema drift 是隐性炸弹**：Rust 和 TS 各管一半，serde rename 写错了一年都没人发现，直到 UI 改动触发它

---

## 关于"一键清理是危险功能、万一 AI 判断错了"

合作者的顾虑里藏了两个假设——其实都不成立：

| 隐含假设 | 真实情况 |
|---|---|
| 有"一键清理"按钮把所有都清了 | UI 上**没有**这种按钮。每个 scope 都是单独的清理按钮，用户自己挑桶 |
| AI 决定哪些文件被删 | AI **不在 actuation 路径上**。它只在用户主动点"问 AI"时给出文字意见 |

### Pinkbin 里 AI 在哪、不在哪

| 环节 | 决策者 | 是否 AI |
|---|---|:---:|
| 哪些 glob 可清 | scaffold TOML（人写、PR review、safety test 验证） | ❌ |
| 实测哪个文件命中 glob | `globset` crate（确定性匹配） | ❌ |
| 文件去哪 | `executor` crate（默认走 recycle bin） | ❌ |
| 用户提问 "这是什么、能删吗" | LLM（advisor crate） | ✅ 但仅文字、不操作文件 |

**AI 是顾问，不是 actuator**。即使 AI 完全判断错了，它能造成的最坏后果是给用户一段错误描述——文件本身要不要清还是用户点按钮决定。

### 四层防御

1. **Authoring 层**：scaffold TOML 是人写的，必须按 14-phase 工作流走流程，过 PR review 才能进 main。`<id>_safety.rs` 把红线变成可执行断言（例：`wechat_pc_safety.rs` 那 28 条 "这些路径绝不能被任何 scope glob 命中"），CI block 任何让它失败的 PR

2. **Runtime 层**：
   - `mode = "recycle"` 是所有 scope 的默认值，文件进系统回收站、用户可一键还原，**不是 `unlink`**
   - 两步确认按钮（首点变红"再点确认"，5s 内再点才真清）
   - **没有"清空所有"的总按钮**——UI 只有 per-scope 单独清，用户必须挑桶、挑保留期

3. **AI 顾问层**：仅当用户主动点"问 AI"时才介入。给出的是文字描述+建议，**不能自己点按钮**——必须用户看完文字后自己决策

4. **OS 层兜底**：Windows 回收站默认不自动清空（除非用户开了 Storage Sense），文件停留期实际很长；macOS Trash 类似

### 风险矩阵

| 风险场景 | 谁来挡 |
|---|---|
| TOML 作者把红线写宽了 | safety test 红线断言（CI 强制）+ PR review |
| 用户误点清理按钮 | 两步确认 + recycle bin 可还原 |
| AI 顾问给错文字建议 | 文字仅 advisory，用户自己点按钮 + recycle bin 兜底 |
| 上游 OS API 异常 | `trash` crate 报错抛上来，不会默默 unlink |

唯一会造成**真不可恢复**损失的场景：用户**主动**把 scope `mode` 从 `recycle` 改成 `delete` + TOML 红线写错 + safety test 没覆盖 + PR review 没看出来——**四层全失效**。这种场景在任何清理工具里都会出问题，不是 Pinkbin 或 AI 特有的风险。

### 给合作者的一句话

> Pinkbin 的清理决策树是 **"人写 TOML + 测试断言红线 + 用户两步确认 + 文件走回收站"**，AI 在路径外当顾问。担心 AI 判断错的同理也该担心 `rm` 命令——但 Pinkbin 设了四层栏杆挡住它，`rm` 没有。
