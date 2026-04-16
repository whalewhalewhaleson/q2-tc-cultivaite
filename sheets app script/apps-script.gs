/**
 * TC CultivAIte — Google Apps Script
 *
 * Paste this entire file into your Google Sheet's Apps Script editor.
 * Tools → Apps Script → replace any existing code → Save → run setupTriggers() once.
 *
 * What this does:
 *   - Reads Submissions tab
 *   - Calculates per-user pts, streaks, plant stage → writes Stats tab
 *   - Calculates per-department average pts, garden stage → writes DeptStats tab
 *   - Reads approved Good News nominations → adds bonus pts
 *   - Catches Google Form backup submissions → maps them to Submissions tab
 */

// ============================================================
// CONFIGURATION — update Q2_START_DATE if your dates change
// ============================================================

const CONFIG = {
  Q2_START_DATE: '2026-03-31',   // Monday — first day of Q2 (YYYY-MM-DD)
  TOTAL_WEEKS: 13,
  RESET_HOUR_SGT: 18,            // 6 PM SGT = week boundary hour

  SHEETS: {
    SUBMISSIONS: 'Submissions',
    USERS:       'Users',
    STATS:       'Stats',
    DEPT_STATS:  'DeptStats',
    GOOD_NEWS:   'GoodNews',
  },

  STAGES: ['🌱', '🌿', '🌳', '🌼', '🍎'],
  // Points lower-bounds per stage: Seedling, Sprout, Sapling, Flowering, Fruiting
  STAGE_THRESHOLDS: [0, 21, 51, 86, 116],

  PTS_BASE: 10,              // base pts per reflection submitted
  // Streak bonus = streakSoFar - 1  (week 1 = +0, week 2 = +1, week 5 = +4)

  DEPT_STREAK_WEEKS: 4,      // consecutive 100%-submission weeks to trigger multiplier
  DEPT_STREAK_MULTIPLIER: 2, // 2× pts for everyone on the trigger week
};


// ============================================================
// CUSTOM MENU — adds "TC CultivAIte > Update Stats" to the sheet toolbar
// ============================================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('TC CultivAIte')
    .addItem('Update All Stats', 'updateAllStats')
    .addToUi();
}


// ============================================================
// MAIN ENTRY POINT — called by trigger or manually
// ============================================================

function updateAllStats() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const submissionsSheet = ss.getSheetByName(CONFIG.SHEETS.SUBMISSIONS);
  const usersSheet       = ss.getSheetByName(CONFIG.SHEETS.USERS);
  const statsSheet       = ss.getSheetByName(CONFIG.SHEETS.STATS);
  const deptStatsSheet   = ss.getSheetByName(CONFIG.SHEETS.DEPT_STATS);
  const goodNewsSheet    = ss.getSheetByName(CONFIG.SHEETS.GOOD_NEWS); // null if not created yet

  if (!submissionsSheet || !usersSheet || !statsSheet || !deptStatsSheet) {
    console.error('One or more sheets not found. Check sheet tab names match CONFIG.SHEETS exactly.');
    return;
  }

  const submissions    = loadSubmissions(submissionsSheet);
  const users          = loadUsers(usersSheet);
  const currentWeekKey = getCurrentWeekKey();
  const currentWeekNum = Math.max(1, Math.min(CONFIG.TOTAL_WEEKS, getWeekNumber(currentWeekKey)));

  // Load approved Good News entries (graceful if tab doesn't exist yet)
  const goodNewsEntries = goodNewsSheet ? loadGoodNews(goodNewsSheet) : [];

  // Pre-calculate which weeks trigger the 2× dept multiplier per department
  const deptMultiplierWeeksMap = calculateDeptMultiplierWeeks(submissions, users, currentWeekNum);

  // --- Per-user stats ---
  const userStats = {};
  for (const user of users) {
    const deptMultiplierWeeks = deptMultiplierWeeksMap[user.department] || new Set();
    userStats[user.realName] = calculateUserStats(
      user.realName, submissions, currentWeekKey, goodNewsEntries, deptMultiplierWeeks
    );
  }
  writeStatsTab(statsSheet, users, userStats);

  // --- Per-department stats ---
  const deptTargets = loadDeptTargets(deptStatsSheet);
  const deptStats = calculateDeptStats(submissions, users, currentWeekKey, userStats);
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

