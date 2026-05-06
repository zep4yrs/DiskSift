# Pinkbin · 它为什么值得相信

我们做的是一个磁盘清理桌面 app，主打**给普通用户简单解决 80% 最常规的磁盘占用**——不是给 geek 的"无限可配置清理框架"，也不是 CCleaner 式的"一键清一切"。下面四点是产品的底层设计原则，不是事后加的栏杆。

## 1. 我们只扫"文件夹结构"，不读用户内容

清理工具最大的隐私风险不是"删错"，是"为了判断要不要删，先把你的聊天记录、笔记、邮件全读一遍"。Pinkbin 的勘测路径是**只列目录名和文件名**，**绝不打开**聊天 DB、媒体文件、账号 key、配置文件等任何**用户产生的内容**。

具体地，scaffold 在描述清理目标时只能用 glob 路径模式（例如 `**/cache/**/*.tmp`），匹配靠路径本身，不靠"读进来看是什么"。这条规矩同时约束 AI 和人类开发者：连 Claude Code 在写 scaffold 的 authoring 期，都被显式禁止 `Read` 任何用户数据目录里的文件，只能 `ls` 和 `Glob`。

→ **隐私不是承诺出来的，是工具链上根本不读。**

## 2. 红线 glob 在 schema 层硬拦

每份 scaffold 在 CI lint 阶段都会被一组**红线 glob** 卡住——任何命中聊天 DB（`*.db` / `*.db-wal` / `**/db_storage/**`）、聊天数据（`**/Msg/**`）、账号状态（`**/Accounts/**` / `**/login/**`）、用户收藏（`**/Favorite*/**`）、加密物料（`**/key/**`）的 scope 直接 lint 失败，根本进不了仓库。

并且每份 scaffold 必须配一份集成 safety test（`crates/scaffold/tests/<id>_safety.rs`），里面有**正向断言**（每个 scope 至少能命中一条真实路径）+ **红线断言**（一组红线路径必须 zero match）。test 不过 = PR 不能 merge。

## 3. AI 在删除路径上"架构性缺席"

这条是产品最关键的设计决定，需要分两层讲，不要混在一起：

**Authoring 期（脚手架搭建期）**：Claude Code 作为"开发者"参与，写 `scaffolds/<id>.toml` 和 safety test。它和人类开发者**走同一条 PR + CI + 人工 review 的通道**，不因为"是 AI 写的"而有特殊豁免——人工 review 是 merge 前的最终审核者。

**Runtime 期（产品运行期）**：产品内置的 AI 顾问（`advisor` crate）**架构上没被赋予** `execute_plan` / `execute_scope` 这两个破坏性命令的调用能力。它能读用量、能解释、能建议，**但接口只能返回文字**。用户看完文字后**自己点 scope 清理按钮**，删除动作永远从用户的点击发起。

→ "AI 误删"在 Pinkbin 不是被防住的，而是**actuation 路径上根本没有 AI 节点**。这是设计阶段的决定，不是事后加的栏杆。

## 4. 默认走系统回收站，破坏性是可逆的

清理动作的默认 mode 是 `recycle`——文件进系统回收站，用户随时能恢复。`delete`（直接删除）只在用户**显式切换**时才会执行。配合 UI 层的强制规矩：调用破坏性命令的组件必须包 `<ErrorBoundary>` + 必须有两步确认或 dry-run 预览（不允许直接 `window.confirm`，因为 Tauri webview 行为不稳定）。

加上前一条的"AI 不在 actuation 路径上"，这构成了一个**冗余兜底**：哪怕用户自己不小心点错了，文件也在回收站里。

## 5. 所有 scaffold 都过社区 PR review

每一份 scaffold 都是开源仓库里的一份 TOML + 一份 safety test，进 main 前必须过 PR review、CI lint、safety test 三道闸。任何人都能审，任何人都能在 issue/PR 里挑战一条 glob 是否过激。**不存在"内部黑盒规则"——能清什么、不能清什么，全在 `scaffolds/` 目录里写得明明白白。**

社区 review 也不是孤立的——它是上面"AI authoring 走人工 review gate"那条规则在工程上的落点：AI 写的东西要被人类看过，人类写的东西也要被另一个人类看过，标准统一。

---

## 一句话总结

> **隐私靠"不读"保证，安全靠"红线 + safety test + 默认回收站"保证，AI 风险靠"架构上让 AI 离 actuation 远一点"保证，可信度靠"所有规则都在 PR 里公开"保证。**
>
> 我们不卖"功能丰富"，卖"结构上不容易出错"。
