# TC CultivAIte — Apps Script Setup Guide

This script automatically calculates streaks, plant stages, and department garden progress.
It runs every hour and updates the Stats and DeptStats tabs.

---

## Step 1 — Open Apps Script

1. Open your Google Sheet (`TC CultivAIte Submissions`)
2. Click **Extensions → Apps Script**
3. A new tab opens — you'll see a default `Code.gs` file

---

## Step 2 — Paste the Script

1. Select **all** the existing code in `Code.gs` and delete it
2. Open `apps-script.gs` from the bot folder on your laptop
3. Copy everything and paste it into the Apps Script editor
4. Click **Save** (💾 icon or Cmd+S)

---

## Step 3 — Check the Config

At the top of the script, confirm:

```js
const CONFIG = {
  Q2_START_DATE: '2026-04-20',  // ← must match your actual Q2 start Monday
  ...
};
```

Change the date if needed, then save again.

---

## Step 4 — Run It Once Manually

1. In the function dropdown (top of editor), select **`updateAllStats`**
2. Click **Run** (▶ button)
3. First time: Google will ask for permissions — click **Review permissions → Allow**
4. Check the Stats and DeptStats tabs in your Sheet — they should now have data

---

## Step 5 — Set Up the Hourly Trigger

1. In the Apps Script editor, select **`setupTriggers`** from the dropdown
2. Click **Run**
3. This creates a trigger that runs `updateAllStats()` every hour automatically

To verify: click the **clock icon** (Triggers) in the left sidebar — you should see `updateAllStats` listed.

---

## Step 6 — Set Up the Google Form (Backup Submission)

This gives employees a way to submit if the Telegram bot is ever down.

### Create the Form

1. Go to [forms.google.com](https://forms.google.com) → **+ Blank**
2. Title: `TC CultivAIte — Weekly Reflection`
3. Add these questions **in this exact order**:

   | # | Question | Type |
   |---|---|---|
   | 1 | Your name (as it appears in the system) | Short answer |
   | 2 | What's one thing you've grown in personally this week? | Paragraph |
   | 3 | How have you improved professionally this week? | Paragraph |

4. Make all questions **Required**

### Link the Form to the Sheet

1. In the Form, click **Responses** tab → **Link to Sheets** (green icon)
2. Select **Select existing spreadsheet** → choose `TC CultivAIte Submissions`
3. It creates a new tab called `Form Responses 1` — that's fine, leave it

### Add the Form Submit Trigger

1. Go back to **Apps Script editor**
2. Click the **clock icon** (Triggers) in the left sidebar
3. Click **+ Add Trigger** (bottom right)
4. Configure it:

   | Setting | Value |
   |---|---|
   | Function | `onFormSubmit` |
   | Deployment | Head |
   | Event source | From spreadsheet |
   | Event type | On form submit |

5. Click **Save** → allow permissions if asked

Now whenever someone submits the form, the script maps their response to the Submissions tab and recalculates all stats immediately.

---

## What Each Tab Does Now

| Tab | Written by | Read by |
|---|---|---|
| Submissions | Bot + Form trigger | Apps Script |
| Users | Wilson (manually) | Bot + Apps Script |
| Stats | Apps Script (hourly) | Bot (`/reflect`, `/mystats`) |
| DeptStats | Apps Script (hourly) | Bot (`/department`) |

---

## Testing

1. Add yourself to the Users tab if not already there
2. Submit a reflection via `/reflect` in Telegram (or via the form)
3. In Apps Script editor, run `updateAllStats()` manually
4. Check Stats tab — your row should show your plant stage and streak
5. Check DeptStats tab — your department should show progress

---

## Troubleshooting

**Stats tab is empty after running**
→ Check that the Submissions tab has at least one row with data
→ Check that names in Submissions tab exactly match names in Users tab column B

**Department not appearing in DeptStats**
→ Make sure the department name in Users tab column C matches the department name already in DeptStats tab column A (exact match, case-sensitive)

**Form responses not appearing in Submissions tab**
→ Check the `onFormSubmit` trigger exists in the Triggers sidebar
→ Check the form field order matches: Name, Q1, Q2

**Script runs but streak is wrong**
→ Check that `Q2_START_DATE` in CONFIG is set to the correct Monday
→ Streak resets every Monday 6 PM SGT — submissions before 6 PM on Monday count as the previous week
