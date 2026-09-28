# v26.1.4.0 发布计划：实时监控 + 迁移引擎 + 扫描取消 + 排除规则 + 虚拟滚动 + 真菜单

> 状态：**计划稿（扩容版），未动工**。用户裁定原范围"带动太少"，本版为七道菜的功能大版本。
> 版本规则： manifests 26.1.3 → **26.1.4**，APP_VERSION → **26.1.4.0**（VERSIONING.md 四处同步）。

## 0. 范围

**IN（七道菜）**
1. USN Journal 实时监控（上游 #29）
2. 迁移引擎 + 「建议迁移」落地（原 O4 内置化）
3. 扫描取消/暂停（上游 plan.md 遗留 1.5/建议7）
4. 自定义排除规则（用户级 NEVER_TOUCH）
5. 树虚拟滚动（上游 plan.md 遗留 3.2/建议9）
6. 跨盘并行复制引擎（上游 plan.md 遗留 4.2，被 2/迁移复用）
7. 顶带五菜单接真下拉（审计单 §2-2）

**OUT（防蔓延）**
- O4 的 BlueTidy 外部深链——「建议迁移」内置化后语义并入菜 2
- 跨平台矩阵（26.1.5.0）、非 NTFS 卷实时监控、品牌字体更换

---

## 1. USN Journal 实时监控（设计不变，见 §旧版保留于 git 历史）

monitor crate 五模块：`journal`（卷句柄 + USN 轮询 + journal 创建）/ `filter`（rename/create/delete/overwrite + 卷前缀）/ `aggregate`（500ms 折叠受影响目录）/ `refresh`（脏子树限深 walkdir 增量重算，1s 节流）/ `emit`（Tauri event `usn://changes`）。前端 `useMonitor` + 设置页开关 + 增量更新图/树/分诊。红线：只读；非 NTFS 明示不支持；积压 >1000 目录降级"建议重扫"。

## 2. 迁移引擎 + 「建议迁移」落地

### 2.1 Rust（executor 新增 `move_engine.rs`）
- **同卷**：`std::fs::rename` 瞬时完成
- **跨盘**：并行复制流水线——文件级任务队列 + N worker（默认 4，可配）+ SHA-256 校验 + 校验通过才删源；**任意失败回滚已复制目标文件，绝不删源**
- 支持取消令牌（与菜 3 的取消通道同一机制）
- 台账：写 `undo.jsonl`（action=migrate，双向记录 src/dst，支持回迁）
- 菜 6：quarantine 跨盘路径改走 MoveEngine（消灭单线程 `copy_dir_recursive`，plan.md 4.2）

### 2.2 前端
- 分诊「迁移」判定行 + 详情卡新增「迁移到…」：目标盘选择器（列卷 + 剩余空间 + 同/跨盘提示）
- 进度条（字节 + 文件数，事件 `migrate://progress`）；完成/失败/已回滚提示
- 操作记录页：迁移条目可「回迁」一键反向

### 2.3 监控联动
迁移期间 USN 对源/目标目录变更**照常上报**（图上自然反映），不做白名单

## 3. 扫描取消

- `scan_with` 接 `Arc<AtomicBool>` 中止信号（上游建议7 原案），消费循环每 N 条检查；MFT 路径同样可中断
- 前端扫描按钮 → 进度态出现「取消」；取消后**保留部分结果**并 banner 标注"已取消 · 部分结果"，分诊/巡查对部分结果正常工作
- 取消响应 ≤1s

## 4. 自定义排除规则

- 规则三型：目录路径 / glob / 扩展名；启停开关；存 `%APPDATA%/DiskSift/excludes.json`（tmp+rename 原子写）
- **四处遵守**：scanner `build_tree` 剪枝 / 分诊 classify / USN filter / 一键清扫执行前复核
- 设置页管理 UI（列表 + 新增 + 启停 + 删除）+ **预览工具**：输入规则即时高亮"会命中哪些已扫目录"
- 与 NEVER_TOUCH 关系：叠加生效，用户规则只能**收紧**可见面，不能解除保护区

## 5. 树虚拟滚动

- `@tanstack/react-virtual`：展开集合 → 可见行扁平数组 → 虚拟渲染（替换 `children.slice(0, 500)` 补丁，TreeView.tsx:403）
- 兼容改造：focusPath scrollIntoView（scrollToIndex）、键盘导航（↑↓ 跨行）、判定色条/圆环/右键菜单坐标
- 空间图已剪枝（≤4 万节点）不动；验收 = 80 万文件树全展开滚动不掉帧、DOM 行数恒定（≤ 可视行 + overscan）

## 6. 真菜单（设计不变）

文件/编辑/查看/扫描/帮助 五菜单数据驱动；查看=主题/字号/三区域开关（复选标记）；扫描=开始/重扫/诊断；文件=选目录/导入 TOML/退出；帮助=关于/README/GitHub。键盘 ↑↓ Enter、Esc 外点收起；灰项必须灰 + title 说明，禁假可用。

---

## 7. 任务拆解

| # | 任务 | 依赖 |
| --- | --- | --- |
| 1 | monitor crate 骨架 + journal.rs + 单测 | — |
| 2 | filter/aggregate/refresh + 单测 | 1 |
| 3 | Tauri 命令 monitor_start/stop/status + 事件 | 2 |
| 4 | 前端 useMonitor + 设置页 + 增量更新 | 3 |
| 5 | MoveEngine（rename/并行 copy/校验回滚/取消/台账）+ 单测 | — |
| 6 | 扫描取消通道 + 前端取消按钮 + 部分结果 | — |
| 7 | 排除规则引擎 + 四处接线 + 管理 UI + 预览 | — |
| 8 | 树虚拟滚动改造 | — |
| 9 | 真菜单 | — |
| 10 | 「迁移到…」前端全链路 + 操作记录回迁 | 5 |
| 11 | 版本号四处同步 + README 路线图 | 全部 |
| 12 | 门禁（tsc/build/cargo test --workspace）+ 独立复核 | 全部 |
| 13 | 构建安装包 + CNB/GitHub 发版 | 12 |

并行分组：{5,6,7,8,9} 五线可并行；{1→2→3→4} 串行；最后 10→11→12→13。

## 8. 验收标准

- [ ] 扫描后开监控：资源管理器新建/删除/改名，空间图对应目录 **≤2 秒**变化；关闭后零 CPU
- [ ] NEVER_TOUCH 目录变更仅展示，无动作可触发；用户排除规则四处生效一致
- [ ] 迁移 10GB 目录：同卷 ≤1s（rename）；跨盘并行对比单线程提速 ≥2.5x；校验失败回滚且源完好
- [ ] 扫描取消 ≤1s 响应，部分结果可用且带 banner
- [ ] 80 万文件树全展开滚动不掉帧，DOM 行数恒定
- [ ] 五菜单真动作、键盘全可达、无假可用项
- [ ] 门禁：tsc + vite build + cargo test --workspace 全绿；独立复核对照本计划逐条核验

## 9. 发布 checklist

- [ ] VERSIONING.md 四处同步（26.1.4 / 26.1.4.0）
- [ ] 安装包 NSIS + MSI 上桌面
- [ ] CNB main + tag v26.1.4.0 + Release（asset-upload-url 三段式）
- [ ] GitHub main + tag + Release
- [ ] README 路线图勾选 + 版本徽章
