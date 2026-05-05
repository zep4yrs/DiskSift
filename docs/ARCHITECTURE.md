# Pinkbin 是怎么工作的（讲人话版）

> 这篇文档不堆术语，普通用户也能看懂。看完你会知道：你点"扫描"以后程序在干什么、AI 看到了什么、删除前后数据去哪了，以及为什么能放心用。

---

## 一句话概括

Pinkbin 干三件事：**画一张磁盘地图 → 让你拖文件夹问 AI → 给少数几个常见软件配齐安全清理脚本**。三件事都跑在你本机，文件内容**绝不**离开你的电脑。

---

## 1. 它是怎么"几秒扫完一整块硬盘"的

把硬盘想象成一栋很大的图书馆，里面几百万本书。一般的工具是**一架架翻**——挨个文件夹打开、计算大小、统计文件数，慢的能花几十分钟。

Pinkbin 在 Windows 上换了个法子：**直接读图书馆的"目录卡片柜"**——这柜子叫 **NTFS Master File Table（主文件表，简称 MFT）**，里面早就记好了"哪本书放哪、多大、谁的"。一次性把整个柜子扫完就够了，不用一架架翻。整盘 C: 通常 **2–5 秒**。

> 没有 MFT 的系统（macOS / Linux / 移动盘 / 网盘）会自动 fallback 到"一架架翻"模式（基于一个叫 `jwalk` 的高性能并行库），比 MFT 慢但仍然比传统工具快。

扫完之后，Pinkbin 把每个文件夹的大小算出来，画成两张图：

- **左侧树状视图**：像 Windows 资源管理器一样可以展开。每行带一条占用百分比的小条
- **中间彩色矩形拼图**（叫 treemap）：占空间大的文件夹画得大块，一眼能看出 80GB 的微信文件占在哪儿

---

## 2. 拖文件夹给 AI 问"这是什么"

电脑里很多文件夹的名字跟天书一样——`xwechat_files`、`%LocalAppData%\Microsoft\Edge\User Data\Default\Cache_Data`、`HuggingFace\hub\models--meta-llama--Llama-3.1-8B`。你不知道是什么、不敢删，就只能堆着占空间。

Pinkbin 的中间是一个聊天框。**把不认识的文件夹拖进去**，AI 用人话告诉你：

- 这是哪个软件的数据
- 删了你会丢什么
- 能不能删 / 用什么方式删（系统回收站？卸载软件？跑个清理脚本？）

### AI 看到的不是你的文件，只是"目录信息"

打个比方：你想问朋友"我衣柜该不该清理"，你不会让他直接翻你内衣抽屉，对吧？你会告诉他"我有 30 件红衣服、占 1 米长杆，最旧的 5 年没穿了"——这是**元数据**。

Pinkbin 发给 AI 的就是这种东西：

| 发的 | 不发的 |
|---|---|
| 文件夹路径名（`D:\steam\steamapps`） | 文件内容 |
| 总大小、文件数 | 文件名（除非是抽样里的几条目录名） |
| 文件后缀分布（"60% 是 .png"） | 任何 .db / .sqlite / 聊天记录 |
| ≤20 条**抽样路径**让 AI 判断目录长什么样 | 图片、视频、文档 |

**AI 接的是你自己的账号** —— 你点设置填上自己的 OpenAI / Claude / Gemini Key，或在本机跑 Ollama 完全免费 + 不上网。**消息不经我们的服务器，直接到你选的 AI 服务商**。

---

## 3. 常见软件配套清理脚本

某些软件大众化、占空间大、清理边界清楚——比如**微信的接收媒体**和 **Conda 的旧环境**——这种值得一份"清理脚本"，让用户一键清完不用提心吊胆。

### 一份脚本由两个文件组成

- **`scaffolds/<id>.toml`**：声明清理目标。"哪些路径下的文件可以清，分什么类，能不能保留最近 N 天，回收站还是直删"
- **`crates/scaffold/tests/<id>_safety.rs`**：**安全测试**。先列出一堆典型路径，然后写两类断言：
  - **正向断言**：每个清理目标至少匹配到一条路径（证明能用）
  - **红线断言**：聊天数据库、账号密钥、用户收藏这些路径**必须 zero-match**（证明不会误伤）

每次有人提交新脚本，CI 强制跑安全测试。**没过的合不进来**。

> 这就是为什么我们目前只有 2 份脚本（微信 + Conda）—— 老仓库里曾经有 36 份未经验证的脚本，其中 `node-modules` 那份会误删 Cursor / VSCode / 游戏内嵌的 `node_modules`。我们直接砍掉，等每份都有人写过测试再加回来。**宁少勿错**。

