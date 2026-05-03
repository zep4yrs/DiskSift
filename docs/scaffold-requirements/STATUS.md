# Scaffold 进度台账

> 跟踪 38 个 scaffold 在 14-phase 工作流（[`.claude/commands/add-scaffold.md`](../../.claude/commands/add-scaffold.md)）下的状态。新增/重写后请同步更新本表。

## 列含义

- **Req doc**：该应用所属类别的 `docs/scaffold-requirements/<category>.md` 已含本应用的"实测附录"节
- **TOML**：`scaffolds/<id>.toml` 通过 `cargo run -p diskwise-scaffold-lint`
- **Safety test**：`crates/scaffold/tests/<id>_safety.rs` 存在且 `cargo test` 通过
- **UI 验证**：在桌面 dev app 里目视确认 scope 列表 + 大小 + 清理按钮工作正常

## Messaging / IM

类别需求文档：[messaging.md](messaging.md)

| Scaffold | Req doc | TOML | Safety test | UI 验证 | 备注 |
|---|:---:|:---:|:---:|:---:|---|
| wechat-pc | ✅ | ✅ | ✅ | ⏳ | 含 4.x 主线 + 3.x legacy 共 16 scope |
| qq | ⏳ | ✅(legacy) | ❌ | ❌ | 待按本流程 review |
| dingtalk | ⏳ | ✅(legacy) | ❌ | ❌ | 待 review |
| feishu | ⏳ | ✅(legacy) | ❌ | ❌ | 待 review |
| slack | ⏳ | ✅(legacy) | ❌ | ❌ | 待 review |
| discord | ⏳ | ✅(legacy) | ❌ | ❌ | 待 review |
| telegram | ⏳ | ✅(legacy) | ❌ | ❌ | 待 review |
| teams | ⏳ | ✅(legacy) | ❌ | ❌ | 待 review |

## Browsers

类别需求文档：⏳ 待写

| Scaffold | Req doc | TOML | Safety test | UI 验证 | 备注 |
|---|:---:|:---:|:---:|:---:|---|
| chrome | ❌ | ✅(legacy) | ❌ | ❌ | |
| edge | ❌ | ✅(legacy) | ❌ | ❌ | |
| firefox | ❌ | ✅(legacy) | ❌ | ❌ | |
| brave | ❌ | ✅(legacy) | ❌ | ❌ | |

## Dev tools

类别需求文档：⏳ 待写

| Scaffold | Req doc | TOML | Safety test | UI 验证 | 备注 |
|---|:---:|:---:|:---:|:---:|---|
| cursor | ❌ | ✅(legacy) | ❌ | ❌ | |
| vscode | ❌ | ✅(legacy) | ❌ | ❌ | |
| jetbrains | ❌ | ✅(legacy) | ❌ | ❌ | |
| docker | ❌ | ✅(legacy) | ❌ | ❌ | |
| cargo | ❌ | ✅(legacy) | ❌ | ❌ | |
| npm | ❌ | ✅(legacy) | ❌ | ❌ | |
| pnpm | ❌ | ✅(legacy) | ❌ | ❌ | |
| yarn | ❌ | ✅(legacy) | ❌ | ❌ | |
| pip | ❌ | ✅(legacy) | ❌ | ❌ | |
| conda | ❌ | ✅(legacy) | ❌ | ❌ | |
| go-mod | ❌ | ✅(legacy) | ❌ | ❌ | |
| gradle | ❌ | ✅(legacy) | ❌ | ❌ | |
| maven | ❌ | ✅(legacy) | ❌ | ❌ | |
| nuget | ❌ | ✅(legacy) | ❌ | ❌ | |
| node-modules | ❌ | ✅(legacy) | ❌ | ❌ | |

## Games

类别需求文档：⏳ 待写

| Scaffold | Req doc | TOML | Safety test | UI 验证 | 备注 |
|---|:---:|:---:|:---:|:---:|---|
| steam | ❌ | ✅(legacy) | ❌ | ❌ | |
| epicgames | ❌ | ✅(legacy) | ❌ | ❌ | |
| battlenet | ❌ | ✅(legacy) | ❌ | ❌ | |

## Media / AI

类别需求文档：⏳ 待写

| Scaffold | Req doc | TOML | Safety test | UI 验证 | 备注 |
|---|:---:|:---:|:---:|:---:|---|
| huggingface | ❌ | ✅(legacy) | ❌ | ❌ | |
| ollama | ❌ | ✅(legacy) | ❌ | ❌ | |
| spotify | ❌ | ✅(legacy) | ❌ | ❌ | |
| obs | ❌ | ✅(legacy) | ❌ | ❌ | |

## System

类别需求文档：⏳ 待写（红线最少，可能合并到通用文档）

| Scaffold | Req doc | TOML | Safety test | UI 验证 | 备注 |
|---|:---:|:---:|:---:|:---:|---|
| crash-dumps | ❌ | ✅(legacy) | ❌ | ❌ | |
| windows-temp | ❌ | ✅(legacy) | ❌ | ❌ | |
| windows-old | ❌ | ✅(legacy) | ❌ | ❌ | |
| recycle-bin | ❌ | ✅(legacy) | ❌ | ❌ | 操作即清空，需 confirm |

---

**图例**：✅ 完成 / ⏳ 进行中 / ❌ 未开始 / `(legacy)` 在本流程之前就有 TOML，但未按 14-phase 验证过