/**
 * Reads the GoodNews tab and returns only Approved entries.
 * Columns: Timestamp(A) | NominatorName(B) | NominatorDept(C) | NomineeName(D) |
 *          NomineeDept(E) | Message(F) | WeekNumber(G) | Status(H) | PtsSharer(I) | PtsNominee(J)
 */
function loadGoodNews(sheet) {
  const data = sheet.getDataRange().getValues();
  const approved = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;
    const status = String(row[7]).trim().toLowerCase();
    if (status !== 'approved') continue;
    approved.push({
      nominatorName: String(row[1]).trim(),
      nominatorDept: String(row[2]).trim(),
      nomineeName:   String(row[3]).trim(),
      nomineeDept:   String(row[4]).trim(),
      message:       String(row[5]).trim(),
      weekNumber:    Number(row[6]),
      ptsSharer:     Number(row[8]) || 5,
      ptsNominee:    Number(row[9]) || 3,
    });
  }
  return approved;
}


// ============================================================
// WEEK KEY HELPERS
// All dates/times in Submissions tab are already in SGT.
// A "week" runs Monday 6 PM SGT → next Monday 6 PM SGT.
// Week key = "YYYY-MM-DD" of the Monday that opened this week.
// ============================================================

function getWeekKey(dateStr, timeStr) {
  const [year, month, day] = dateStr.split('-').map(Number);

  const match = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!match) return null;
  let hours = parseInt(match[1]);
  const period = match[3].toUpperCase();
  if (period === 'PM' && hours !== 12) hours += 12;
  if (period === 'AM' && hours === 12) hours = 0;

  const dt = new Date(year, month - 1, day, hours, 0, 0);
  const dow = dt.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat

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
// DEPT MULTIPLIER PRE-CALCULATION
// Returns a plain object: { deptName: Set<weekNumber>, ... }
// The Set contains 1-indexed week numbers where the 2× bonus fires.
// Logic: per dept, consecutive 100% participation weeks; when count
// hits DEPT_STREAK_WEEKS, record that week and reset the counter.
// ============================================================

function calculateDeptMultiplierWeeks(allSubmissions, users, currentWeekNum) {
  // Build dept → member names map
  const deptUsersMap = {};
  for (const user of users) {
    if (!deptUsersMap[user.department]) deptUsersMap[user.department] = [];
    deptUsersMap[user.department].push(user.realName.toLowerCase());
  }

  const result = {};

  for (const [dept, memberNames] of Object.entries(deptUsersMap)) {
    result[dept] = new Set();
    let consecutiveFull = 0;

    for (let w = 1; w <= currentWeekNum; w++) {
      const wKey = getWeekMonday(w);
      const allSubmitted = memberNames.every(name =>
        allSubmissions.some(s => {
          if (s.name.toLowerCase() !== name) return false;
          return getWeekKey(s.date, s.time) === wKey;
        })
      );

      if (allSubmitted) {
        consecutiveFull++;
        if (consecutiveFull === CONFIG.DEPT_STREAK_WEEKS) {
          result[dept].add(w); // this is the trigger week — apply 2× here
          consecutiveFull = 0; // reset so it can fire again at week 8
        }
      } else {
        consecutiveFull = 0;
      }
    }
  }

  return result;
}


// ============================================================
// USER STATS CALCULATION
// ============================================================

/**
 * @param {string}   realName
 * @param {object[]} allSubmissions
 * @param {string}   currentWeekKey
 * @param {object[]} goodNewsEntries   - approved Good News rows from loadGoodNews()
 * @param {Set}      deptMultiplierWeeks - week numbers (1-indexed) where 2× fires for this user's dept
 */
