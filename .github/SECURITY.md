# Security Policy

## Reporting a vulnerability

Please open a [private security advisory on GitHub](https://github.com/cccyd2003-qwq/pinkbin/security/advisories/new). Do not open a public issue. We aim to triage within 72 hours.

## Threat model

Pinkbin runs as the local user. It can read, move-to-recycle-bin, and (with explicit opt-in) permanently delete files inside paths you grant it. It does not require admin/root and we recommend against running it elevated.

## Network egress

Pinkbin only makes outbound requests when:

1. The AI advisor is enabled and configured with a cloud provider. Payload is `{path, size, file_count, top_extensions, sample_paths}`. File contents are never sent.
2. You opt in to update checks.

Choose `Ollama` (local) in settings to keep all inference on-device.

## Safe-delete invariants

- All deletions default to the OS recycle bin (`trash` crate) – recoverable.
- A configurable `quarantine` mode moves files to `%LOCALAPPDATA%/Pinkbin/quarantine/` for N days before final deletion.
- Every action is appended to `~/.pinkbin/undo.jsonl`.
- Permanent delete requires an explicit confirmation per session.

## Out of scope

- Pinkbin will not bypass app DRM, decrypt application databases, or extract user data from third-party apps. Scaffolds that target media caches do not touch message databases.
