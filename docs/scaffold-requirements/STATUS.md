# Scaffold 进度台账

> 跟踪 scaffold 在 14-phase 工作流（[`.claude/commands/add-scaffold.md`](../../.claude/commands/add-scaffold.md)）下的状态。新增/重写后请同步更新本表。

## 列含义

- **Req doc**：该应用所属类别的 `docs/scaffold-requirements/<category>.md` 已含本应用的"实测附录"节
- **TOML**：`scaffolds/<id>.toml` 通过 `cargo run -p pinkbin-scaffold-lint`
- **Safety test**：`crates/scaffold/tests/<id>_safety.rs` 存在且 `cargo test` 通过
- **UI 验证**：在桌面 dev app 里目视确认 scope 列表 + 大小 + 清理按钮工作正常

## Messaging / IM

类别需求文档：[messaging.md](messaging.md)

| Scaffold | Req doc | TOML | Safety test | UI 验证 | 备注 |
|---|:---:|:---:|:---:|:---:|---|
| wechat-pc | ✅ | ✅ | ✅ | ⏳ | 4.x 主线 13 scope + 3.x legacy 9 scope |

## Dev tools

| Scaffold | Req doc | TOML | Safety test | UI 验证 | 备注 |
|---|:---:|:---:|:---:|:---:|---|
| conda | ⏳ | ✅ | ✅ | ⏳ | env 卡片专用 UI；整目录 recycle |
| cargo | ✅ | ✅ | ✅ | ⏳ | registry/git 缓存 + 项目 target/{debug,release}（CACHEDIR.TAG 判别）；2026-09-28 重做（见 2026-05-05 清理） |
| go-mod | ✅ | ✅ | ✅ | ⏳ | pkg/mod 整树 directory 粒度（= go clean -modcache）+ sumdb + go-build hex 对象 30 天；2026-09-28 重做（见 2026-05-05 清理） |
| gradle | ✅ | ✅ | ✅ | ⏳ | caches 整树 directory 粒度（= 删 ~/.gradle/caches）；wrapper/dists·daemon·native 红线；2026-09-28 重做（见 2026-05-05 清理） |
| maven | ✅ | ✅ | ✅ | ⏳ | repository 整树 directory 粒度（= 删 ~/.m2/repository）；settings.xml·wrapper/dists·项目 target/ 红线；本机无 Maven，路径按官方布局（文件头声明）；2026-09-28 重做（见 2026-05-05 清理） |
| nuget | ✅ | ✅ | ✅ | ⏳ | 三桶 directory 粒度（global-packages / v3-cache / plugins-cache，= dotnet nuget locals）；NuGet.Config·Migrations 红线；2026-09-28 重做（见 2026-05-05 清理） |
| docker | ✅ | ✅ | ✅ | ⏳ | Docker Desktop 缓存桶；本机未装 Docker，布局按官方文档（文件头声明）；2026-09-28 重做（见 2026-05-05 清理） |

## Browsers

| Scaffold | Req doc | TOML | Safety test | UI 验证 | 备注 |
|---|:---:|:---:|:---:|:---:|---|
| chrome | ✅ | ✅ | ✅ | ⏳ | Chromium 通用桶设计；本机未装 Chrome，布局按官方文档 + Chromium 桶分级（文件头声明）；2026-09-28 重做（见 2026-05-05 清理） |
| edge | ✅ | ✅ | ✅ | ⏳ | Chromium 通用桶，结构对齐 chrome.toml；本机 Edge 已移除，按官方布局（文件头声明）；2026-09-28 重做（见 2026-05-05 清理） |
| firefox | ✅ | ✅ | ✅ | ⏳ | Gecko 布局，按 profiles.ini 定位；本机装有 Firefox，目录名为实测；2026-09-28 重做（见 2026-05-05 清理） |
| brave | ✅ | ✅ | ✅ | ⏳ | Chromium 通用桶，结构对齐 chrome.toml；本机未装 Brave，按官方布局（文件头声明）；2026-09-28 重做（见 2026-05-05 清理） |

## AI / 模型缓存

| Scaffold | Req doc | TOML | Safety test | UI 验证 | 备注 |
|---|:---:|:---:|:---:|:---:|---|
| huggingface | ✅ | ✅ | ✅ | ⏳ | hub 模型/数据集缓存按官方 manage-cache 桶结构点名；token / modules 红线；2026-09-28 重做（见 2026-05-05 清理） |

---

**图例**：✅ 完成 / ⏳ 进行中 / ❌ 未开始

## 历史

2026-05-05：删除 36 个未经 14-phase 验证的 legacy scaffold（qq · feishu · dingtalk · slack · discord · telegram · teams · chrome · edge · firefox · brave · cursor · vscode · jetbrains · docker · cargo · npm · pnpm · yarn · pip · go-mod · gradle · maven · nuget · node-modules · steam · epicgames · battlenet · huggingface · ollama · spotify · obs · crash-dumps · windows-temp · windows-old · recycle-bin）。原因：legacy scaffold 都没有 safety test，glob 边界没人验过，存在误删用户数据的风险（典型例子：`node-modules` 把 Cursor / VSCode / 游戏内嵌的 node_modules 也命中了）。未来按 14-phase 流程逐个重新加回。