function calculateUserStats(realName, allSubmissions, currentWeekKey, goodNewsEntries, deptMultiplierWeeks) {
  const nameLower = realName.toLowerCase();
  const userSubs = allSubmissions.filter(s => s.name.toLowerCase() === nameLower);

  // First submission per week only
  const weekMap = {};
  for (const sub of userSubs) {
    const wk = getWeekKey(sub.date, sub.time);
    if (wk && !weekMap[wk]) weekMap[wk] = sub;
  }

  const currentWeekNum = Math.max(1, Math.min(CONFIG.TOTAL_WEEKS, getWeekNumber(currentWeekKey)));

  // Find the first week the user ever submitted — misses before this don't count
  let firstSubmissionWeek = null;
  for (const wKey of Object.keys(weekMap)) {
    const wNum = getWeekNumber(wKey);
    if (firstSubmissionWeek === null || wNum < firstSubmissionWeek) {
      firstSubmissionWeek = wNum;
    }
  }

  // Walk week-by-week, accumulating pts
  let totalPoints = 0;
  let streakSoFar = 0;       // running streak at time of each submission
  let consecutiveMisses = 0; // tracks dying/dead state

  for (let w = 1; w <= currentWeekNum; w++) {
    const wKey = getWeekMonday(w);
    const submitted = !!weekMap[wKey];

    if (submitted) {
      streakSoFar++;
      consecutiveMisses = 0;
      // Bonus = streakSoFar - 1: week 1 = +0, week 2 = +1, week 5 = +4
      const streakBonus = streakSoFar - 1;
      let weekPts = CONFIG.PTS_BASE + streakBonus;
      if (deptMultiplierWeeks.has(w)) {
        weekPts *= CONFIG.DEPT_STREAK_MULTIPLIER;
      }
      totalPoints += weekPts;
    } else if (firstSubmissionWeek !== null && w >= firstSubmissionWeek) {
      // Only count as a miss once the user has submitted at least once
      streakSoFar = 0;
      consecutiveMisses++;
    }
  }

  // Current streak — recalculate going backwards from current week
  let currentStreak = 0;
  for (let w = currentWeekNum; w >= 1; w--) {
    if (weekMap[getWeekMonday(w)]) currentStreak++;
    else break;
  }

  // Add approved Good News pts
  for (const entry of goodNewsEntries) {
    if (entry.nominatorName.toLowerCase() === nameLower) totalPoints += entry.ptsSharer;
    if (entry.nomineeName.toLowerCase() === nameLower)   totalPoints += entry.ptsNominee;
  }

  const { stage, progressPct } = stageFromPts(totalPoints);
  const submittedThisWeek = !!weekMap[currentWeekKey];

  return { stage, progressPct, streak: currentStreak, submittedThisWeek, totalPoints, consecutiveMisses };
}


// ============================================================
// DEPARTMENT STATS CALCULATION
// Dept score = average of all members' individual pts.
// ============================================================

function calculateDeptStats(allSubmissions, users, currentWeekKey, userStatsMap) {
  const deptUsersMap = {};
  for (const user of users) {
    if (!deptUsersMap[user.department]) deptUsersMap[user.department] = [];
    deptUsersMap[user.department].push(user.realName);
  }

  const currentWeekNum = Math.max(1, Math.min(CONFIG.TOTAL_WEEKS, getWeekNumber(currentWeekKey)));
  const deptStats = {};

  for (const [dept, deptUsers] of Object.entries(deptUsersMap)) {
    const memberCount = deptUsers.length;
    let totalPts = 0;
    let totalSubmissions = 0;

    for (const userName of deptUsers) {
      const uStats = userStatsMap[userName];
      if (uStats) {
        totalPts += uStats.totalPoints;
        // Count raw weeks submitted (for reference)
        const nameLower = userName.toLowerCase();
        const weeksSeen = new Set();
        for (const sub of allSubmissions) {
          if (sub.name.toLowerCase() !== nameLower) continue;
          const wk = getWeekKey(sub.date, sub.time);
          if (wk) weeksSeen.add(wk);
        }
        totalSubmissions += weeksSeen.size;
      }
    }

    const avgPoints = memberCount > 0 ? Math.round((totalPts / memberCount) * 10) / 10 : 0;
    const { stage, progressPct } = stageFromPts(avgPoints);

    // Dept streak — consecutive 100% submission weeks backwards from current week
    let deptStreak = 0;
    const memberNamesLower = deptUsers.map(n => n.toLowerCase());
    for (let w = currentWeekNum; w >= 1; w--) {
      const wKey = getWeekMonday(w);
      const allSubmitted = memberNamesLower.every(name =>
        allSubmissions.some(s => s.name.toLowerCase() === name && getWeekKey(s.date, s.time) === wKey)
      );
      if (allSubmitted) deptStreak++;
      else break;
    }

    deptStats[dept] = {
      gardenStage: stage,
      progressPct,
      totalSubmissions,
      avgPoints,
      deptStreak,
    };
  }

  return deptStats;
}


// ============================================================
// STAGE HELPER — pts-based
// ============================================================