---

## 4. 删除时的三层保险

你点了"执行清理"以后：

1. **默认进系统回收站**——不是直接删，可以右键还原
2. **每次操作记到 `~/.pinkbin/undo.jsonl`**——一个文本日志（路径在你电脑用户目录下），能查到"我啥时候删了什么"
3. **可选 7 天隔离区**：把删的东西放到 `~/.pinkbin/quarantine/` 暂存 7 天再清。给特别敏感的删除一道额外保险

任何带删除的按钮都是**两步确认**——第一次点会变红、5 秒内再点一次才真执行。手抖点错没事。

---

## 5. 内部分了五个独立模块

```
       你
        ↓ 看到的窗口
┌────────────────────────────┐
│  React + TypeScript 前端    │   树视图 / treemap / 聊天框 / Studio 卡片
└────────────┬───────────────┘
             │ 通过 Tauri IPC（一种类似"打电话"的机制）
             ↓
┌────────────────────────────┐
│   Rust 后端 · 5 个模块      │
├────────────────────────────┤
│  scanner       扫硬盘画地图   │
│  scaffold      加载清理脚本   │
│  executor      执行删除      │
│  advisor       AI 顾问通信   │
│  scaffold-lint CI 校验工具   │
└────────────────────────────┘
```

每个模块只做一件事：

- **scanner** 只管扫盘出数据，不知道也不关心什么是"清理脚本"
- **scaffold** 只管解析 TOML 和匹配文件夹，不知道怎么删
- **executor** 只管执行删除（回收站 / 隔离 / 直删），不知道哪些可以删
- **advisor** 只管跟 AI 服务商对话，不知道什么是"扫描"
- **scaffold-lint** 在 CI 里跑，强制所有 `scaffolds/*.toml` 格式合法

这种分工的好处：**出 bug 时能精确定位、加新功能时不用动到其它模块**。

---

## 6. 隐私不变量（写死的红线）

这些是 Pinkbin **架构上保证的**，不是写在隐私政策里的"我们尽力"：

- ✅ 文件内容**永远不上传**给任何服务（包括 AI）
- ✅ AI 只收元数据：路径名、大小、文件数、后缀分布、≤20 条样本路径
- ✅ 删除产生的 undo 日志只存你本机
- ✅ **没有遥测、没有错误上报、没有"匿名使用统计"**——程序根本不主动连任何我们控制的服务器
- ✅ 唯一对外的网络请求：你点击"问 AI"时，向你**自己配置的** AI 服务商发一次 HTTP 请求

---

## 7. 用了哪些开源项目

巨人的肩膀：

| 用来做什么 | 项目 |
|---|---|
| 桌面 app 框架 | [Tauri 2](https://tauri.app)（Rust 后端 + WebView 前端，比 Electron 小 10×） |
| NTFS MFT 解析 | [`ntfs`](https://github.com/ColinFinck/ntfs) crate |
| 跨平台目录遍历 | [`jwalk`](https://github.com/jessegrosjean/jwalk) |
| 路径模式匹配 | [`globset`](https://github.com/BurntSushi/ripgrep/tree/master/crates/globset)（来自 ripgrep） |
| 走系统回收站 | [`trash-rs`](https://github.com/Byron/trash-rs) |
| Treemap 布局 | [`d3-hierarchy`](https://github.com/d3/d3-hierarchy) |
| Markdown 渲染 | [`react-markdown`](https://github.com/remarkjs/react-markdown) |

灵感来源：

- [WizTree](https://diskanalyzer.com) —— 第一次让我相信"整盘秒扫"是可能的
- [SpaceSniffer](http://www.uderzo.it/main_products/space_sniffer/) —— treemap 鼻祖
- [CleanMyWechat](https://github.com/blackboxo/CleanMyWechat) —— 微信清理脚本范本
- [SquirrelDisk](https://github.com/adileo/squirreldisk) —— Tauri 实现参考

---

## 给开发者的扩展阅读

- [README.md](../README.md) —— 项目入口、下载、功能介绍
- [CLAUDE.md](../CLAUDE.md) —— 给 Claude Code 用户的工作约定
- [.github/CONTRIBUTING.md](../.github/CONTRIBUTING.md) —— 怎么贡献新清理脚本
- [docs/PRIOR-ART.md](PRIOR-ART.md) —— 我们调研过的同类产品
- [docs/REQUIREMENTS.md](REQUIREMENTS.md) —— 立项时的需求文档
