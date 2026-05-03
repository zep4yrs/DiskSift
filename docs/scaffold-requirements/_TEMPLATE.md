# <CATEGORY> 类清理需求

> 复制本模板时，把 `<CATEGORY>` 改成实际类别名（messaging / browser / dev-tool / game / media / system / ai 等），删掉本说明节。

> 本文件是后端写 `scaffolds/<id>.toml` 时的需求清单。每条需求都映射到 TOML 字段建议。新增/重写 scaffold 必须先对齐本文件。

## 1. 范围

| 优先级 | 应用 | 状态 |
|------|------|------|
| P0   | <app-A> | 待写 [scaffolds/<a>.toml](../../scaffolds/<a>.toml) |
| P0   | <app-B> | 已有 [scaffolds/<b>.toml](../../scaffolds/<b>.toml)，待 review |
| P1   | <app-C> ... | |

## 2. 数据三级分级 + 默认行为

### L1 可重生缓存（点完即可由应用自动重建）

| 子类 | 描述 | 默认勾选 | 保留期 | 备注 |
|-----|-----|---------|-------|-----|
| 例：图片缓存 | 聊天/页面图片预览缩略图 | ✅ | 30 天 | 删后老内容显示"已过期" |
| ... | | | | |

### L2 可选历史数据（用户原始内容，删除不可恢复）

| 子类 | 描述 | 默认勾选 | 保留期 | 备注 |
|-----|-----|---------|-------|-----|
| 例：接收的文件 | 别人发给你的文档/压缩包 | ✅ | 30 天 | 仍可在原位置"重新下载" |
| ... | | | | |

### L3 红线（任何 scope glob 都不允许命中）

- 通用红线（继承 `CLAUDE.md`）：`*.db` / `*.db-wal` / `*.db-shm` / `**/Accounts/**` / `**/login/**` / `**/config/**` / `**/Favorite*/**` / `**/key/**`
- 类别专属红线：（在此追加该类应用特有的红线，例 IM 类的 `**/Msg/**`）

## 3. 通用 prompt 形态

| Bucket 类型 | `prompt.kind` | default | UI label |
|-----|-----|------|------|
| L1 有保留期 | `days` | 30 / 7 | "Delete X older than (days)" |
| L1 全量 | `none` | – | – |
| L2 接收文件/语音 | `days` | 30 | |
| L2 备份类 | `confirm` | – | |

## 4. 用户偏好（Phase 1-2 访谈结论）

- 多账号场景：（一起清 / 选一个 / 不考虑）
- 默认 `mode`：`recycle` / `quarantine` / `delete`
- 整体 `risk`：`low` / `medium` / `high`

## 5. 给后端的 TOML 设计提示

> 把每条 L1/L2 需求映射到一个 `[[scope]]`。下面是该类别下"标杆 app"的蓝图，其他 app 同结构套用。

| scope id | label | glob 骨架 | mode | prompt |
|----------|-------|-----------|------|--------|
| `xxx-cache` | 例：聊天图片缓存 | `**/<datafolder>/<account>/cache/<bucket>/**` | recycle | days=30 |
| ... | | | | |

> 注：上表 glob 骨架是**初稿**，最终 glob 要由 Phase 5-7 实测后裁剪。

## 6. Disclaimer 文案要点

- 明确"绝不删 X / Y / Z"
- 明确"删除后某些功能可能受影响"
- 明确"全部走系统回收站，N 天内可还原"
- 不要使用"安全"二字

## 7. <APP> 实测路径映射（Phase 5-7 勘测结论）

> 每完成一个 app 的实测，在此追加一节。例见 [messaging.md](messaging.md) 的 §7。

### 7.1 数据根（多版本/多平台）

| 版本/平台 | 默认数据根 | 备注 |
|---|---|---|

### 7.2 目录树（实测）

```text
<root>/
├── ...  (用 L1/L2/L3 标注每个目录)
```

### 7.3 假设修订

> 列出 Phase 1-2 的哪些假设被实测推翻、如何修正主 §2 红线节。

### 7.4 该 app 的 TOML scope 蓝图

| scope id | label | glob | mode | prompt |
|----------|-------|------|------|--------|
