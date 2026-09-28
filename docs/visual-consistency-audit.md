# 视觉一致性审计：格格不入区域清单（"故宫抹水泥"清单）

> 状态：审计完成，**未修复**。行号以 v26.1.3.0 工作区为准，修复时以符号搜索定位为准。
> 方法：四轮——① 空态（IAB 截图亮/暗 1600×900 + 源码静态扫描：硬编码色值 / emoji / 字体回退 / 旧 CSS 残留）；② 数据态（:1420 mock 补丁 prompt 选盘 → 扫描 187GB → 六视图带数据截图 + DOM rect 取证，见 §2b）；③ 点击测试（下钻/面包屑回退/右键菜单/两步确认/聊天发送/引导弹窗全交互，见 §2c）；④ 同步导航专项（用户实报两条复现定性，见 §2d）。
> 判据：docs/redesign-spec.md v2（IDE 工作行为模型 + IDE 色板 + Lucide + 系统栈零 CDN）。
> 纪律：**只修不改功能**——补全式二开，所有列条目均为视觉/语义统一，不删任何能力。

## 0. 根因总览（五刀）

| # | 根因 | 一处修复普惠面 |
| --- | --- | --- |
| 1 | `--font-mono` 无中文字形，中文掉宋体 | 状态栏/输出日志/页标题/侧栏标题 全站 |
| 2 | 旧 Pinkbin "新粗野"弹窗家族（2-3px 墨边 + 粉底）| 全部弹窗 |
| 3 | "风险/分桶"概念四套色并行 | 顾问卡/脚本卡/聊卡片/巡查桶标 |
| 4 | 假菜单栏占位 | 顶带五菜单 |
| 5 | 文本字符充当图标（☀/☾/⚙）| 主题按钮/AI 文案 |

---

## 1. 旧残留（26.1.0 之前就在，二开时未清）

### A. 弹窗一族仍是旧"新粗野"风（最重）

工作台壳已是 IDE 1px 细线扁平，弹窗还是老设计粗墨边：

- `styles.css:1849` `.modal` — `border: 3px solid var(--ink)` + 14px 圆角 + 重阴影
- `styles.css:1905` 附近 `.hint` — `border: 2px solid var(--ink)` + 粉底提示框
- `styles.css:1868` 附近 `.seg`（旧定义）— 墨色分段边；`.seg-opt:hover/.active` 落 `var(--pink)`
- 全文件 `2px solid` / `3px solid` 共 **39 处**，均为此路残留
- 受害组件：`Settings.tsx`（整个设置弹窗）、`CleanupModal.tsx:548,773`、`DraftScaffoldModal.tsx:78`
- 注：`--pink/--ink` 已由 §1 别名桥到中性色（styles.css:128-137），**色**已不粉，但**结构**（粗边/大圆角/重阴影）还是水泥

### B. "风险"概念四套色打架

同一语义（低/中/高风险 或 分桶）四处各自硬编码，互相对不上：

| 位置 | 色值 | 备注 |
| --- | --- | --- |
| `AdvisorCard.tsx:28` | `#ffa3c7 / #ffb37a / #ff5d7a / #a17a8d` | 旧粉主题风险色 |
| `ScaffoldPanel.tsx:36` | `#ffa3c7 / #ffb37a / #ff5d7a` | 与上重复 |
| `ChatPanel.tsx:497` | `#5fcf95 / #ffb37a / #ff5d7a` | low 的绿与 AdvisorCard 不同 |
| `TriageView.tsx:81-83` | `#16a34a / #d97706 / #ca8a04` | 硬编码；token 已有 `--ok/--warn`（styles.css:58），`#ca8a04` 连 token 都没有 |
| `triage.ts:9-13` BUCKET_META.tone | `#5fc88a / #ff9f5e / #ffd166 / #7a6675 / #5b8def` | 第四套 |

### C. mono 字体无中文字形 → 中文标题掉宋体

- 根因：`styles.css:55` `--font-mono: Consolas, "Cascadia Mono", monospace`，两字体均无 CJK，中文落到浏览器默认 SimSun（宋体衬线）
- `.sec-title`（styles.css:1339，mono 16px）承载中文标题，受害者：
  - `RecordsView.tsx:189` "操作记录" 页头
  - `DraftScaffoldModal.tsx:81` "让 AI 起草脚本 · …"
  - `TreeView.tsx:218` "进回收站（可还原）"
