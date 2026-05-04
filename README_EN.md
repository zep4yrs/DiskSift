<sub>🌐 <a href="README.md">中文</a> · <b>English</b></sub>

<div align="center">

# Pinkbin · Diskwise

> *Scan a disk. See an 80GB unknown folder. Stop screenshotting it to ChatGPT.*

[![License](https://img.shields.io/badge/License-MIT-ff69b4.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB.svg)](https://tauri.app)
[![Platform](https://img.shields.io/badge/Win%20%C2%B7%20macOS%20%C2%B7%20Linux-lightgrey.svg)](#install)

A WizTree-class scanner + 38 built-in cleanup scaffolds (WeChat 3.x/4.x · Steam · Chrome · Docker · conda · …) + AI fallback to explain unfamiliar folders. Deletes go to the system Recycle Bin. File contents are never read.

</div>

---

## Demo

<p align="center">
  <img src="docs/screenshots/hero.png" alt="Pinkbin main UI" width="100%">
</p>

## Install

Grab a binary from [**Releases**](https://github.com/cccyd2003-qwq/pinkbin/releases/latest). On Windows, SmartScreen blocks the first launch — click "More info" → "Run anyway".

Open → top-right ⚙ to configure AI (recommended: local [Ollama](https://ollama.com/download), no key) → pick a disk → scan → click a Studio card to review.

## What it does

- **Sub-second disk scan** — direct NTFS MFT read on Windows; full C: drive in 2–5 seconds.
- **38 cleanup scaffolds** — known apps (WeChat / Steam / Docker / conda / …) get a dedicated panel; clean each scope individually; defaults to Recycle Bin.
- **AI explains unfamiliar folders** — BYOK (Anthropic / OpenAI / Gemini / local Ollama), sends only directory metadata.
- **WeChat 3.x + 4.x dual support** — version auto-detected; 4.x = 13 buckets, 3.x = 9 buckets.
- **Undo log + 7-day quarantine** — `~/.diskwise/undo.jsonl`, recoverable.
- **Red lines guarded by integration tests** — accidentally touch a chat DB or favorites glob, CI rejects the PR.

## Add a new app

Write `scaffolds/<id>.toml` + `crates/scaffold/tests/<id>_safety.rs`, open a PR. See [`.claude/commands/add-scaffold.md`](.claude/commands/add-scaffold.md). Claude Code users: just `/add-scaffold <id>`.

## Development

```bash
git clone https://github.com/cccyd2003-qwq/pinkbin.git && cd pinkbin
pnpm install
pnpm tauri dev            # desktop app
pnpm -C apps/desktop dev  # frontend only, mock backend
cargo test --workspace    # workspace tests
```

## FAQ

**Does it work with WeChat 3.x?** Yes. Version auto-detected; 9 3.x scopes (FileStorage's Image/Video/File/Voice2/MsgAttach/Stickers/Temp/Cache + roaming Log/Update). Chat history, favorites, and `CustomEmotion` ("My Stickers") are guarded by integration tests — never matched.

**Will my AI key be uploaded?** No. Pinkbin has no servers. Keys live only on your machine; requests go directly from your computer to the AI provider you configured. File contents are **never** uploaded.

**Can I recover something I deleted?** Defaults to the system Recycle Bin — restore from there. Quarantine mode keeps files in `~/.diskwise/quarantine/` for 7 days.

**Windows SmartScreen blocks the installer?** No EV cert yet (~$300/year, the author hasn't bled for it). Click "More info" → "Run anyway", or build it yourself with `cargo tauri build`.

## Acknowledgments

[WizTree](https://diskanalyzer.com) (the speed bar) · [Tauri](https://tauri.app) · [CleanMyWechat](https://github.com/blackboxo/CleanMyWechat) (the WeChat 3.x scaffold lineage) · README style adapted from [alchaincyf/huashu-design](https://github.com/alchaincyf/huashu-design) · [@jtlyu](https://github.com/jtlyu) (perf optimization + WeChat 4.x rewrite)

## License

[MIT](LICENSE)
