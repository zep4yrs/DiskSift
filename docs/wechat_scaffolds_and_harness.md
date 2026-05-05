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

- **WeChat 4.x 的 `msg/` 不是聊天 DB**，而是用户接收的文件/视频/语音附件（与 3.x 完全相反）。原本计划列入红线的 `**/Msg/`** 在 4.x 会误伤用户内容——这种发现只能通过实测得出。我们已在需求文档里显式修订
- **Schema drift 是隐性炸弹**：Rust 和 TS 各管一半，serde rename 写错了一年都没人发现，直到 UI 改动触发它

---

## 关于"AI 万一判断错了会不会误删"

合作者的担心隐含了一个前提：产品里的 AI 有删除权限。但 Pinkbin 的架构里有**两个完全分开的 AI 角色**——一个在脚手架搭建期、一个在产品运行期——担心只指向运行期那一个，而那一个在设计阶段就没被授予删除权限。

### 两阶段 AI 角色分离


| 阶段         | AI 角色                    | 谁监督                                             | 有无删除权限                           |
| ---------- | ------------------------ | ----------------------------------------------- | -------------------------------- |
| **脚手架搭建期** | Claude Code 作为"开发者"      | 人工是 merge 前的最终审核者（PR review + safety test + CI） | 写 TOML / 测试代码，merge 前必须过人工审核     |
| **产品运行期**  | 产品内 AI 顾问（advisor crate） | 用户自己                                            | **无**——只能输出文字，actuation 路径上没有 AI |


#### 脚手架搭建期：Claude Code 是开发者，不是 actuator

Pinkbin 的所有清理决策都由 `scaffolds/<id>.toml` 决定——哪些 glob 可清、哪些是红线。TOML 是 Claude Code 按 `.claude/commands/add-scaffold.md` 的 14-phase 工作流写的。但它和人类开发者写的代码走**同一条通道**：必须过 `<id>_safety.rs` 红线断言（CI block）、必须过 `cargo run -p pinkbin-scaffold-lint`、必须有人在 PR review 里看过红线节和实测勘测节，没过 review 不能 merge。

AI 写的代码不因为"是 AI 写的"而有特殊豁免，也不被特别怀疑——它和人类 PR 走同一条信任通道。**人工是 merge 前的最终审核者**，这是开发期的信任模型。

#### 产品运行期：AI 在路径外当顾问

产品里用户能对话的 AI（`advisor` crate）**架构上根本没被赋予调用 `execute_plan` / `execute_scope` 的能力**。它的接口只能返回文字。用户问"这个目录是什么、能删吗"，AI 回一段描述/建议，**用户自己看完文字后点 scope 清理按钮**。

这不是"加了栏杆挡住 AI"，而是**根本没把按钮交给 AI**。即使 LLM 完全失控、被 prompt injection 攻陷，它能造成的最坏后果只是给用户一段错误的文字——文件本身要不要清还是用户决定。

### 这是架构性的答案，不是工程防御性的答案

"AI 误删"在很多其他工具里是真实风险——因为它们让 LLM 直接调 shell / 直接 `rm`。Pinkbin 没走那条路。**actuation 路径上没有 AI 节点**这件事是设计阶段的决定，在写第一行代码之前就定了，不是事后加的栏杆。

### 仍然存在的运行期风险（用户自己误点）

架构隔离解决"AI 误删"，但不解决"用户点错"。对后者有几层兜底：

1. **默认走回收站**：`mode = "recycle"` 是所有 scope 的默认值，文件进系统回收站、可一键还原。`mode = "delete"` 只在用户显式选择时生效
2. **两步确认按钮**：首点变红"再点确认"，5s 内再点才真清。没有"清空所有"总按钮——只有 per-scope 单独清
3. **safety test 防红线写宽**：`<id>_safety.rs`（例 `wechat_pc_safety.rs` 那 28 条断言）在 CI 里 block 任何让红线失败的 PR，不管是 AI 还是人写的
4. **OS 层兜底**：Windows 回收站默认不自动清空（除非开 Storage Sense），macOS Trash 类似——文件停留期实际很长

### 风险矩阵


| 风险场景                 | 谁来挡                                                       |
| -------------------- | --------------------------------------------------------- |
| TOML 作者（AI 或人）把红线写宽了 | safety test 红线断言（CI 强制）+ PR review                        |
| 用户误点清理按钮             | 两步确认 + recycle bin 可还原                                    |
| AI 顾问给错文字建议          | 文字仅 advisory，actuation 路径上没有 AI——用户自己点按钮 + recycle bin 兜底 |
| 上游 OS API 异常         | `trash` crate 报错抛上来，不会默默 unlink                           |


### 给合作者的一句话

> 担心"AI 误删"的前提是 AI 有删除权限。Pinkbin 在架构上就**没把按钮交给产品内的 AI**——它只能输出文字。脚手架搭建期那个写 TOML 的 Claude Code 确实在写代码，但和人类开发者一样要过 PR review、过 safety test 才能 merge。**人工是 merge 前的最终审核者，AI 不是。**