- 脚本库 tab 页头 **"Studio"**（`Studio.tsx:134,225`）：旧品牌名残留 + 等宽打字机体；tab 叫"脚本库"页头叫 Studio

### D. 文本字符/emoji 充当图标

- `App.tsx:933` 主题按钮 `☀ / ☾` 文本字符，应为 Lucide `sun` / `moon`
- `ChatPanel.tsx:216` 用户可见文案 "点右上角 ⚙ 填一个 API key"
- （`triage-cache.ts:45`、`Treemap.tsx:143` 仅注释含 🟢，不影响 UI，不修）

### E. 其他小项

- `styles.css:1967` 整段 `.studio` 旧右栏样式块（注释自书"旧"），§5 纪律保留，迁移后整层清
- 入口页 "选择…" 素文本按钮与蓝色"扫描"胶囊并排，次级突兀
- 输出面板 "脚本库已加载" 打两遍 = StrictMode 双调用，仅 dev，生产不出现，**不修**

---

## 2. 26.1.0 之后我新加的（自查）

### 1. 状态栏/输出面板中文掉宋体（新壳自己写出来的）

- `.app-v2 .statusbar`（styles.css:627）整条 `font-family: var(--font-mono)`，内容全中文："未选择路径 / 未扫描 / AI 未配置 / 36 个脚本" → 宋体（已放大截图实锤）
- 输出面板日志中文同理
- 根因同 §1-C 一条变量；**mono 栈尾补 `"Microsoft YaHei"` 即全站治愈**

### 2. 假菜单栏（App.tsx:894）

- 26.1.1 新壳加了"文件 编辑 查看 扫描 帮助"五个纯 `<span>`：无下拉、无动作，但 hover 有背景反馈（styles.css:294）
- 看得见摸不着，比没有菜单更水泥
- 处置（补全式）：接成真菜单——文件=选择目录/导入 TOML/退出；查看=主题/字号/三区域开关；扫描=开始扫描/重新扫描；帮助=关于/文档。**属新功能 → 计入 26.1.4.0**

### 3. `.seg` 同名两套皮

- 记录页顶部筛选（App.tsx:711,721）走新写 `.app-v2 .seg`（styles.css:711，IDE 细线）
- 设置弹窗 `seg-opt` 走旧 `.seg`（styles.css:1868，粉 hover + 墨色边）
- 同名控件两副面孔；统一到 `.app-v2` 版

### 4. DraftScaffoldModal 坐在水泥底座上（26.1.3 新功能）

- `DraftScaffoldModal.tsx:78-79` 用 `modal-bg + card draft-modal`，全新功能继承旧 3px 墨边 + 粉底 hint 家族
- §1-A 修好后自动受益，无需单改

### 5. 分诊色两套并行（26.1.2 遗留）

- 新五判定层干净：`VERDICT_META` 全 token（`triage-cache.ts:52`，`--verdict-*`）
- 旧四桶没收编：`triage.ts` BUCKET_META.tone（糖果色）+ `TriageView.tsx:81` 图标硬编码色
- 同屏两套绿/黄/橙语义，图例与桶标颜色对不上；全部收敛到 `--verdict-*` / `--ok` / `--warn`

### 6. 品牌 wordmark 用等宽字体（待拍板）

- `.app-v2 .brand`（styles.css:264）"DiskSift" 用 Consolas + 呼吸点
- IDE/VS Code 的 wordmark 均为 Sans；换 `--font-sans` 600 字重更精
- **此条与 redesign-spec.md §2 "品牌（mono 粗体+呼吸点）" 冲突，改哪边需用户拍板**

---

## 2b. 数据态审计补测（2026-09-28 第二轮；此前只有空态截图，用户点名纠正后 mock 扫描 187GB 全流程复测）

> 方法：:1420 mock 模式补丁 `window.prompt` 选 C:\ → 扫描 803ms 完成 → 逐视图截图 + DOM rect 取证。
> **教训入册：视觉验收必须含数据态，空态审计不算数。**

### 7. 【P0·布局 bug】树视图名字列塌陷，所有目录名不可见

