# Deploy Sentinel on Render (no coding required)

This guide walks you through putting the app online on [Render](https://render.com). After setup, you open one URL in your browser — the dashboard and backend run together.

---

## What you need before starting

1. A **GitHub** account with this project pushed to a repository.
2. A **Render** account (sign up free at [render.com](https://render.com)).
3. An **Anthropic API key** for AI bill verification ([get one here](https://console.anthropic.com/settings/keys)).

---

## Step 1 — Push code to GitHub

If the project is not on GitHub yet:

1. Create a new repository on GitHub.
2. Upload this entire folder (`my-project`) to that repository.

---

## Step 2 — Create the app on Render

1. Log in to [dashboard.render.com](https://dashboard.render.com).
2. Click **New +** → **Blueprint**.
3. Connect your GitHub account and select the repository that contains this project.
4. Render will read `render.yaml` and propose:
   - **sentinel** (web service)
   - **sentinel-db** (PostgreSQL database)
5. Click **Apply**.

---

## Step 3 — Set secret environment variables

After the blueprint is created, open the **sentinel** web service → **Environment**:

| Variable | What to put |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Your `sk-ant-...` key — **recommended** so you do not need to paste it every day |

`DATABASE_URL` and `SESSION_SECRET` are filled in automatically by the blueprint.

`APP_PASSWORD` is optional (login is disabled by default). If set, it is ignored on the current build.

Click **Save Changes**. Render will redeploy the service.

---

## Step 4 — Open your app

1. On the **sentinel** service page, copy the URL (e.g. `https://sentinel-xxxx.onrender.com`).
2. Open that URL in your browser.
3. If **AI Key** shows “Server (Render)”, your `ANTHROPIC_API_KEY` is active. Otherwise click **AI Key** once and paste your key — it is saved in the browser (`localStorage`) for future visits.
4. Upload your **Attendance** and **PJP** Excel files as before.

Data and claims are saved in the database and survive browser refresh.

---

## Free tier notes

- The app may **sleep** after ~15 minutes of no use; the first visit after sleep can take 30–60 seconds to wake up.
- PostgreSQL free databases expire after 90 days on Render’s free plan — upgrade or export data before then if you rely on it long term.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| “Login required” loop | Set `APP_PASSWORD` in Environment and redeploy |
| AI verification fails | Click **AI Key** in the header and paste a valid `sk-ant-...` key; hard-refresh (Ctrl+Shift+R) if you still see an old build |
| Deploy fails on database | Wait for **sentinel-db** to finish creating, then redeploy **sentinel** |
| Blank page | Check **Logs** tab on the web service for errors |

---

## Updating the app later

Push changes to GitHub. Render redeploys automatically if auto-deploy is on (default).
