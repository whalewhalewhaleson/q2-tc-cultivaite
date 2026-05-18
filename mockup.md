# TC CultivAIte Bot — UI Mockup
> All commands & every bot response

---

## /start

**→ Bot:**
```
🌱 Welcome to TC CultivAIte!

This is your personal reflection companion for Q2.

Every week you reflect, your plant grows. Your department's garden blooms. Together, we build the TC Forest.

It only takes a few minutes — and every reflection counts.

Start by setting your Q2 goal with /setgoal, then type /reflect to begin. Or /help to see all commands.
```

---

## /help

**→ Bot:**
```
🌱 TC CultivAIte
Your Q2 reflection companion

/reflect — 💧 Submit your weekly reflection
/mystats — 🌿 Check your plant, pts & streak
/setgoal — 🎯 Set or update your Q2 goal
/department — 🌳 See your department garden
/leaderboard — 🏆 See all departments ranked by pts
/tutorial — 📖 How points and stages work
/myreflections — 📋 Browse your past reflections
/editreflection — ✏️ Update your most recent reflection
/cancel — ❌ Cancel a reflection in progress
/skipweek — 🗓 (Admin) Excuse a user for a week
/help — Show this message

Reflect weekly. Grow together.
```

---

## /tutorial

**→ Bot:**
```
📖 How TC CultivAIte Works

⭐ Earning Points
• Reflect each week ▸ 10 pts
• Streak bonus ▸ +1 pt for each consecutive week
  (week 3 of a streak = 12 pts)
• Share good news ▸ +5 pts (admin-reviewed)
• Get named in good news ▸ +3 pts (admin-reviewed)
• Max 1 good news nomination per person per week

🪴 Plant Stages
🌱 Seedling ▸ 0–20 pts
🌿 Sprout ▸ 21–50 pts
🌳 Sapling ▸ 51–85 pts
🌼 Flowering ▸ 86–115 pts
🍎 Apple ▸ 116–149 pts
🍊 Orange ▸ 150–189 pts
🍋 Lemon ▸ 190–234 pts
🍉 Watermelon ▸ 235–284 pts
🏵 Rosette ▸ 285+ pts

🍂 If You Miss a Week
• Miss 1 week ▸ plant goes 🍂 Dying
• Miss 2+ weeks ▸ plant goes 🥀 Dead
• Your pts never decrease — reflect to revive your plant!

💧 Fertilizer
• Each consecutive week you reflect adds a 💧
• More fertilizer = bigger pts bonus per week

🏆 Department Garden
• Dept score = average of all members' pts
• Everyone submits for 4 weeks in a row → 2× pts for everyone that week!
• Can trigger twice this quarter (week 4 and week 8)

Reflect weekly. Grow together. 🌱
```

---

## /setgoal — New user (no goal yet)

**→ Bot:**
```
🎯 What's your goal for Q2?

This will show up as a reminder at the start of every reflection.
```

**← User:** `Sharpen my communication skills and contribute meaningfully to every project I touch.`

**→ Bot:**
```
✅ Goal saved! 🌱

🎯 Sharpen my communication skills and contribute meaningfully to every project I touch.

You'll see this at the start of every /reflect.
```

---

## /setgoal — Update existing goal

**→ Bot:**
```
🎯 Your current Q2 goal:
Sharpen my communication skills and contribute meaningfully to every project I touch.

What would you like to change it to?
```

**← User:** `Lead at least one cross-department initiative this quarter.`

**→ Bot:**
```
✅ Goal saved! 🌱

🎯 Lead at least one cross-department initiative this quarter.

You'll see this at the start of every /reflect.
```

---

## /reflect — Full normal flow

**→ Bot (Step 1 — Plant card):**
```
Week 1

Hey Wilson 👋

🌿 Your Plant ▸ 30 pts
●●●●●●●●●○  21 pts to 🌳

💧 Fertilizer ▸ 💧💧💧 (3 weeks)
❌ Not submitted yet

🏅 You're #3 of 12
```

**→ Bot (Step 2 — Goal reminder):**
```
🎯 Your Q2 Goal
Sharpen my communication skills and contribute meaningfully to every project I touch.
```

**→ Bot (Step 3 — Q1):**
```
Q1: What's one thing you've grown in personally this week?

Take your time — there are no wrong answers here.
```

**← User:** `I've been more intentional about listening before responding in team discussions.`

**→ Bot (Step 4 — Q2):**
```
Q2: How have you improved professionally this week?

Even small steps count.
```

**← User:** `I completed the first draft of the campaign deck ahead of schedule.`

**→ Bot (Step 5 — Q3):**
```
Q3 (Optional): Got any good news to share about someone this week?

Name them and what they did — both your dept and theirs earn bonus pts! Or type skip to finish.
```

**← User:** `skip`

**→ Bot (Step 6 — Confirmation):**
```
💧 Plant watered!

🌿 Your Plant ▸ 33 pts
●●●●●●●●●●  18 pts to 🌳

💧 Fertilizer ▸ 💧💧💧💧 (4 weeks)
✅ Submitted this week

🏅 You're #3 of 12

Great work this week. See you next Monday! 🌿
```

---

## /reflect — Level-up variant

> Same Q1 → Q2 → Q3 flow. Different confirmation:

**→ Bot:**
```
💧 Plant watered!

🌳 Your plant just levelled up!

18 more pts to reach 🌼

⭐ 51 pts total. You're growing — keep it up! 🌳
```

---

## /reflect — Already submitted this week