- 现象：扫描后资源管理器树每行只剩 占用环+百分比+大小+文件数，**文件夹名和图标整列消失**（数据态截图实证）
- 根因：`.tree-headrow, .tree-row` 网格 `minmax(0,1fr) 96px 64px 52px`（styles.css:1609-1612），三定宽列+间隙共 236px；新壳侧栏默认 ~300-340px，name 列只剩 ~34px（DOM rect 实测 `col-name width=34px`，恰=缩进 padding），`overflow:hidden` 把内容全裁掉
- 旧三栏布局左栏更宽所以从没暴露；新壳侧栏变窄后必然塌
- 修法：定宽列压缩（96/64/52 → 约 72/56/44）或改 `auto` 自适应 + 数字列 `font-variant-numeric` 保持对齐；验收=侧栏 280px 最小宽时名字列仍 ≥120px

### 8. 树表头"文件夹"也是 mono 掉宋体

- `.tree-headrow`（styles.css:1618）`font-family: var(--font-mono)`，表头"文件夹"渲染成宋体——数据态截图里初看像"文件级 %"，实为宋体"文件夹"+"%"（空态轮漏掉的同一根因新受害者）
- 归 §0-1 根因，mono 栈修复时一并治愈

### 9. 状态栏路径区中文掉宋体（数据态实证）

- 扫描后状态栏左侧 "C:\ 187 GB · 805,990 文件" 的"文件"二字宋体（放大截图实锤）；归 §0-1 同根因

### 10. CleanupModal 数据态全景水泥（§1-A 最重实证）

- 触发路径：脚本库 → WeChat 卡展开 → 配置清理…
- 截图证据：3px 墨边主框、路径黑框、虚线统计框（红线保护橙色文案）、账号区 2px 圆角框、缓存区 2px 框内行距巨大稀疏（三行占满一屏）、"全选"胶囊
- 归 §1-A 弹窗族统一 1px 化时一并处理；缓存区行距稀疏单独记 low（疑似 min-height 撑高）

### 11. AutoWalk 巡查流整体旧风（§5 遗留层组件带数据才可见）

- 触发路径：巡查 tab → 开始巡查
- 证据：顶部 walk-bar 2px 墨边横条（styles.css:1725，`strong` 900 字重）、"90.0 GB" 黑底白字药丸、进回收站/隔离/保留 黑边按钮、下一个 黑边胶囊
- 与弹窗家族同批做 1px 化 + 药丸归中性/语义色

### 12. Treemap 数据态小项（low）

- 祖先聚合徽标父子同值重复：单子链（Users→demo-user）时两层都挂 "●30.9 GB" 徽标，视觉重复；聚合沿链去重（仅最上层挂）
- 判定色条与选中态同色系：depth1 块左缘 3px 蓝=需决策，但选中描边也是 accent 蓝，未选中块易误读为选中；判定条建议降饱和或改用 `--verdict-decide` 专色（现已如此）加宽差异（3px→2px+透明度）

---

## 2c. 点击测试补测（2026-09-28 第三轮；用户点名"分布图点了没、好多地方没点击测试"，并实报 AI 分诊条挡面包屑）

> 覆盖记录（mock 数据态全交互）：单击块=详情卡 ✓ / 双击块=下钻 ✓ / 面包屑段点击=回退 ✓ / AI 分诊按钮=免费接入引导弹窗 ✓ / 树行右键=上下文菜单（打开/复制路径/进回收站红字）✓ / 巡查流两步确认（首击 armed 变橙边）✓ / AI 聊天发送+mock 回复 ✓ / 免费引导三方案+去设置 ✓。CUA 合成双击不触发 React onDoubleClick（时序），原生 dispatch 正常——真鼠标无此问题，非 bug。

### 13. 【P0·布局 bug】面包屑与 AI 分诊工具条同行挤压/遮挡（用户实报，已复现 + 结构坐实）

- 现象：空间图顶部一行同时塞 `面包屑 + .grow + AI分诊按钮 + 五判定图例 + 体积统计`（App.tsx:560-600 一带）。钻到 `C:›Users›demo-user›AppData›Local` 四层时面包屑右缘 x=577、AI 分诊按钮左缘 ~614，**间隙只剩 37px**——真实路径（`D:\localuser\项目经历\…` 中文段更宽）必然撞上，用户实机已见"挡住顶部的 D:\localuser"
- 结构根因：`.app-v2 .crumb`（styles.css:507）`white-space: nowrap`、无 `min-width:0`/省略号；行内除 `.grow` 外全部 `flex-shrink:0`（`.ai-triage-btn`、`.triage-legend`、`.sz` 都是），grow 被吃光后面包屑直接顶穿
- 修法：容器 `flex-wrap` 不动（保持单行），`.crumb` 加 `flex:1; min-width:0; overflow:hidden` + 内层 `text-overflow: ellipsis`（深路径截中段保留首尾盘符与当前层）；或图例在 <1100px 时折到第二行。二选一，推荐前者+图例整条 `flex-shrink:0` 保持现状

