# SETUP — deploy your own copy

This guide gets the **World Cup 2026 Bet Tracker** running under **your own** GitHub, Convex, and
football-data.org accounts. You'll be the **admin/treasurer**; you can start with an empty player
list and add people in the app later.

There are two halves:
- **Backend** → Convex (database + the HTTP API).
- **Frontend** → the single `index.html`, hosted as a static page (Netlify / Vercel / GitHub Pages).

Allow ~20–30 minutes the first time.

---

## 0. What you need

- **Node.js** 18+ installed — check with `node -v`. (Get it from <https://nodejs.org>.)
- A **GitHub** account (to store the code and connect a host).
- A **Convex** account — free: <https://convex.dev> (you can sign up with GitHub).
- A **football-data.org** API token — free: register at
  <https://www.football-data.org/client/register>, then copy the token from your account page.

> Commands below show macOS/Linux first; **Windows (PowerShell)** equivalents are given where they
> differ. On Windows use `curl.exe` (not the `curl` alias) or the `Invoke-RestMethod` version shown.

---

## 1. Get the code into your own repo

Put these files in a new folder (e.g. `wc2026-bet-tracker`):

```
index.html
package.json
netlify.toml
.gitignore
README.md
SETUP.md
convex/
  schema.js  lib.js  auth.js  core.js  football.js  http.js
```

Then create a fresh GitHub repository and push:

```bash
cd wc2026-bet-tracker
git init
git add .
git commit -m "Initial commit: WC2026 bet tracker"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

---

## 2. Install dependencies

```bash
npm install
```

This installs the Convex CLI used in the next steps. (`node_modules/` is git-ignored — don't commit it.)

---

## 3. Link the project to your Convex account

```bash
npx convex dev
```

- It opens a browser to **log in to Convex** (use your account).
- It asks to **create a new project** — accept; give it a name like `wc2026-bet-tracker`.
- It generates `convex/_generated/` and pushes your functions to a **development** deployment.

Leave it running for now, or press `Ctrl+C` once it says it's connected — either is fine. This
created your **dev** deployment. We'll create the **production** one in step 5.

> Convex has two deployments per project: **dev** (used by `npx convex dev`) and **prod** (used by
> `npx convex deploy`). Environment variables and data are **separate** for each. We'll do everything
> on **prod** so your friends use a stable URL.

---

## 4. Set your backend secrets (on production)

Pick a long random **setup secret** (used once, to seed your admin account):

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Copy the output, then set both environment variables on the **production** deployment:

```bash
npx convex env set --prod FOOTBALL_DATA_TOKEN  <your-football-data-token>
npx convex env set --prod SETUP_SECRET         <the-random-string-from-above>
```

(You can also set these in the Convex dashboard → your project → **Settings → Environment
Variables**, with the deployment switched to **Production**.)

---

## 5. Deploy the backend to production

```bash
npx convex deploy
```

When it finishes, note your **production deployment URL**. The HTTP API lives at the
`.convex.site` version of it, e.g. `https://your-deployment-123.convex.site`. You can also find it
in the Convex dashboard → **Settings → URL & Deploy Key** (look for the **HTTP Actions URL**).

Keep this URL — you need it in the next two steps.

---

## 6. Point the frontend at your backend

Open `index.html`, find this near the top of the `<script>` (around line ~290):

```js
const CONVEX_HTTP = "https://YOUR-DEPLOYMENT.convex.site";
```

Replace it with **your** `.convex.site` URL from step 5, then commit:

```bash
git add index.html
git commit -m "Point frontend at my Convex deployment"
git push
```

---

## 7. Seed yourself as the admin/treasurer

This one-time call creates **you** as the admin. The members list can be **empty** — you'll add
players in the app later. Replace the URL and secret, and put **your name** in `adminName`:

**macOS/Linux:**
```bash
curl -X POST https://YOUR-DEPLOYMENT.convex.site/admin/seed \
  -H "Content-Type: application/json" \
  -d '{"secret":"<SETUP_SECRET>","adminName":"Sidi","names":[]}'
```

**Windows (PowerShell):**
```powershell
Invoke-RestMethod -Method Post -Uri "https://YOUR-DEPLOYMENT.convex.site/admin/seed" `
  -ContentType "application/json" `
  -Body '{"secret":"<SETUP_SECRET>","adminName":"Sidi","names":[]}'
```

A successful response looks like `{"created":1}` (just you).

> Want to pre-load some friends now instead of adding them in-app? Put them in `names`, e.g.
> `"names":["Made","Kadek","Wayan"]`. They'll be created as regular members. You can always add
> more later with the in-app **Add Player** button.

---

## 8. Host the frontend (static page)

Pick any static host. Easiest is **Netlify**:

1. Go to <https://app.netlify.com> → **Add new site → Import an existing project**.
2. Connect GitHub and choose your repo.
3. Build command: **leave empty**. Publish directory: **`.`** (root). Deploy.
4. Netlify gives you a URL like `https://your-site.netlify.app`.

> **Vercel** works too: import the repo, framework preset **Other**, output directory **`.`**.
> **GitHub Pages** also works: repo **Settings → Pages → Deploy from branch → `main` / root**.

CORS is already open on the backend, so any of these domains will work without extra config.

---

## 9. First run

1. Open your hosted site.
2. **Log in** → enter your admin name (e.g. `Sidi`) → **Claim account** → set your password.
3. Tap **Sync** to load the WC 2026 fixtures, scores, scorers, and standings. The knockout bracket
   fills in from this data.
4. **Add players** with the Add Player button (each new player is unclaimed until they log in and
   set their own password).
5. **Record deposits** for each player so balances exist before bets settle.

Everyone else then opens the site, logs in with their name, claims their account, and can start
proposing and signing bets.

---

## Day-to-day

- **Updating scores:** log in as treasurer and tap **Sync**. Do it around kickoffs and full-time.
  The free football-data tier allows ~10 calls/min; the app paces itself, so just don't spam it.
- **Fixing a result:** use **Set result** on a match card. For a knockout decided by extra time or
  penalties, also pick **"advanced to next round"** so no-voor bets settle on the real winner.
- **Changing code later:** edit files, then for backend changes run `npx convex deploy`, and for
  frontend changes just `git push` (your host redeploys the static page).

---

## Troubleshooting

- **Page loads but shows no data / "failed to load":** `CONVEX_HTTP` in `index.html` doesn't match
  your `.convex.site` URL, or you didn't `npx convex deploy`. Re-check steps 5–6.
- **Bracket looks empty after Sync:** there are simply no knockout fixtures published yet, or
  football-data is labelling the knockout rounds with different stage codes. Tell whoever set this
  up — it's a one-line mapping fix.
- **`/admin/seed` returns an error:** the `secret` must exactly match the `SETUP_SECRET` you set in
  step 4 (on **prod**). If you change the secret, re-run step 4 then step 7.
- **Sync says rate-limited:** wait a minute and try again; the free tier is limited.
- **`npx convex deploy` can't find the project:** run `npx convex dev` once first (step 3) to link
  the folder to your Convex project.

---

## Security reminders

- Keep `FOOTBALL_DATA_TOKEN` and `SETUP_SECRET` **only** in Convex env vars — never in `index.html`
  or committed to git.
- `node_modules/`, `.env`, `.env.local`, and `convex/_generated/` are git-ignored on purpose.
- If you ever expose your football-data token, regenerate it on football-data.org and re-run
  `npx convex env set --prod FOOTBALL_DATA_TOKEN <new-token>`.

---

Built by **I Gede Suta Pinatih (Suta)**. Personal, non-commercial use — please keep the credit in
the README and don't commercialize it. Enjoy the tournament! ⚽
