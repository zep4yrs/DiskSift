# Security Policy

## Reporting a vulnerability

Please email **security@diskwise.dev** (or open a private security advisory on GitHub). Do not open a public issue. We aim to triage within 72 hours.

## Threat model

Diskwise runs as the local user. It can read, move-to-recycle-bin, and (with explicit opt-in) permanently delete files inside paths you grant it. It does not require admin/root and we recommend against running it elevated.

## Network egress

Diskwise only makes outbound requests when:

1. The AI advisor is enabled and configured with a cloud provider. Payload is `{path, size, file_count, top_extensions, sample_paths}`. File contents are never sent.
2. You opt in to update checks.

Choose `Ollama` (local) in settings to keep all inference on-device.

## Safe-delete invariants

- All deletions default to the OS recycle bin (`trash` crate) – recoverable.
- A configurable `quarantine` mode moves files to `%LOCALAPPDATA%/Diskwise/quarantine/` for N days before final deletion.
- Every action is appended to `~/.diskwise/undo.jsonl`.
- Permanent delete requires an explicit confirmation per session.

## Out of scope

- Diskwise will not bypass app DRM, decrypt application databases, or extract user data from third-party apps. Scaffolds that target media caches do not touch message databases.
