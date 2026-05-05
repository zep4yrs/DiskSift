# Authoring a scaffold

A scaffold is a TOML manifest that tells Pinkbin:

1. How to **detect** a known app on disk.
2. Which **scopes** (subsets of files) are safe to clean.
3. What to **prompt** the user (e.g. retention days).
4. The **risk** and a human-readable **disclaimer**.

## Schema

```toml
id          = "string, kebab-case, globally unique"
name        = "Human label shown in UI"
homepage    = "optional URL"
risk        = "low | medium | high"
disclaimer  = "Free-form text shown in the card"

# One or more paths. Env vars in %FOO% (Win) or $FOO/${FOO} (Unix) are expanded.
# Globs are evaluated relative to the user's home if not absolute.
detect = [
  "%APPDATA%/Tencent/WeChat",
  "**/WeChat Files/*/FileStorage",
]

# Optional: extra hints used when matching against a scanned folder.
[match]
name_contains = ["WeChat", "微信"]
must_have_child = ["FileStorage"]

[[scope]]
id     = "image-cache"
label  = "Image cache"
glob   = "FileStorage/Image/**"
mode   = "recycle"            # recycle | quarantine | delete
prompt = { kind = "days", default = 30, label = "Delete files older than (days)" }

[[scope]]
id     = "video-cache"
label  = "Video cache"
glob   = "FileStorage/Video/**"
mode   = "recycle"
prompt = { kind = "days", default = 7 }

[[scope]]
id     = "file-cache"
label  = "Received files"
glob   = "FileStorage/File/**"
mode   = "recycle"
prompt = { kind = "days", default = 30 }
```

### `prompt.kind`

| kind     | UI               | passed to executor |
|----------|------------------|--------------------|
| `none`   | (none)           | –                  |
| `days`   | number input     | `older_than_days`  |
| `bytes`  | size input       | `larger_than`      |
| `choice` | dropdown         | selected key       |
| `confirm`| checkbox         | `true`             |

## Detection rules

A scaffold matches a folder `F` iff:

- any `detect` glob matches `F` or one of its ancestors, **or**
- `match.name_contains` matches `F.basename` **and** every `match.must_have_child` exists under `F`.

The scanner runs detection on every directory it visits, so deeply-nested matches (e.g. `**/WeChat Files/*/FileStorage`) are fine.

## Risk levels

| level    | meaning |
|----------|---------|
| `low`    | Cache only. Re-creates on next use. |
| `medium` | May lose convenience state (logged-out tabs, unsaved drafts). |
| `high`   | Can break the app or cost rebuild time (Docker images, model downloads). |

`high` scaffolds always require explicit confirmation per scope.

## Forbidden targets

- App message databases, encrypted stores, key files.
- User-authored content (Documents, Pictures, Music).
- Anything outside the detected app's directory.

A PR that violates these rules will be rejected.

## Submitting

1. Drop your file in `scaffolds/<id>.toml`.
2. Run `cargo run -p pinkbin-scaffold-lint -- scaffolds/<id>.toml`.
3. Add a screenshot of the card matching on your machine to the PR description.
4. Tick the risk acknowledgement in the PR template.
