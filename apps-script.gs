/**
 * TC CultivAIte — Google Apps Script
 *
 * Paste this entire file into your Google Sheet's Apps Script editor.
 * Tools → Apps Script → replace any existing code → Save → run setupTriggers() once.
 *
 * What this does:
 *   - Reads Submissions tab
 *   - Calculates per-user streaks, plant stage, progress → writes Stats tab
 *   - Calculates per-department garden progress → writes DeptStats tab
 *   - Catches Google Form backup submissions → maps them to Submissions tab
 */

// ============================================================
// CONFIGURATION — update Q2_START_DATE if your dates change
// ============================================================

const CONFIG = {
  Q2_START_DATE: '2026-04-20',   // Monday — first day of Q2 (YYYY-MM-DD)
  TOTAL_WEEKS: 13,
  RESET_HOUR_SGT: 18,            // 6 PM SGT = streak reset hour

  SHEETS: {
    SUBMISSIONS: 'Submissions',
    USERS: 'Users',
    STATS: 'Stats',
    DEPT_STATS: 'DeptStats',
  },

  // Streak multipliers: index 0 = week 1, index 1 = week 2, index 2 = week 3, index 3+ = week 4+
  MULTIPLIERS: [1.0, 1.5, 2.0, 2.5],

  STAGES: ['🌱', '🌿', '🌳', '🌼', '🍎'],
  STAGE_THRESHOLDS: [0, 20, 40, 60, 80, 100], // overall % boundaries per stage
};


// ============================================================
// MAIN ENTRY POINT — called by trigger or manually
// ============================================================

function updateAllStats() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const submissionsSheet = ss.getSheetByName(CONFIG.SHEETS.SUBMISSIONS);
  const usersSheet = ss.getSheetByName(CONFIG.SHEETS.USERS);
  const statsSheet = ss.getSheetByName(CONFIG.SHEETS.STATS);
  const deptStatsSheet = ss.getSheetByName(CONFIG.SHEETS.DEPT_STATS);

  if (!submissionsSheet || !usersSheet || !statsSheet || !deptStatsSheet) {
    console.error('One or more sheets not found. Check sheet tab names match CONFIG.SHEETS exactly.');
    return;
  }

  const submissions = loadSubmissions(submissionsSheet);
  const users = loadUsers(usersSheet);
  const currentWeekKey = getCurrentWeekKey();

  // --- Per-user stats ---
  const userStats = {};
  for (const user of users) {
    userStats[user.realName] = calculateUserStats(user.realName, submissions, currentWeekKey);
  }
  writeStatsTab(statsSheet, users, userStats);

  // --- Per-department stats ---
  const deptTargets = loadDeptTargets(deptStatsSheet);
  const deptStats = calculateDeptStats(submissions, users, currentWeekKey, deptTargets);
  writeDeptStatsTab(deptStatsSheet, deptStats, deptTargets);

  console.log('✅ updateAllStats() complete — ' + new Date().toISOString());
}


// ============================================================
// DATA LOADING
// ============================================================

function loadSubmissions(sheet) {
  const data = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;
    rows.push({
      name:       String(row[0]).trim(),
      department: String(row[1]).trim(),
      date:       String(row[2]).trim(), // YYYY-MM-DD (SGT)
      time:       String(row[3]).trim(), // HH:MM AM/PM (SGT)
    });
  }
  return rows;
}

function loadUsers(sheet) {
  const data = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;
    rows.push({
      username:   String(row[0]).trim().toLowerCase(),
      realName:   String(row[1]).trim(),
      department: String(row[2]).trim(),
    });
  }
  return rows;
}

function loadDeptTargets(sheet) {
  const data = sheet.getDataRange().getValues();
  const targets = {};
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;
    targets[String(row[0]).trim()] = Number(row[4]) || 0;
  }
  return targets;
}


// ============================================================
// WEEK KEY HELPERS
// All dates/times in Submissions tab are already in SGT.
// A "week" runs Monday 6 PM SGT → next Monday 6 PM SGT.
// Week key = "YYYY-MM-DD" of the Monday that opened this week.
// ============================================================

function getWeekKey(dateStr, timeStr) {
  // Parse date
  const [year, month, day] = dateStr.split('-').map(Number);

  // Parse time (HH:MM AM/PM)
  const match = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!match) return null;
  let hours = parseInt(match[1]);
  const period = match[3].toUpperCase();
  if (period === 'PM' && hours !== 12) hours += 12;
  if (period === 'AM' && hours === 12) hours = 0;

  // JavaScript Date — treated as local (doesn't matter; we only care about day-of-week math)
  const dt = new Date(year, month - 1, day, hours, 0, 0);
  const dow = dt.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat

  // How many days to subtract to reach the Monday that opened this week
  let daysBack;
  if (dow === 1 && hours < CONFIG.RESET_HOUR_SGT) {
    daysBack = 7; // Monday before 6 PM → belongs to PREVIOUS week
  } else if (dow === 0) {
    daysBack = 6; // Sunday
  } else {
    daysBack = (dow === 1) ? 0 : dow - 1;
  }

  const weekMonday = new Date(dt);
  weekMonday.setDate(dt.getDate() - daysBack);

  const y = weekMonday.getFullYear();
  const m = String(weekMonday.getMonth() + 1).padStart(2, '0');
  const d2 = String(weekMonday.getDate()).padStart(2, '0');
  return `${y}-${m}-${d2}`;
}