**→ Bot (Plant card — with notice):**
```
Week 1

Hey Wilson 👋

🌿 Your Plant ▸ 33 pts
●●●●●●●●●●  18 pts to 🌳

💧 Fertilizer ▸ 💧💧💧💧 (4 weeks)
✅ Submitted this week

🏅 You're #3 of 12

You've already reflected this week — this one won't move your pts, but it's still stored. Keep going!
```

> Q1, Q2, Q3 prompts still shown. Then:

**→ Bot (Confirmation):**
```
📝 Reflection stored!

Your pts are already locked in for this week — this one's just for you. Keep that momentum going! 🌿

See you next week.
```

---

## /reflect — With good news nomination

> Same up to Q3:

**← User:** `Sarah from Operations stayed late to help us fix a last-minute deck issue. Real team player.`

**→ Bot:**
```
Who are you nominating? Type their full name as it appears in the system.
```

**← User:** `Sarah Lim`

**→ Bot:**
```
💧 Plant watered!

🌿 Your Plant ▸ 33 pts
●●●●●●●●●●  18 pts to 🌳

💧 Fertilizer ▸ 💧💧💧💧 (4 weeks)
✅ Submitted this week

Great work this week. See you next Monday! 🌿

🌟 Your good news about Sarah Lim has been noted — the team will review it!
```

---

## /reflect — User not in system

**→ Bot:**
```
Hey! 👋 Looks like you're not in our system yet.

Text @whalewhalewhalee to get added, then come back here — your reflection journey is waiting! 🌱
```

---

## /mystats — With stats

**→ Bot:**
```
Week 1

Hey Wilson 👋

🌿 Your Plant ▸ 33 pts
●●●●●●●●●●  18 pts to 🌳

💧 Fertilizer ▸ 💧💧💧💧 (4 weeks)
✅ Submitted this week

🏅 You're #3 of 12

Your plant is waiting. /reflect to water it 💧
```

---

## /mystats — First-time user

**→ Bot:**
```
Week 1

Hey Wilson 👋

🌱 Your Plant ▸ 0 pts
○○○○○○○○○○  21 pts to 🌿

💧 Fertilizer ▸ None (0 weeks)
❌ Not submitted yet this week

Ready to plant your first seed? /reflect 💧
```

---

## /myreflections

**→ Bot:**
```
📋 Your Reflections

2026-04-14
Q1: I've been more intentional about listening before responding in team discussions.
Q2: I completed the first draft of the campaign deck ahead of schedule.

2026-04-07
Q1: Worked on staying calm under pressure during the event setup.
Q2: Coordinated with 3 departments on the Q1 wrap-up.

2026-03-31
Q1: Started being more proactive about asking for feedback.
Q2: Drafted the first version of the social media calendar for Q2.

2026-03-24
Q1: Pushed myself to speak up more in the weekly team sync.
Q2: Helped onboard a new team member and documented the process.

2026-03-17
Q1: Focused on not multitasking during meetings.
Q2: Completed the brand audit ahead of the deadline.

Showing your last 5 entries.
Want to make a change? /editreflection
```

---

## /editreflection

**→ Bot:**
```
Your most recent reflection:

📅 2026-04-14

Q1: I've been more intentional about listening before responding in team discussions.

Q2: I completed the first draft of the campaign deck ahead of schedule.

Which part would you like to update?
Reply 1 for Q1, 2 for Q2, or 3 for both
```

**← User:** `2`

**→ Bot:**
```
Q2: How have you improved professionally this week?

Even small steps count.
```

**← User:** `I refined the campaign deck based on feedback and presented it to the team.`

**→ Bot:**
```
✅ Reflection updated! Your words are saved. 🌱
```

---

## /department

**→ Bot:**
```
🌿 Business Development
Garden ▸ ●●●●●●●●○○ 78%
Stage ▸ Sprout
⭐ Avg Points ▸ 42
📅 Dept Streak ▸ 2 consecutive 100% week(s)
```

---

## /leaderboard

**→ Bot:**
```
🏆 TC Forest Leaderboard

🥇 🌳 Operations
⭐ 68 avg pts — Sapling

🥈 🌿 Business Development
⭐ 42 avg pts — Sprout

🥉 🌿 Marketing
⭐ 38 avg pts — Sprout

4. 🌱 Finance
⭐ 18 avg pts — Seedling

5. 🌱 HR & Admin
⭐ 12 avg pts — Seedling

Keep reflecting to climb the ranks! 🌿
```

---

## /cancel

**→ Bot:**
```
No worries! 🌱 Come back whenever you're ready.
Your plant will be here waiting — /reflect to continue.
```

---

## /skipweek (Admin only)

### ✅ Success
**← User:** `/skipweek Wilson 3`

**→ Bot:**
```
✅ Week skipped!

Wilson (Business Development) has been marked as excused for Week 3.

Their streak will be preserved once Apps Script recalculates.
```

### 🚫 Non-admin attempt
**→ Bot:**
```
Sorry, this command is only available to admins.
```

### ⚠️ Invalid syntax
**← User:** `/skipweek Wilson`

**→ Bot:**
```
Usage: /skipweek [Name] [Week]

Example: /skipweek Wilson 3

Week must be a number between 1 and 13.
```

### ❓ User not found
**← User:** `/skipweek Wilsun 3`

**→ Bot:**
```
Wilsun not found in the Users tab.

Check the spelling matches column B exactly.
```

---

## Auto — Monday Nudge

> ⏰ Sent every Monday 10:00 AM SGT · Only to users who haven't submitted this week

**→ Bot:**
```
🌱 Hey Wilson! Just a gentle nudge from your reflection companion.

You haven't reflected this week yet — and your plant is waiting to be watered! 💧

Submit before 6 PM today to keep your streak alive.
/reflect — it only takes a couple of minutes.
```
