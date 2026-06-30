# World Cup 2026 Bet Tracker

A lightweight, single-page web app for tracking **signed 1-on-1 football bets** in IDR
(Indonesian Rupiah) among a group of friends during FIFA World Cup 2026.

Each player has their own account, every bet is digitally signed by **both** parties before it
becomes binding, and a built-in treasury tracks each player's deposit and current balance —
settling automatically when matches finish. The frontend is a single static page; all data,
auth, and match syncing run on [Convex](https://convex.dev).

> **New to this clone?** Follow **[SETUP.md](SETUP.md)** to deploy it under your own GitHub,
> Convex, and football-data.org accounts. You'll be the admin/treasurer and can add players later.

---

## Features

**Guests (not logged in)**
- Browse all WC 2026 fixtures with live scores, half-time scores, and match status
- **Stage tabs** to focus the current knockout round, with an **Archive** tab for the group stage
- Filter by All · Live · Upcoming · Finished · With Bets, and search by team
- A **connected knockout bracket** (Round of 32 → 16 → Quarter-finals → Semi-finals → Final, with
  a trophy and a 3rd-place box) that fills in automatically as results sync; undecided slots show
  as empty "TBD" boxes
- See every bet on each match, including handicap (Voor), signature status, and settled outcome
- Golden Boot (top scorers) and group standings
- Auto-refresh: every 60 s when a match is live, every 5 min otherwise

**Members (any logged-in player)**
- **Propose a bet** on an upcoming match: pick your team, choose an opponent (they take the other
  side), set the stake and an optional handicap
- **Agree & sign** or **reject** bets waiting for you — they appear in an inbox at the top and on
  the match card
- View the **treasury** (everyone's deposited total and current balance), a **"who owes whom"**
  debt summary, and your own transaction **history**
- Change your password

**Treasurer (admin)**
- **Sync** fixtures, scores, scorers, and standings from football-data.org
- **Record deposits** (and corrections) per player
- **Add players** at any time
- **Set / override** a match result manually, which settles its bets — including an
  **"advanced to next round"** option for knockout games decided by extra time or penalties

---

## How a bet works (digital signatures)

1. A player **proposes** a bet naming the opponent, the stake, and an optional handicap.
   Proposing automatically signs the proposer's side.
2. The bet sits as **awaiting opponent** until the named opponent **signs**. Only then does it
   become **agreed** (binding). The opponent can **reject** instead, and the proposer can
   **cancel** until the opponent signs.
3. Each signature is stored as an **immutable, timestamped record**. A bet's terms can't be edited
   after it's proposed, so the two signatures always attest to fixed terms — this is the digital
   proof that replaces "we agreed on WhatsApp."

## How money works (treasury & settlement)

- The treasurer records each player's **deposit**; balances are derived from an append-only
  **ledger**.
- When a match finishes (via Sync or a manual result), every **agreed** bet on it settles in a
  single atomic transaction: winner's balance **+stake**, loser's **−stake**, each with its own
  ledger entry. A handicap that ends level is a **push** — no money moves.
- Proposing or signing is blocked if it would exceed a player's **available balance** (current
  balance minus the amount already tied up in open and agreed bets), so the treasury can't go
  negative.

## Betting rules

- Each bet is 1-on-1: one player picks a team, the opponent gets the other.
- Optional **handicap (Voor)**: goals added to one team before deciding the winner.
  - Example: `Brazil +1` adds one goal to Brazil before comparison.
  - A half-goal handicap (0.5, 1.5, …) removes draws; a whole-goal handicap can land on a **push**.
- **Voor vs. extra time / penalties (knockouts):**
  - **With a handicap (voor)** → the bet is settled on the **90-minute (regulation) result only**.
  - **No handicap** → the bet is settled on the **final result, including extra time and penalty
    shootouts** (i.e. whoever actually advances).
- Amounts are in IDR, minimum Rp 1,000.

---

## Architecture

```
wc2026-bet-tracker/
├── index.html              # SPA: Tailwind CSS (CDN) + vanilla JS; calls Convex HTTP Actions
│                           #   (set CONVEX_HTTP near the top to your own deployment URL)
├── convex/
│   ├── schema.js           # tables + indexes
│   ├── lib.js              # shared helpers (bet-outcome calc incl. voor rule, CORS, public shapes)
│   ├── auth.js             # claim / login / change-password / sessions (hashing)
│   ├── core.js             # players, matches, bets, signatures, ledger, settlement, state
│   ├── football.js         # football-data.org sync (rate-limit aware) + auto-settle
│   └── http.js             # the public HTTP API (CORS + bearer-token auth)
├── package.json            # one dependency: the Convex CLI/runtime
├── netlify.toml            # static hosting config (no build step)
├── .gitignore
├── README.md
└── SETUP.md                # full deploy guide for your own accounts
```

**Data model (Convex tables)**

| Table | Purpose |
|---|---|
| `players` | name, role (admin/member), claimed flag, salted password hash |
| `sessions` | bearer token → player, with expiry |
| `matches` | fixtures from football-data.org, incl. regulation score, overall winner, and how it was decided (regular / extra time / penalties) |
| `bets` | terms, status, outcome, winner |
| `signatures` | immutable, timestamped agreement records |
| `accounts` | per-player `deposited` total and current `balance` |
| `ledger` | append-only money trail (deposit / bet_win / bet_loss / adjustment) |
| `meta` | singletons: scorers, standings, sync timestamps |

**Data flow**

- The frontend is a static page; it makes plain `fetch` calls to **Convex HTTP Actions** at your
  deployment's `.convex.site` URL.
- Only the HTTP endpoints are public. They validate the caller's bearer token, then call
  **internal** Convex functions with a trusted player id — clients can't reach the data layer
  directly or spoof identity.
- Match data comes from [football-data.org](https://www.football-data.org/) (free tier:
  10 calls/min). The `sync` action paces itself (15 s cooldown, stats refreshed every ~5 min,
  back-off on rate limits) and writes fixtures, scorers, and standings into Convex.
- The knockout bracket and stage tabs are rendered entirely on the client from synced match data,
  so they update on every Sync with no extra configuration.
- Reads, writes, and settlement are transactional Convex mutations, so the ledger stays consistent
  under concurrent use.

---

## Setup & deployment

See **[SETUP.md](SETUP.md)** for the full step-by-step guide (your own GitHub + Convex +
football-data.org token). In short:

1. `npm install` then `npx convex dev` (log in, create the project)
2. Set `FOOTBALL_DATA_TOKEN` and `SETUP_SECRET` as Convex environment variables
3. `npx convex deploy`, then put the resulting `.convex.site` URL into `index.html` (`CONVEX_HTTP`)
4. Seed yourself as the admin/treasurer (empty player list is fine — add players in-app later)
5. Push to GitHub and host the static page (Netlify / Vercel / GitHub Pages)
6. Open the site → log in → claim your account → Sync → add players → record deposits

---

## HTTP API

Base: your `https://<your-deployment>.convex.site` · auth via `Authorization: Bearer <token>`

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /claim` | none | first-time: set your password |
| `POST /login` | none | log in |
| `POST /logout` | player | end session |
| `POST /change-password` | player | set a new password |
| `GET  /state` | optional | everything the UI renders (balances only when authed) |
| `POST /ledger` | player | your transaction history |
| `POST /bet/propose` | player | propose + sign a bet |
| `POST /bet/sign` | player | opponent agrees → binding |
| `POST /bet/reject` | player | opponent rejects |
| `POST /bet/cancel` | proposer | cancel before opponent signs |
| `POST /admin/sync` | treasurer | pull fixtures/scores/stats + settle |
| `POST /admin/result` | treasurer | set a final score (+ optional advancer) and settle |
| `POST /admin/deposit` | treasurer | record a deposit / correction |
| `POST /admin/create-player` | treasurer | add a player |
| `POST /admin/seed` | setup secret | one-time bootstrap (creates the admin + any members) |

---

## Security notes

- **No secrets in the browser.** The football-data token and setup secret live in Convex
  environment variables (server-side); the page source contains only your public deployment URL.
- **Per-player auth.** Passwords are hashed with SHA-256 + a per-user salt; sessions are random
  30-day bearer tokens. This is lightweight auth suited to a friends' group — enough to make a
  signature mean "this authenticated person agreed at this time," not bank-grade identity.
- **Locked-down data layer.** All query/mutation functions are `internal`; only the HTTP endpoints
  are public, and they authorize the token before passing a trusted player id inward.
- **Tamper-evident records.** Signatures are immutable and timestamped, bet terms are frozen at
  proposal, and the money ledger is append-only with transactional settlement.
- **Keep your `SETUP_SECRET` and `FOOTBALL_DATA_TOKEN` private**, and don't paste them into the
  page source or commit them to git (they belong in Convex env vars only).

---

## Credits & usage

Originally designed and built by **I Gede Suta Pinatih (Suta)** — a physics/maths teacher and
web developer in Bali, Indonesia.

This project is shared for **personal, non-commercial use** among friends. You're welcome to
deploy and adapt it for your own group, but please:

- **Keep this attribution to Suta Pinatih** in the README of any copy or derivative.
- **Do not sell it, charge for it, or use it commercially.**

If you'd like to do something beyond personal use, please ask Suta first.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | HTML · [Tailwind CSS](https://tailwindcss.com) (CDN) · Vanilla JS |
| Backend | [Convex](https://convex.dev) — reactive DB + serverless functions + HTTP Actions |
| Auth | Lightweight token sessions (SHA-256 + per-user salt) |
| Match data | [football-data.org](https://www.football-data.org/) v4 API |
| Flags | [flagcdn.com](https://flagcdn.com) |
| Hosting | Any static host (Netlify / Vercel / GitHub Pages) |
