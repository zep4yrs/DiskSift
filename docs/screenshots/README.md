# Screenshots

Place release-quality PNGs here:

| File | What it shows |
|---|---|
| `01-scan.png` | Main window after a scan — TreeView + Treemap + Auto-Walk idle. Aim for ~1280×720, light pink theme. |
| `02-scaffold.png` | An Auto-Walk scaffold panel (e.g. WeChat or Edge) with the scope checkboxes. |
| `03-advisor.png` | An AI advisor card on an unknown folder, after the model has answered. |

Quick way to capture them locally:

```bash
pnpm -C apps/desktop dev
# open http://127.0.0.1:1420 in Chrome
# DevTools → Device toolbar → Responsive 1280×720
# Click Scan → Start Auto-Walk → screenshot at each stage
# Save to docs/screenshots/01..03-...png
```

Replace this README with the actual `.png` files before tagging the first release.
