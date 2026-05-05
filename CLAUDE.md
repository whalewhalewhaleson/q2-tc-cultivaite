# TC CultivAIte Bot

Q2 2026 weekly reflection bot for TC Acoustic. Telegram bot + web dashboard.

## Stack

- **Runtime:** Node.js (ES modules), deployed on Railway
- **Bot:** grammyjs + @grammyjs/conversations
- **Database:** Supabase (submissions, users, good_news, good_news_awards, late_submissions, extensions)
- **Legacy:** Google Sheets (sheets.js) — historical, Supabase is primary
- **Dashboard:** Single-file `dashboard.html` served by bot.js HTTP server

## Architecture

```
bot.js (~2500 lines)
├── Telegram bot handlers (grammyjs)
├── HTTP server → serves dashboard.html + API endpoints
│   ├── GET /api/stats            → getFullDashboardStats()  (main data)
│   ├── GET /api/reflections?week=N
│   ├── PATCH /api/submissions/:id/week  → move submission to a different week
│   ├── PATCH /api/good-news/:id/week   → reassign good news to a different week (fixes late-entry attribution)
│   └── POST endpoints for admin actions
└── Cron jobs (reminders, nudges)

db.js (~900 lines)
├── buildStatsCache()  → core computation, cached 30s
│   ├── userWeekMap    → per-user per-week submission state
│   ├── deptWeekRate   → per-dept per-week submission rates
│   ├── deptConsec     → consecutive 100% dept weeks (for bonus + streaks)
│   ├── statsMap       → per-user stats (points, streak, weeklyBreakdown, goodNewsEvents)
│   └── deptStatsMap   → per-dept stats (avgPoints, deptStreak, gardenStage)
├── Supabase CRUD (users, submissions, good_news, extensions)
└── Helper functions (pointsToStage, week calculations)

dashboard.html (~2000 lines)
├── Tabs: Overview | Members (Rankings) | Reflections | Good News | Admin
├── renderOverview()    → week-selectable overview with KPIs
├── renderRankings()    → Departments + Individuals tables, week selector
├── renderReflections() → per-week reflection cards
├── renderGoodNews()    → pending/approved/rejected GN cards; admin "📅 Move week" button on approved cards
└── Drawer views for individual users and departments
```

## Week Math

- Q2 epoch: 2026-03-30 16:00 SGT (Monday 4pm)
- Week 1 = Mar 30 – Apr 6, Week 2 = Apr 7 – Apr 13, etc.
- Launch week = 4 (points only count from week 4 onward)
- `toISOWeek(w)` = w + 13 (converts internal week to ISO week number)
- Submission window: Monday 4pm to next Monday 3:59pm SGT

## Points System

- On-time submission: 10 + (streak - 1) pts
- Late submission: 5 pts (breaks streak)
- Excused absence: 0 pts (preserves streak)
- Dept 4-week bonus: 2x if department has 100% submission for 4+ consecutive weeks
- Good news: nominator gets pts_sharer (5), recipients get pts_nominee (3)

## Plant Stages (by cumulative points)

0→🌱 Seedling | 21→🌿 Sprout | 51→🌳 Sapling | 86→🌼 Flowering | 116→🍎 Fruiting
1 consecutive miss → 🍂 Dying | 2+ consecutive misses → 🥀 Dead

## Data Flow for Dashboard

1. `init()` fetches `/api/stats`
2. `bot.js` calls `db.js → getFullDashboardStats()`
3. `buildStatsCache()` queries Supabase, computes all stats, caches 30s
4. Response includes: users[] (with weeklyBreakdown, weekHistory, goodNewsEvents), depts[] (with streakByWeek)
5. Dashboard renders tabs from `_stats` global; week selectors filter/recompute per-week views

## Key Patterns

- Cache: 30s TTL via `cacheSet/cacheGet`, invalidated on writes via `invalidateStatsCache()`
- Admin auth: dashboard access controlled by `dashboard_access` table
- All Supabase queries in db.js, bot.js handles Telegram + HTTP routing
- Department names are case-sensitive in most places; `deptStatsMap` keys are lowercased
- Good news `week_number` is set at submission time; late entries may land in the wrong week — use "📅 Move week" on approved cards to fix attribution manually
