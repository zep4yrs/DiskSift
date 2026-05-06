# 跨设备运行测试 Checklist · Diskwise (Pinkbin)

> 用途：把 A 机器 build 出的 `Diskwise_<version>_x64-setup.exe` 装到 B 机器，验证跨机运行 + scaffold 在不同机器状态下的行为。
> **核心原则**：**全程 preview / dry-run，不点任何 execute**。今晚只验运行，不验删除。

## 0 · 装包前 B 机器自检

- [ ] Windows 版本 ≥ Win10 1809（`winver` 查）
- [ ] WebView2 Runtime 已装（开始菜单搜 "WebView2"，或看 `C:\Program Files (x86)\Microsoft\EdgeWebView\Application\` 是否存在）
  - 没装也没事，NSIS 安装器会自动拉
- [ ] 磁盘剩余空间 ≥ 1 GB
- [ ] **关闭所有微信 / Cursor / 浏览器**（避免 detect 时文件被锁导致大小读不准）

## 1 · 安装

- [ ] 双击 `Diskwise_0.1.0_x64-setup.exe`
- [ ] SmartScreen 弹 "Windows 已保护你的电脑" → 「更多信息」→「仍要运行」（预期行为，未签名）
- [ ] 安装路径默认 `C:\Program Files\Diskwise\`，保持默认
- [ ] 安装完成后开始菜单出现 "Diskwise"
- [ ] 桌面快捷方式（如果勾了）能双击启动

**Fail 处理**：
- 装到一半弹 VC++ Redistributable 缺失 → 装最新版后重试
- 安装包打开就闪退 → 在 PowerShell 跑 `& "$env:USERPROFILE\Downloads\Diskwise_0.1.0_x64-setup.exe"` 看错误码

## 2 · 首次启动

- [ ] 双击启动，主窗口能开（不闪退、不空白）
- [ ] Studio 面板能渲染 scaffold 卡片列表
- [ ] **至少一张卡片显示「已检测到」**（说明 detect 逻辑在 B 机器有效，env 展开正确）
- [ ] **截图**整个 Studio 面板初始状态，回 A 对比

**Fail 处理**：
- 白屏 → WebView2 没装好，重装 WebView2 Runtime
- 卡片全是「未检测到」→ 说明 B 机器干净 / 没装对应软件，正常；但如果 B 上明明装了 WeChat 还说没检测到 → bug，截图反馈
- 闪退 → 找日志：`%LOCALAPPDATA%\dev.diskwise.app\logs\`（如果写了 log）

## 3 · Scope 命中验证（只看，不动）

挑 **1–2 个低风险 scaffold**（推荐顺序）：
1. **浏览器缓存类**（Chrome / Edge cache）—— 最不可能误伤
2. **IDE 缓存类**（Cursor / VSCode 缓存）—— 路径规整
3. **WeChat（如装了）** —— Pinkbin 重点验证项

每个 scaffold 展开做：

- [ ] 点 scope 看 detect 出的具体路径列表
- [ ] **红线肉眼扫描**：路径里有以下字样的**立即截图反馈**（这就是 P0 bug）：
  - `*.db` / `*.db-wal` / `*.db-shm`
  - `db_storage`
  - `Msg/` / `MultiMsg/`
  - `Accounts/` / `All Users/` / `login/` / `config/`
  - `Favorite` / `Fav/`
  - `key/` / `crypto/`
- [ ] scope 显示的「预计可释放空间」是否合理（不能是 0 也不能离谱大）
- [ ] **不要点 execute / 清理按钮**

## 4 · 防御性 UI 抽查

- [ ] ErrorBoundary：随便点几下，没有任何卡片把整个 app 搞崩白屏
- [ ] 默认 mode：所有 scope 默认应该是 `recycle`（回收站），不应是 `delete`
- [ ] 两步确认：如果手贱点了 execute 按钮，必须有二次确认弹窗（不是 `window.confirm`）

## 5 · 关闭 + 重启

- [ ] 关闭主窗口 → 进程退出干净（任务管理器看 Diskwise 没了）
- [ ] 再次启动 → 状态保持（如果有持久化的话）

## 6 · 卸载验证（测试结束做）

- [ ] 「设置 → 应用 → 已安装的应用」找 Diskwise → 卸载
- [ ] 卸载后 `C:\Program Files\Diskwise\` 应该清掉
- [ ] **检查残留**：`%APPDATA%\dev.diskwise.app\` 和 `%LOCALAPPDATA%\dev.diskwise.app\` 是否还在（NSIS 默认不删 user data，正常）

## 7 · 回 A 机器需要带回的东西

- [ ] Studio 面板初始截图
- [ ] 任何 scope 命中异常 / 红线疑似命中的截图
- [ ] B 机器实际安装了哪些目标软件 + 各自版本号（特别是 WeChat 是 3.x 还是 4.x）
- [ ] B 上的 detect 失败列表（哪些卡片说"未检测到"但其实装了）
- [ ] log 文件（如果有）

---

**紧急止损**：万一不小心点了 execute_scope —— 立刻去**回收站**找文件（因为默认 `mode = recycle`）。如果回收站也没有，说明 scope 配了 `mode = delete` ← 这是另一个 bug。
