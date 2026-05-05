<!-- Thanks for the PR! Sign off your commits with `git commit -s`. -->

## Summary

<!-- 1–3 bullets -->

## Type

- [ ] Bug fix
- [ ] Feature
- [ ] New scaffold (please fill the section below)
- [ ] Refactor / chore

## New scaffold checklist

新增/重写 scaffold 请按 14-phase 工作流（见 [`.claude/commands/add-scaffold.md`](../.claude/commands/add-scaffold.md)）走全流程，逐项确认：

- [ ] **Phase 0**: 已读 `crates/scaffold/src/lib.rs`、`apps/desktop/src/components/Studio.tsx`、`types.ts`，UI 边界已确认
- [ ] **Phase 1-2**: `docs/scaffold-requirements/<category>.md` 含本 app 的范围 / L1-L2-L3 分级 / 红线
- [ ] **Phase 5-7**: 文档里有 "实测路径映射" 节（与 TOML glob 一致）
- [ ] **Phase 8**: `id` kebab-case 唯一；`risk` 诚实；`disclaimer` 显式列红线
- [ ] **Phase 9**: `cargo run -p pinkbin-scaffold-lint -- scaffolds/<id>.toml` 通过
- [ ] **Phase 10**: `crates/scaffold/tests/<id>_safety.rs` 存在；`cargo test -p pinkbin-scaffold` 通过；含**红线断言**
- [ ] **Phase 11**: 若改了 `Scaffold`/`Scope` 等结构，`cargo check -p pinkbin-desktop` + `pnpm -C apps/desktop exec tsc --noEmit` 都干净
- [ ] **Phase 12-13**: 若改 UI，套了 `<ErrorBoundary>`、用两步确认（不用 `window.confirm`）；`pnpm tauri dev` 实机跑过
- [ ] **Phase 14**: `docs/scaffold-requirements/STATUS.md` 已更新

## Test plan

- [ ] `cargo test --workspace`
- [ ] `pnpm tauri dev` smoke-tested locally