function getCurrentWeekKey() {
  // Build a fake "submission" entry for right now, in SGT
  const now = new Date();
  const sgtNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);

  const y = sgtNow.getUTCFullYear();
  const m = String(sgtNow.getUTCMonth() + 1).padStart(2, '0');
  const d = String(sgtNow.getUTCDate()).padStart(2, '0');
  const h = sgtNow.getUTCHours();
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;

  return getWeekKey(`${y}-${m}-${d}`, `${h12}:00 ${period}`);
}

function getWeekMonday(weekNumber) {
  // Returns "YYYY-MM-DD" of the Monday that opens week N (1-indexed)
  const q2Start = new Date(CONFIG.Q2_START_DATE + 'T00:00:00');
  const monday = new Date(q2Start);
  monday.setDate(q2Start.getDate() + (weekNumber - 1) * 7);
  const y = monday.getFullYear();
  const m = String(monday.getMonth() + 1).padStart(2, '0');
  const d = String(monday.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getWeekNumber(weekKey) {
  const q2Start = new Date(CONFIG.Q2_START_DATE + 'T00:00:00');
  const weekDate = new Date(weekKey + 'T00:00:00');
  const diffDays = Math.round((weekDate - q2Start) / (1000 * 60 * 60 * 24));
  return Math.floor(diffDays / 7) + 1;
}


// ============================================================
// USER STATS CALCULATION
// ============================================================

function calculateUserStats(realName, allSubmissions, currentWeekKey) {
  const userSubs = allSubmissions.filter(
    s => s.name.toLowerCase() === realName.toLowerCase()
  );

  // First submission per week only
  const weekMap = {};
  for (const sub of userSubs) {
    const wk = getWeekKey(sub.date, sub.time);
    if (wk && !weekMap[wk]) weekMap[wk] = sub;
  }

  // Build week-by-week history for weeks 1 → current
  const currentWeekNum = Math.max(1, Math.min(CONFIG.TOTAL_WEEKS, getWeekNumber(currentWeekKey)));
  const weekHistory = [];
  for (let w = 1; w <= currentWeekNum; w++) {
    const wKey = getWeekMonday(w);
    weekHistory.push({ wKey, submitted: !!weekMap[wKey] });
  }

  // Current streak — consecutive submitted weeks going backwards from now
  let streak = 0;
  for (let i = weekHistory.length - 1; i >= 0; i--) {
    if (weekHistory[i].submitted) streak++;
    else break;
  }

  // Total scored weeks (used for plant stage)
  const totalScoredWeeks = weekHistory.filter(w => w.submitted).length;

  // Personal plant: overall % = scored weeks / total weeks × 100
  const overallPct = (totalScoredWeeks / CONFIG.TOTAL_WEEKS) * 100;
  const { stage, progressPct } = stageFromOverallPct(overallPct);

  const submittedThisWeek = !!weekMap[currentWeekKey];

  return { stage, progressPct, streak, submittedThisWeek };
}


// ============================================================
// DEPARTMENT STATS CALCULATION
// ============================================================

function calculateDeptStats(allSubmissions, users, currentWeekKey, deptTargets) {
  // Build department → users map
  const deptUsersMap = {};
  for (const user of users) {
    if (!deptUsersMap[user.department]) deptUsersMap[user.department] = [];
    deptUsersMap[user.department].push(user.realName);
  }

  const currentWeekNum = Math.max(1, Math.min(CONFIG.TOTAL_WEEKS, getWeekNumber(currentWeekKey)));
  const deptStats = {};

  for (const [dept, deptUsers] of Object.entries(deptUsersMap)) {
    const target = deptTargets[dept] || 0;
    let totalWeighted = 0;

    for (const userName of deptUsers) {
      const userSubs = allSubmissions.filter(
        s => s.name.toLowerCase() === userName.toLowerCase()
      );

      // First submission per week only
      const weekMap = {};
      for (const sub of userSubs) {
        const wk = getWeekKey(sub.date, sub.time);
        if (wk && !weekMap[wk]) weekMap[wk] = sub;
      }

      // Walk week by week, tracking streak and applying multiplier
      let userStreak = 0;
      for (let w = 1; w <= currentWeekNum; w++) {
        const wKey = getWeekMonday(w);
        if (weekMap[wKey]) {
          userStreak++;
          const mIdx = Math.min(userStreak - 1, CONFIG.MULTIPLIERS.length - 1);
          totalWeighted += CONFIG.MULTIPLIERS[mIdx];
        } else {
          userStreak = 0;
        }
      }
    }

    const overallPct = target > 0 ? Math.min(100, (totalWeighted / target) * 100) : 0;
    const { stage, progressPct } = stageFromOverallPct(overallPct);

    deptStats[dept] = {
      gardenStage: stage,
      progressPct,
      totalSubmissions: Math.round(totalWeighted * 10) / 10,
      targetSubmissions: target,
    };
  }

  return deptStats;
}


// ============================================================
// STAGE HELPER
// ============================================================

function stageFromOverallPct(overallPct) {
  const thresholds = CONFIG.STAGE_THRESHOLDS;
  let stageIdx = 0;
  for (let i = 0; i < CONFIG.STAGES.length; i++) {
    if (overallPct >= thresholds[i]) stageIdx = i;
  }
  const stageMin = thresholds[stageIdx];
  const stageMax = thresholds[stageIdx + 1] !== undefined ? thresholds[stageIdx + 1] : 100;
  const progressPct = Math.min(100, Math.round(((overallPct - stageMin) / (stageMax - stageMin)) * 100));
  return { stage: CONFIG.STAGES[stageIdx], progressPct };
}


// ============================================================
// WRITING TO SHEETS
// ============================================================

function writeStatsTab(sheet, users, userStats) {
  const header = ['Name', 'Plant Stage', 'Progress %', 'Streak', 'Submitted This Week'];
  const rows = [header];
  for (const user of users) {
    const s = userStats[user.realName];
    if (!s) continue;
    rows.push([user.realName, s.stage, s.progressPct, s.streak, s.submittedThisWeek]);
  }
  sheet.clearContents();
  sheet.getRange(1, 1, rows.length, header.length).setValues(rows);
}

function writeDeptStatsTab(sheet, deptStats, deptTargets) {
  const header = ['Department', 'Garden Stage', 'Progress %', 'Total Submissions', 'Target Submissions'];
  const rows = [header];
  for (const [dept, s] of Object.entries(deptStats)) {
    rows.push([dept, s.gardenStage, s.progressPct, s.totalSubmissions, s.targetSubmissions]);
  }
  sheet.clearContents();
  sheet.getRange(1, 1, rows.length, header.length).setValues(rows);
}


// ============================================================
// GOOGLE FORM BACKUP — onFormSubmit trigger
//
// HOW TO SET UP:
// 1. Create a Google Form with these questions (in this order):
//    Q1: Your name (Short answer)
//    Q2: What's one thing you've grown in personally this week? (Paragraph)
//    Q3: How have you improved professionally this week? (Paragraph)
// 2. In the Form: Responses tab → Link to spreadsheet → select THIS sheet
//    (it will create a "Form Responses 1" tab — that's fine, leave it)
// 3. In Apps Script editor: Add trigger → onFormSubmit → From spreadsheet → On form submit
//
// The function below catches each form submission, maps it to the
// Submissions tab format, and then recalculates all stats.
// ============================================================

function onFormSubmit(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const usersSheet = ss.getSheetByName(CONFIG.SHEETS.USERS);
  const submissionsSheet = ss.getSheetByName(CONFIG.SHEETS.SUBMISSIONS);

  // Form response values: [Timestamp, Name, Q1, Q2]
  const responses = e.values;
  const timestamp = new Date(responses[0]);
  const formName  = String(responses[1]).trim();
  const q1        = String(responses[2]).trim();
  const q2        = String(responses[3]).trim();

  // Look up department from Users tab by real name
  const usersData = usersSheet.getDataRange().getValues();
  let department = 'Unknown';
  for (let i = 1; i < usersData.length; i++) {
    if (String(usersData[i][1]).trim().toLowerCase() === formName.toLowerCase()) {
      department = String(usersData[i][2]).trim();
      break;
    }
  }

  // Convert timestamp to SGT
  const sgtTimestamp = new Date(timestamp.getTime() + 8 * 60 * 60 * 1000);
  const date = Utilities.formatDate(sgtTimestamp, 'UTC', 'yyyy-MM-dd');
  const time = Utilities.formatDate(sgtTimestamp, 'UTC', 'h:mm a').toUpperCase(); // e.g. "2:30 PM"

  // Write to Submissions tab
  submissionsSheet.appendRow([formName, department, date, time, q1, q2]);

  // Recalculate stats immediately
  updateAllStats();

  console.log('Form submission logged for: ' + formName);
}


// ============================================================
// TRIGGER SETUP — run setupTriggers() ONCE from the editor
// ============================================================

function setupTriggers() {
  // Remove any existing triggers first to avoid duplicates
  deleteAllTriggers();

  // Run updateAllStats() every hour automatically
  ScriptApp.newTrigger('updateAllStats')
    .timeBased()
    .everyHours(1)
    .create();

  console.log('✅ Hourly trigger created for updateAllStats().');
  console.log('ℹ️  For the Google Form trigger: Apps Script editor → Triggers (clock icon) → Add trigger → onFormSubmit → From spreadsheet → On form submit.');
}

function deleteAllTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    ScriptApp.deleteTrigger(trigger);
  }
  console.log('All triggers deleted.');
}
