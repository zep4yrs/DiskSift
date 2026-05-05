# 给我自己的速查（人类视角）

> 这是给我（人）看的"该往 Claude Code 里敲什么"。AI 视角的硬约束在 [CLAUDE.md](../CLAUDE.md)。

## 1. 新做一个 scaffold

新对话窗口直接打：

```
/add-scaffold qq-pc
```

Claude 会自动按 14-phase 走。我只要做三件事：
- **答题**（弹出来的 `AskUserQuestion`：默认行为、保留期、红线、多账号策略）
- **贴真实路径**（去 app 设置 → 文件管理看；自定义盘给绝对路径）
- **看每 phase 报告**，对就放过、不对补一句话纠正

经验值：~30-60 分钟一个。

## 2. 看已有 scaffold 哪儿没做完

```
/scaffold-review chrome
```

只诊断、不改。需要修说一句"按这个清单修一下"。

## 3. 临时小改

不要用 slash command，直接描述：

> 把 wechat-pc 的 video-cache 默认从 7 天改成 14 天

Claude 会改 + 跑 lint + 跑 safety test，不会拉起完整 14-phase。

## 4. 我会被问到的几类题

| 类目 | 一般答法 |
|---|---|
| L1 缓存默认行为 | "默认勾选 + 保留 30 天"（视频 7 天） |
| L2 历史数据 | "默认勾选 + 30 天 + 走回收站" |
| Backup 类 | "默认不勾选，要 confirm" |
| 多账号 | "一起清"（glob 用 `**/<account>/...`） |
| 红线（通用之外） | 看类别独有：游戏存档 / IDE 项目历史 / 浏览器密码 / 邮件本地缓存 |

## 5. 改 Rust 后必须重启 tauri dev

Vite HMR 只管前端。**`crates/` 或 `src-tauri/` 改了 → Ctrl+C 再 `pnpm tauri dev`**。

## 6. 命令速查

```bash
cargo run -p pinkbin-scaffold-lint -- scaffolds/<id>.toml   # lint 单个
cargo test -p pinkbin-scaffold                               # 跑全部 safety test
cargo test -p pinkbin-scaffold --test <id>_safety            # 单个 safety test
pnpm -C apps/desktop exec tsc --noEmit                        # TS 类型检查
pnpm tauri dev                                                # 跑桌面 app
```

## 7. 卡住时怎么办

| 症状 | 大概率原因 | 救法 |
|---|---|---|
| 桌面 app 白屏 | 组件抛错 | 看 ErrorBoundary 红框里的 stack trace |
| `sc.scopes is undefined` | Rust JSON ↔ TS 类型字段名漂移 | 检查 `serde(rename(...))` deserialize/serialize 是否分开写 |
| Safety test 红线断言失败 | scope glob 写宽了 | **收紧 glob，绝不放宽测试** |
| Lint 报 `bad glob` | 花括号 `{a,b}` 或字符类语法错 | 对照 `scaffolds/feishu.toml` 的写法 |
| 桌面 dev 没看到我新加的 scope 桶 | 多半是 tauri dev 没重启 | Ctrl+C → `pnpm tauri dev` |

## 8. 改完后

- 每完成一个 phase 就 commit，msg 习惯 `[phase-N] xxx`
- `docs/scaffold-requirements/STATUS.md` 把 `⏳`/`❌` 改成 `✅`
- 推之前跑一遍 `cargo test -p pinkbin-scaffold` 兜底

## 9. 给合作者上手的话术

> clone 仓库 → Claude Code 在仓库根打开 → CLAUDE.md 会自动加载 →
> 想做哪个 app 就 `/add-scaffold <id>`，按 phase 提示走就行 →
> 不确定就敲 `/scaffold-review <id>` 看哪儿没做完

合作者读完 [CLAUDE.md](../CLAUDE.md) + 这份就够了，不需要其他文档。