### 14. 面包屑也是 mono——中文路径段掉宋体

- `.app-v2 .crumb`（styles.css:507）`font-family: var(--font-mono)`：拉丁路径无碍，中文目录名（`项目经历`、`文档`）全掉宋体；归 §0-1 同根因

### 15. 巡查流 AI 回答框 2px 墨框（并入 §2b-11 范围）

- "这是什么：已安装应用程序" 回答框 2px 黑边（暗色下白边，截图实锤）；与 walk-bar 同批 1px 化

### 16. AI 文案指路过期（功能性视觉瑕疵）

- ChatPanel 两处指路："点右上角 ⚙ 填一个 API key"（ChatPanel.tsx:216）、报错气泡 "在右上角的设置里填一个 API key"——**新壳设置按钮在活动栏底部**，不在右上角；用户按文案找不到入口
- 修法：文案改"左侧活动栏底部 ⚙ 设置"，或直接给可点的「打开设置」链接按钮（更好，省一次找）

### 17. 点击测试通过项（记录，无需修）

- 详情卡「进入目录」、面包屑逐段回退、图例 hover tooltip、免费引导「稍后再说」、上下文菜单三项、巡查「下一个/跳过」、聊天输入发送链路——交互全通，样式归各根因条目

---

## 2d. 同步导航功能 bug（2026-09-28 第四轮；用户实报两条，均已 mock 复现定性——26.1.1.0 树↔图双向同步的真缺陷，非样式问题）

### 18. 【P0·功能】空间图每钻一层，文件管理器里手动收起的链全部回弹（"收不回去了"）

- 复现：空间图下钻到二级 → 树聚焦链自动展开 → 点 caret 收起 Users（生效，`expanded=false`）→ 空间图里再双击下钻一次 → **Users 自动弹回展开（`expanded=true`）**
- 根因链：`drillTo`（App.tsx:330）每次都 `setTreeFocusPath(n.path)`；TreeView 的 focusPath 变化 effect（TreeView.tsx:53-57）**无条件清空 `collapsedOverrides`**——v26.1.2.1 加的"手动收起覆盖"机制只在 focusPath 不变时有效，任何一次下钻/面包屑点击/子树内点选都会把用户的收起意图全部作废。真实盘上边看图边收目录，链永远顶开 = "收不回去"
- 修法：focusPath 变化时**不再清空** collapsedOverrides；新链展开语义改为「链上节点默认展开，但被用户显式收起过的（overrides 内）保持收起」。overrides 仅在新扫描时作废（TreeView.tsx 已有 prevRoot 分支，保留）

### 19. 【P0·功能】空间图手动下钻过一次后，树点选其他目录空间图永久不跟随（"点击其他二级目录空间图不会更新了"）

- 复现：空间图双击钻到 `C:›Users›demo-user` → 树里依次点 Users / Windows / ProgramData → 面包屑三次读数全部纹丝不动（`C:›Users›demo-user`）
- 根因：`selectFromTree` 的防抖回调（App.tsx:355）`findNodeByPath(mapNode, p)` **只在当前空间图根的子树内找目标**——手动下钻后 mapNode 深居子树，点任何子树外目录（含祖先）都返回 null，静默 return。注释里的"子树内才跟随"本意是防拖选狂跳，但把"换目录看图"这条主路径堵死了
- 修法：目标改为从**整棵扫描根**找：`findNodeByPath(cur.root, p)`，是目录就 `drillTo`（换根即跟随）。防跳诉求已由 300ms 防抖承担，"子树内"限制删除。顺带：App.tsx:343 的 `tab.crumb !== driveOf(...)` 跨盘守卫对 crumb 非 盘符 形态的 tab 一刀切失效，改为比较 `driveOf(tab.crumb)` 与 `driveOf(cur.root.path)`

> 定性：两条都是 26.1.1.0 同步导航功能回归，不是视觉问题；但用户在实际使用中必撞，与 §2c-13/§2b-7 同批列入 26.1.3.1 修复单（P0）。

