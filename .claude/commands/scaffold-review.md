---
description: review 一份已存在的 scaffold，找出它在 14-phase 工作流里漏了哪些环节
---

review `scaffolds/$ARGUMENTS.toml`，把它和 14-phase 工作流（见 `.claude/commands/add-scaffold.md`）逐项对照，输出**漏项清单**。**只做诊断、不动代码**——除非用户明确说"修一下"。

---

## 诊断 checklist

对每一项给出 ✅ / ⚠️ / ❌ 三档：

### Phase 1-2 类别需求
- [ ] `docs/scaffold-requirements/<category>.md` 存在
- [ ] 文档里有该 app 的明确归属（在范围内）
- [ ] L1/L2/L3 分级覆盖到该 app 的所有桶

### Phase 5-7 实测勘测
- [ ] 文档里有该 app 的"实测路径映射"附录
- [ ] 列出的目录树和当前 TOML 的 glob 一致
- [ ] 跨版本（如 3.x vs 4.x）布局对齐

### Phase 8 TOML 本身
- [ ] `id` 唯一、kebab-case
- [ ] `risk` 等级合理
- [ ] `disclaimer` 明确列出红线
- [ ] `detect` 含默认路径 + `**/<datafolder>` 通配
- [ ] 多账号 glob 用 `**/<account-pattern>/...` 形态
- [ ] prompt 类型与 L1/L2 默认行为约定一致
- [ ] 用 `cargo run -p pinkbin-scaffold-lint` 通过

### Phase 10 Safety test
- [ ] `crates/scaffold/tests/<id>_safety.rs` 存在
- [ ] 含正向断言（每个 scope ≥1 条命中路径）
- [ ] 含红线断言（DB / config / login / Favorite 等）
- [ ] `cargo test -p pinkbin-scaffold --test <id>_safety` 通过

### Phase 14 STATUS
- [ ] `docs/scaffold-requirements/STATUS.md` 里该 id 标记为已完成

---

## 输出

按上面 checklist 给出诊断结果，然后**给一个具体行动列表**——按优先级排（红线漏洞 > 缺测试 > 缺文档 > 风格不一致），每项含命令或文件路径。

**例**：
```
诊断 wechat-pc：
✅ Phase 1-2: messaging.md 存在并覆盖 WeChat
✅ Phase 5-7: messaging.md §7 实测附录完整（4.x 布局）
✅ Phase 8: 16 个 scope，lint 通过
✅ Phase 10: wechat_pc_safety.rs 含 20 正 + 28 红线断言
⚠️ Phase 14: STATUS.md 里该行还是 [ ]

行动：
1. 把 STATUS.md 里 wechat-pc 那行勾上、记录 commit hash
```
