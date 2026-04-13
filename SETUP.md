# TC CultivAIte Bot — Setup Guide

Complete these steps in order. Takes about 20–30 minutes total.

---

## Step 1 — Create the Telegram Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Follow the prompts — give it a name (e.g. `TC CultivAIte`) and a username (e.g. `tc_cultivaite_bot`)
4. BotFather will send you a **bot token** — copy it (looks like `7123456789:AAHx...`)
5. Keep this token safe — you'll add it to `.env` in Step 5

---

## Step 2 — Create the Google Sheet

1. Go to [Google Sheets](https://sheets.google.com) and create a new spreadsheet
2. Name it: `TC CultivAIte Submissions`
3. Create **four tabs** (click the `+` at the bottom) and name them exactly:
   - `Submissions`
   - `Users`
   - `Stats`
   - `DeptStats`

4. Add these column headers in **row 1** of each tab:

**Submissions tab** (row 1):
| A | B | C | D | E | F |
|---|---|---|---|---|---|
| Name | Department | Date | Time | Q1 Reflection | Q2 Reflection |

**Users tab** (row 1):
| A | B | C | D |
|---|---|---|---|
| Telegram Username | Real Name | Department | Chat ID |

**Stats tab** (row 1):
| A | B | C | D | E |
|---|---|---|---|---|
| Name | Plant Stage | Progress % | Streak | Submitted This Week |

**DeptStats tab** (row 1):
| A | B | C | D | E |
|---|---|---|---|---|
| Department | Garden Stage | Progress % | Total Submissions | Target Submissions |

5. Copy the **Sheet ID** from the URL — it's the long string between `/d/` and `/edit`:
   ```
   https://docs.google.com/spreadsheets/d/THIS_IS_YOUR_SHEET_ID/edit
   ```

---

## Step 3 — Set Up Google Cloud Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project — name it `tc-cultivaite`
3. In the left menu, go to **APIs & Services → Library**
4. Search for **Google Sheets API** and click **Enable**
5. Go to **IAM & Admin → Service Accounts**
6. Click **Create Service Account**
   - Name: `tc-cultivaite-bot`
   - Click **Create and Continue** (no roles needed)
   - Click **Done**
7. Click on the service account you just created
8. Go to the **Keys** tab → **Add Key → Create new key → JSON**
9. A JSON file downloads automatically — open it and keep it handy

---

## Step 4 — Share the Sheet with the Service Account

1. Open the JSON key file you downloaded
2. Find the `client_email` field — it looks like:
   ```
   tc-cultivaite-bot@tc-cultivaite.iam.gserviceaccount.com
   ```
3. Open your Google Sheet → click **Share** (top right)
4. Paste the service account email and give it **Editor** access
5. Uncheck "Notify people" and click **Share**

---

## Step 5 — Configure the Bot

1. In the `tc-cultivaite-bot/` folder, copy the example env file:
   ```bash
   cp .env.example .env
   ```

2. Open `.env` and fill in:

   ```
   BOT_TOKEN=paste_your_telegram_bot_token_here
   SHEET_ID=paste_your_google_sheet_id_here
   GOOGLE_CREDENTIALS_JSON=paste_json_here_as_one_line
   Q2_START_DATE=2026-04-13
   ```

   For `GOOGLE_CREDENTIALS_JSON`: open the downloaded JSON key file, select all, and paste it as a **single line** (no line breaks). You can use a tool like [JSON minifier](https://jsonformatter.org/json-minify) to collapse it.

3. Install dependencies:
   ```bash
   npm install
   ```

---

## Step 6 — Populate the Users Tab

Before launching, add all employees to the **Users tab** in Google Sheets:

| Column | What to enter |
|--------|--------------|
| A — Telegram Username | Their username **without @**, all lowercase (e.g. `wilsontan`) |
| B — Real Name | Their display name as it should appear in bot messages (e.g. `Wilson`) |
| C — Department | Exact department name (must match DeptStats tab exactly) |
| D — Chat ID | Leave blank — the bot fills this in automatically |

> **Note:** The department name in column C must exactly match column A in the DeptStats tab — same spelling, capitalisation, and slashes. For example: `Marketing LeadGen/PR/Website`

---

## Step 7 — Populate the DeptStats Tab

Add one row per department to the **DeptStats tab**. Apps Script will update these automatically once it's set up, but seed the initial values manually:

| A — Department | B — Garden Stage | C — Progress % | D — Total Submissions | E — Target Submissions |
|---|---|---|---|---|
| Marketing LeadGen/PR/Website | 🌱 | 0 | 0 | 64 |
| Ops/Purchasing/IT | 🌱 | 0 | 0 | 64 |
| ON | 🌱 | 0 | 0 | 36 |
| ... | 🌱 | 0 | 0 | 36 or 16 |

Target submissions by team size:
- 10+ people → **64**
- 5–9 people → **36**
- 1–4 people → **16**

---

## Step 8 — Run the Bot

```bash
npm start
```

You should see:
```
🌱 TC CultivAIte bot starting...
✅ Bot is running! Press Ctrl+C to stop.
```

---

## Step 9 — Test It

1. Open Telegram and find your bot (search for the username you gave it)
2. Send `/help` — should list all commands
3. Send `/reflect` — should start the reflection flow (you need to be in the Users tab first)
4. Complete the two questions — check that a row appears in the **Submissions tab** in Google Sheets
5. Send `/reflect` again — should say "already watered this week"
6. Send `/department` — should show your department garden (or a placeholder if DeptStats isn't populated yet)

---

## Step 10 — Apps Script Setup (Phase 2)

The **Stats** and **DeptStats** tabs are populated by Google Apps Script — not the bot. Until Apps Script is configured:
- `/reflect` still works fully — submissions are logged correctly
- The progress bar will show a "getting started" fallback message (no stats yet)
- `/department` will show a placeholder until DeptStats is seeded

Apps Script setup is covered in a separate document. The bot is designed to degrade gracefully in the meantime.

---

## Step 11 — Deploy to Railway (Optional, for always-on hosting)

For the bot to run 24/7 without your laptop being on:

1. Push this folder to a GitHub repo
2. Go to [Railway](https://railway.app) → New Project → Deploy from GitHub
3. Select the repo
4. In Railway's environment variables dashboard, add all the same variables from your `.env`
5. Railway detects `npm start` from `package.json` automatically
6. Done — the bot runs continuously, including Sunday nudges

---

## Troubleshooting

**"No Google credentials found"** — Make sure `GOOGLE_CREDENTIALS_JSON` in `.env` is the full JSON pasted as a single line with no line breaks.

**"Unable to parse range"** — Check that your Sheet has exactly these tab names: `Submissions`, `Users`, `Stats`, `DeptStats` (case-sensitive).

**Bot doesn't respond** — Make sure `BOT_TOKEN` is correct and the bot is running (`npm start`).

**User not found after adding to Users tab** — Telegram usernames in column A must be lowercase and without the `@`. Example: `wilsontan` not `@WilsonTan`.

**Sunday nudge not sending** — The nudge fires at 10:00 AM SGT (02:00 UTC) on Sundays. To test sooner, temporarily change the cron pattern in `bot.js` to a time 2 minutes away, restart the bot, and revert after testing.

---

## Commands Reference

| Command | What it does |
|---------|-------------|
| `/reflect` | Submit your weekly reflection (2 questions) |
| `/department` | View your department garden + TC Forest |
| `/cancel` | Cancel a reflection in progress |
| `/help` | List all commands |
| `/start` | Welcome message |