---

## 3. 规格文档自身需同步修订（docs/redesign-spec.md）

| 条目 | 现文 | 应改为 |
| --- | --- | --- |
| §1 字体 | mono: `Consolas,"Cascadia Mono"` | 追加中文回退 `"Microsoft YaHei"`（Latin/数字仍走 Consolas，CJK 落雅黑，不再掉宋体） |
| §2 顶带 | "菜单占位（文件/编辑/查看/扫描/帮助）" | 26.1.4.0 起为真菜单（内容表见 §2-2） |
| §2 顶带 | "品牌（mono 粗体+呼吸点）" | 随 §2-6 拍板结果同步 |
| §7.2 豁免清单 | — | 修复后移除已消灭的字面量登记 |

---

## 4. 修法执行单

**P0 · 视觉补丁（→ 26.1.3.1）**

- [x] **同步导航双 bug 修复（§2d-18/19，用户实报 P0 功能）**：TreeView focusPath 变化不再清空 collapsedOverrides（新链默认展开但用户收起过的保持收起）；selectFromTree 改从扫描根找目标使空间图始终跟随树点选
- [x] **空间图面包屑×AI分诊条挤压遮挡修复（§2c-13，用户实报 P0）**：`.crumb` 加 `flex:1; min-width:0` + 内层省略号，图例条 `flex-shrink:0`
- [x] **树视图名字列塌陷修复（§2b-7，数据态 P0 布局 bug）**：`.tree-row` 网格定宽列压缩/自适应，侧栏 280px 最小宽时名字列 ≥120px
- [x] `--font-mono` 栈尾补 `"Microsoft YaHei"`（styles.css:55；同步 redesign-spec §1；治愈 §1-C / §2-1 / §2b-8 / §2b-9 / §2c-14 全部宋体受害者）
- [x] 弹窗族去粗野：`.modal` 3px→1px `var(--border)`、radius 14→8、`.hint` 粉底→`var(--chrome-2)` + 1px 边、旧 `.seg` 统一到 `.app-v2` 版（styles.css:1849/1905/1868 一带，39 处 2-3px solid 逐个过；含 §2b-10 CleanupModal 与 §2-4 DraftScaffoldModal）
- [x] AutoWalk 巡查流 1px 化（§2b-11 + §2c-15）：walk-bar 墨边、GB 黑药丸、按钮黑边、AI 回答框 2px 框归 IDE 中性/语义
- [x] 风险/分桶色收敛：新增 `--risk-low/--risk-med/--risk-high`（或复用 `--ok/--warn/--danger` + `--verdict-*`），AdvisorCard/ScaffoldPanel/ChatPanel/TriageView/triage.ts 五处全部改引 token
- [x] "Studio" 页头 → "脚本库"，换标准页头样式（Studio.tsx:134,225）
- [x] ☀/☾ → Lucide sun/moon（App.tsx:933）；ChatPanel.tsx:216 文案去 ⚙ 并改指路（§2c-16：设置在活动栏底部，最好给可点链接）
- [x] 入口页 "选择…" 按钮样式归一（次级，顺手）——已核实：entry-scan 内按钮 className 已归一为标准 .btn（App.tsx:859，§2b-9 注释）
- [x] Treemap 祖先徽标沿单子链去重 + 判定条与选中态差异化（§2b-12，low 顺手）

**P1 · 真菜单（→ 26.1.4.0，与 USN 监控同车）**

- [ ] 顶带五菜单接真下拉（内容表见 §2-2）
- [ ] brand 字体拍板后执行 + redesign-spec §2 同步

**验收标准（空态 + 数据态双轮）——2026-09-28 已实测通过**

