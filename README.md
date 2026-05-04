<sub>🌐 <b>中文</b> · <a href="README_EN.md">English</a></sub>

<div align="center">

# Pinkbin · Diskwise

> *扫盘 → 看到陌生大文件夹 → 不用再截图问 ChatGPT*

[![License](https://img.shields.io/badge/License-MIT-ff69b4.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB.svg)](https://tauri.app)
[![Platform](https://img.shields.io/badge/Win%20%C2%B7%20macOS%20%C2%B7%20Linux-lightgrey.svg)](#安装)

WizTree 速度的扫描器 + 38 份内置清理脚本（微信 3.x/4.x · Steam · Chrome · Docker · conda · …）+ 不认识的文件夹甩给 AI 解释。删除走系统回收站，不读文件内容。

</div>

---

## Demo

<p align="center">
  <img src="docs/screenshots/hero.png" alt="Pinkbin 主界面" width="100%">
</p>

## 安装

去 [**Releases**](https://github.com/cccyd2003-qwq/pinkbin/releases/latest) 下对应平台的安装包。Windows 首次启动 SmartScreen 拦截：点"更多信息"→"仍要运行"。

打开 → 右上角 ⚙ 配 AI（推荐本地 [Ollama](https://ollama.com/download)，免 key）→ 选磁盘 → 扫描 → 点 Studio 卡片审阅。

## 它能做什么

- **秒扫磁盘** —— Windows 直读 NTFS MFT，整盘 C: 2–5 秒
- **38 份清理脚本** —— 已知 App（微信 / Steam / Docker / conda / …）显示专属面板，每个 scope 单独清，默认进回收站
- **AI 解释陌生文件夹** —— BYOK（Anthropic / OpenAI / Gemini / 本地 Ollama），只发目录元数据
- **微信 3.x + 4.x 双兼容** —— 自动检测版本，4.x 13 桶 / 3.x 9 桶
- **撤销日志 + 7 天隔离** —— `~/.diskwise/undo.jsonl`，可恢复
- **红线由集成测试守护** —— 改 glob 不小心碰到聊天 DB / 收藏，CI 红，PR 进不去

## 想加新 App 支持

写一份 `scaffolds/<id>.toml` + 一份 `crates/scaffold/tests/<id>_safety.rs`，提 PR。详见 [`.claude/commands/add-scaffold.md`](.claude/commands/add-scaffold.md)。Claude Code 用户可直接 `/add-scaffold <id>`。

## 开发

```bash
git clone https://github.com/cccyd2003-qwq/pinkbin.git && cd pinkbin
pnpm install
pnpm tauri dev          # 桌面 app
pnpm -C apps/desktop dev  # 仅前端，浏览器调试
cargo test --workspace  # 全工作空间测试
```

## FAQ

**微信 3.x 能用吗？** 能。自动检测版本，3.x 9 个 scope（FileStorage 下 Image/Video/File/Voice2/MsgAttach/Stickers/Temp/Cache + 漫游 Log/Update）。聊天记录、收藏、`CustomEmotion`（"我的表情"）由集成测试守护，永不命中。

**AI Key 会被上传吗？** 不会。Pinkbin 没有服务器。Key 仅存本机，请求直接从你电脑发到你配的 AI 服务商。文件内容**永不**上传。

**删错了能恢复吗？** 默认进系统回收站，从回收站恢复。隔离模式放 `~/.diskwise/quarantine/` 7 天。

**Windows SmartScreen 拦截？** 没买 EV 签名（¥2000+/年）。点"更多信息"→"仍要运行"，或自己 `cargo tauri build`。

## 致谢

[WizTree](https://diskanalyzer.com)（速度标杆）· [Tauri](https://tauri.app) · [CleanMyWechat](https://github.com/blackboxo/CleanMyWechat)（微信 3.x 范本）· README 风格参考 [alchaincyf/huashu-design](https://github.com/alchaincyf/huashu-design) · [@jtlyu](https://github.com/jtlyu)（性能优化 + WeChat 4.x 重写）

## License

[MIT](LICENSE)
