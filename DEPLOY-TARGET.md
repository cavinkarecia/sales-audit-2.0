# Production deploy target (Sentinel)

Use **only** this pairing so your work does not mix with the legacy React app on `sales-audit-2-0`:

| | Value |
|--|--------|
| **GitHub** | https://github.com/cavinkarecia/sales-audit-2.0 |
| **Branch** | `main` |
| **Render service** | `sales-audit-2.0-2` |
| **Live URL** | https://sales-audit-2-0-2.onrender.com |

## Render settings (critical)

- **Repository:** `cavinkarecia/sales-audit-2.0`
- **Branch:** `main` (not `main2`, not `master`)

After deploy, open `/health` — you must see:

```json
"build": "2026.06.13-main",
"renderBranch": "main"
```

If you see `main2` or an older build, the dashboard is still on the wrong branch → **Settings → Branch → `main` → Save → Manual Deploy**.
- **Root directory:** `backend`
- **Build command:** `npm install`
- **Start command:** `npm start`
- **Health check:** `/health`

## Push workflow

```powershell
cd C:\Users\1015803\sales-audit-2.0
git checkout main
git add -A
git commit -m "Your message"
git push origin main
```

Render auto-deploys `sales-audit-2.0-2` from `main`.

## Do not use for Sentinel

| Avoid | Reason |
|-------|--------|
| `Sales-Audit` / `master` | Friend’s React app + `/expense-check-2` → Render `sales-audit-2-0` |
| `sales-audit-2.0` / `main2` | Old branch name; merged into `main` |
| Render `sales-audit-2-0` | Different service and codebase |