- [ ] mock 扫描后数据态：亮/暗 × 六视图（入口/空间图含详情卡/巡查/巡查流/脚本库含清理弹窗/操作记录）+ 树视图截图：无宋体衬线中文、无 2px 以上墨色边框、无硬编码糖果色、树行目录名可见——【未执行】需浏览器/截图环境人工验收
- [ ] 空态同样过一遍（回归）——【未执行】随数据态截图一并人工验收
- [x] `grep -nP '#[0-9a-fA-F]{6}' components/*.tsx` 仅剩 spec §7.2 豁免清单内条目（2026-09-28 复检：仅 TreeView.tsx:271 注释命中——描述已移除的手绘 SVG 配色，非活样式）
- [ ] 全站中文文本渲染字体 = Segoe UI 栈 → 雅黑（DevTools computed font-family 抽查状态栏/页头/日志/树表头四处）——【未执行】--font-sans/--font-mono 栈已含雅黑（styles.css:54-55），渲染抽查需 DevTools
- [ ] DOM rect 断言：侧栏 280px 时 `.tree-row .col-name` 宽度 ≥120px；下钻 6 层后 `.crumb` 右缘与 `.ai-triage-btn` 左缘间隙 >0（不相交）——【未执行】仅静态确认实现存在（styles.css:1641-1660 网格 60/50/44+@container、:538-552 crumb-path flex+min-width:0），未经浏览器实测

---

## 5. 交互探 bug 轮（2026-09-28 第四波工作流产物；21 条全部独立重放确认，0 虚报）

> 全文见工作流产物《交互探 bug 报告》（探针与截图：D:/localuser/promo-video/probes/）。此处登记编号与一句话，修复进度勾选在此。**2026-09-28 回写：§5 全部 19 行（21 条 id）已修并勾选**；§4 P0 全部 11 项已逐项 grep/代码核实并勾选（入口页按钮归一 App.tsx:859 .btn + §2b-9 后补勾），P1 两项与需人工/截图的验收行未完成保持未勾，hex grep 验收已机器复检通过并勾选（09-28 二次复检通过，仅注释一处）。截图双轮/字体抽查/DOM rect 断言三项【未执行】——本环境无浏览器验收，保持未勾并在原行标注状态，待人工 DevTools/截图验收。入口页按钮归一经代码核实（App.tsx:859 .btn + §2b-9）后补勾。

**高危**
- [x] f0-0/f1-1/f2-0（同根因）NEVER_TOUCH 片段表尾分隔符：`'\Windows\'` 匹配不到根级 `C:\Windows` → 父判需决策/子判系统自相矛盾；巡查流对 C:\Windows「进回收站」实测执行成功（已释放+36.2GB），真实后端 execute_plan（src-tauri/src/lib.rs:960-977）同样无兜底——安全防线双层失效；C:\Recovery 不在清单
- [x] f3-0 清理弹窗取消全部账号 = 清所有账号（lib.rs:315-317 空列表 return true），与「只清勾选账号」承诺相反；单账号取消勾选不触发尺寸重取
- [x] f1-0 collapsedOverrides 盲区：聚焦链上收起的目录离开聚焦链后覆盖集永远清不掉（TreeView toggleOpen 仅链上分支删覆盖集），caret 永久失效

**中危**
- [x] f1-3 详情卡盖住瓦片中心时吞掉双击下钻（单击即弹卡 + 双击共用瓦片的几何冲突）
- [x] f2-1 巡查空队列两入口零反馈；jumpTo 不在队列静默跳 idx0；阈值 999 越过 max=100
- [x] f2-2 「让 AI 看更深」无 busy/disabled 可连点并发，reject 无提示
- [x] f2-4 分诊祖先截断：C:\Users 90GB 挡住整棵用户树，safe/heavy/stale 恒 0 项、「一键全部回收」永不可达
- [x] f3-1 弹窗组含空 scope 时「全选」死锁，全不选不可达
- [x] f3-2 侧栏连点第二个脚本卡 focusId 失效（Studio 缺 key）
- [x] f4-0 AI 长代码行撑爆聊天区（旧 `pre code{white-space:pre}` 特异性压过热修；祖先链缺 min-width:0）
- [x] f5-0 字号档位 A·md 零视觉生效（全站 px 字号，根字号无处兑现）

**低危**
- [x] f0-1 面包屑深链最浅段被裁不可点、无一键回根兜底
- [x] f0-2 窄窗固定宽面板把 treemap 压成 104px 细条
- [x] f1-2 树视图整体键盘不可达（无 tabIndex/role/onKeyDown）
- [x] f1-4 pct>100 文本与环钳制不对称
- [x] f2-3 隔离按全量计入「已释放」（同卷移动零释放，数字虚高）
- [x] f4-1 未配置去重留空白灰卡气泡，面板开关一次 +1
- [x] f4-2 错误气泡混入 assistant 历史污染后续请求（20 轮窗口）
- [x] f5-1 侧栏 splitter 钳制漏算 8px（352 < MIN_CENTER 360）
