# TC CultivAIte Bot — Claude Context Reference

> Quick-start reference for Claude sessions editing this bot. Read this before touching any code.

## Stack

- **Runtime:** Node.js, deployed on Railway
- **Bot framework:** Grammy (Telegram)
- **Database:** Supabase (PostgreSQL)
- **Key files:**
  - `bot.js` — all Telegram command handlers, cron jobs, display logic (~1492 lines)
  - `db.js` — Supabase data layer: stats calculation, points, week logic (~656 lines)
  - `dashboard.html` — leadership web dashboard (self-contained, ~56 KB)
  - `migrations/001_good_news_awards.sql` — adds multi-recipient good news awards table

---

## Week Number System (CRITICAL — two calendars coexist)

| Location | Start Date | Purpose |
|----------|-----------|---------|
| `db.js` `Q2_START` | `2026-03-30` | Stats/points calculation; April 20 = **Week 4**, April 27 = **Week 5** |
| `bot.js` `getWeekNumber()` / `currentQ2Week()` | `2026-04-20` | User-facing display; April 20 = **Week 1**, April 27 = **Week 2** |

The two functions serve different purposes and intentionally use different start dates. Don't unify them without understanding the downstream impact.

**Current week formula (db.js):**
```js
ceil((daysSince + 1) / 7), clamped [1, 13]
```

---

## Points Logic

**Key constant to adjust:** `LAUNCH_DATE` in `db.js` line 30.
Stats loop: `for (let wk = launchWeek; wk <= weekNow; wk++)` — weeks before `launchWeek` are completely ignored (no points, no misses).

| Rule | Value |
|------|-------|
| Base per reflection | 10 pts |
| Streak bonus | +1 pt per consecutive week |
| Good news nominator | +5 pts (admin approval required) |
| Good news recipient | +3 pts (admin approval required) |
| Dept 2× multiplier | Applied when dept hits 4+ consecutive 100% weeks |

**Stage thresholds:** 0 / 21 / 51 / 86 / 116 pts → 🌱 🌿 🌳 🌼 🍎  
**Dying/dead display:** based on `consecutiveMisses` (1 miss = 🍂, 2+ = 🥀), not points.

Excused absences (`[Excused absence]`) via `/skipweek` preserve streak but earn 0 pts.

---

## Cron / Nudge

- **Schedule:** `0 2 * * 1` (UTC) = **Monday 10 AM SGT**
- **Skips:** `currentQ2Week() === 1` (i.e., the week of April 20, using bot.js calendar)
- **Who gets nudge:** users with `submittedThisWeek === false` at send time
- **Timezone note:** cron is hardcoded UTC; SGT = UTC+8

---

## Supabase Tables

| Table | Key columns |
|-------|------------|
| `submissions` | `real_name`, `department`, `date` (YYYY-MM-DD SGT), `q1`, `q2`, `q3` |
| `users` | `real_name` (PK), `department`, `secondary_department`, `goal`, `nickname`, `chat_id` |
| `good_news` | `nominator_name`, `nominee_name`, `week_number`, `status` (Pending/Approved/Rejected) |
| `good_news_awards` | `good_news_id` (FK), `recipient_name`, `pts` — one row per recipient |

Cache TTLs: `users` = 5 min, `stats` = 30 sec. Cache is invalidated immediately after each submission.

---

## Common Edit Locations

| Task | File | What to change |
|------|------|---------------|
| Shift when points start counting | `db.js:30` | `LAUNCH_DATE` |
| Change Q2 duration | `db.js:32-42` | Clamp max in week functions |
| Change base points per reflection | `db.js:~220` | `let weekPts = 10 + ...` |
| Change stage thresholds | `db.js:80-81` | `STAGE_THRESHOLDS` |
| Change nudge timing | `bot.js:1335` | Cron expression |
| Change nudge skip condition | `bot.js:1337` | `currentQ2Week() === 1` check |
| Change reflection questions | `bot.js:354-372` | Q1/Q2 prompt strings |

---

## Admin Commands

| Command | Who | Effect |
|---------|-----|--------|
| `/skipweek [Name] [Week]` | Admin | Excuses absence; preserves streak |
| `/testnudge [Name]` | Admin | Test Monday nudge message |
| `/broadcast all/me/<Name> <msg>` | Admin | Send message to users |
| `/dashboard` | Admin + Leadership | Live stats snapshot |

---

## Deployment

Bot runs on Railway. After editing `db.js` or `bot.js`, push to the bot's git repo to trigger redeploy. The bot's git repo is separate from the Claude OS monorepo (it's a submodule at `TC-Q2 CultivAIte/tc-cultivaite-bot/`).