function stageFromPts(pts) {
  const thresholds = CONFIG.STAGE_THRESHOLDS; // [0, 21, 51, 86, 116]
  const stages = CONFIG.STAGES;
  let idx = 0;
  for (let i = 0; i < stages.length; i++) {
    if (pts >= thresholds[i]) idx = i;
  }
  const stageMin = thresholds[idx];
  const stageMax = thresholds[idx + 1] !== undefined ? thresholds[idx + 1] : stageMin + 40;
  const progressPct = Math.min(100, Math.round(((pts - stageMin) / (stageMax - stageMin)) * 100));
  return { stage: stages[idx], progressPct };
}


// ============================================================
// WRITING TO SHEETS
// ============================================================

/**
 * Stats tab columns (A–H):
 * Name | Plant Stage | Progress % | Streak | Submitted This Week | Total Points | Consecutive Misses | Rank
 */
function writeStatsTab(sheet, users, userStats) {
  const header = [
    'Name', 'Plant Stage', 'Progress %', 'Streak',
    'Submitted This Week', 'Total Points', 'Consecutive Misses', 'Rank',
  ];

  // Assign ranks: sort by totalPoints descending
  const usersWithStats = users
    .map(u => ({ name: u.realName, stats: userStats[u.realName] }))
    .filter(x => !!x.stats);
  usersWithStats.sort((a, b) => b.stats.totalPoints - a.stats.totalPoints);
  const rankMap = {};
  usersWithStats.forEach((item, idx) => { rankMap[item.name] = idx + 1; });

  const rows = [header];
  for (const user of users) {
    const s = userStats[user.realName];
    if (!s) continue;
    rows.push([
      user.realName,
      s.stage,
      s.progressPct,
      s.streak,
      s.submittedThisWeek,
      s.totalPoints,
      s.consecutiveMisses,
      rankMap[user.realName] ?? '',
    ]);
  }

  sheet.clearContents();
  sheet.getRange(1, 1, rows.length, header.length).setValues(rows);
}

/**
 * DeptStats tab columns (A–G):
 * Department | Garden Stage | Progress % | Total Submissions | Target Submissions | Avg Points | Dept Streak
 */
function writeDeptStatsTab(sheet, deptStats, deptTargets) {
  const header = [
    'Department', 'Garden Stage', 'Progress %',
    'Total Submissions', 'Target Submissions', 'Avg Points', 'Dept Streak',
  ];
  const rows = [header];
  for (const [dept, s] of Object.entries(deptStats)) {
    rows.push([
      dept,
      s.gardenStage,
      s.progressPct,
      s.totalSubmissions,
      deptTargets[dept] ?? 0,
      s.avgPoints,
      s.deptStreak,
    ]);
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
// ============================================================

function onFormSubmit(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const usersSheet       = ss.getSheetByName(CONFIG.SHEETS.USERS);
  const submissionsSheet = ss.getSheetByName(CONFIG.SHEETS.SUBMISSIONS);

  const responses = e.values;
  const timestamp = new Date(responses[0]);
  const formName  = String(responses[1]).trim();
  const q1        = String(responses[2]).trim();
  const q2        = String(responses[3]).trim();

  const usersData = usersSheet.getDataRange().getValues();
  let department = 'Unknown';
  for (let i = 1; i < usersData.length; i++) {
    if (String(usersData[i][1]).trim().toLowerCase() === formName.toLowerCase()) {
      department = String(usersData[i][2]).trim();
      break;
    }
  }

  const sgtTimestamp = new Date(timestamp.getTime() + 8 * 60 * 60 * 1000);
  const date = Utilities.formatDate(sgtTimestamp, 'UTC', 'yyyy-MM-dd');
  const time = Utilities.formatDate(sgtTimestamp, 'UTC', 'h:mm a').toUpperCase();

  submissionsSheet.appendRow([formName, department, date, time, q1, q2]);
  updateAllStats();

  console.log('Form submission logged for: ' + formName);
}


// ============================================================
// WEB APP ENTRY POINT — called by the bot after each submission
// Deploy → New deployment → Web app → Execute as Me → Anyone
// ============================================================

function doGet(e) {
  updateAllStats();
  return ContentService.createTextOutput('ok');
}


// ============================================================
// TRIGGER SETUP — run setupTriggers() ONCE from the editor
// ============================================================

function setupTriggers() {
  deleteAllTriggers();

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
