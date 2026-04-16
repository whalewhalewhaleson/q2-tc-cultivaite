import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

const EXCLUDED_DEPARTMENTS = ['Leadership Team'];

// ---------------------------------------------------------------------------
// SGT timestamp helper
// ---------------------------------------------------------------------------

function getSGTDatetime() {
  const now = new Date();
  const sgt = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const date = sgt.toISOString().slice(0, 10);
  let hours = sgt.getUTCHours();
  const minutes = String(sgt.getUTCMinutes()).padStart(2, '0');
  const period = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return { date, time: `${hours}:${minutes} ${period}` };
}

// ---------------------------------------------------------------------------
// Week number (mirrors bot.js getWeekNumber, but applied to a date string)
// ---------------------------------------------------------------------------

const Q2_START    = new Date('2026-03-30T00:00:00+08:00');
const LAUNCH_DATE = '2026-04-17'; // Week bot went live — misses only counted from here

function dateToWeekNumber(dateStr) {
  // dateStr is YYYY-MM-DD (SGT)
  const d = new Date(dateStr + 'T00:00:00+08:00');
  const daysSince = Math.floor((d.getTime() - Q2_START.getTime()) / 86400000);
  return Math.min(Math.max(Math.ceil((daysSince + 1) / 7), 1), 13);
}

function currentWeekNumber() {
  const daysSince = Math.floor((Date.now() - Q2_START.getTime()) / 86400000);
  return Math.min(Math.max(Math.ceil((daysSince + 1) / 7), 1), 13);
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

const _cache = new Map();

const TTL = {
  USERS: 5 * 60 * 1000,   // 5 min
  STATS: 30 * 1000,        // 30 sec
};

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _cache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key, data, ttl) {
  _cache.set(key, { data, expiresAt: Date.now() + ttl });
}

function cacheInvalidate(...keys) {
  for (const k of keys) _cache.delete(k);
}

export function invalidateStatsCache() {
  cacheInvalidate('stats');
}

// ---------------------------------------------------------------------------
// Stats engine — replaces Apps Script
// Calculates all user stats live from submissions + good_news tables.
// Result cached for 30 seconds; busted immediately after each reflection.
// ---------------------------------------------------------------------------

const STAGE_THRESHOLDS = [0, 21, 51, 86, 116];
const HEALTHY_STAGES   = ['🌱', '🌿', '🌳', '🌼', '🍎'];

function pointsToStage(pts) {
  let stage = HEALTHY_STAGES[0];
  for (let i = 0; i < STAGE_THRESHOLDS.length; i++) {
    if (pts >= STAGE_THRESHOLDS[i]) stage = HEALTHY_STAGES[i];
  }
  return stage;
}

function stageProgressPct(pts) {
  for (let i = STAGE_THRESHOLDS.length - 1; i >= 0; i--) {
    if (pts >= STAGE_THRESHOLDS[i]) {
      const next = STAGE_THRESHOLDS[i + 1];
      if (!next) return 100;
      return Math.min(100, Math.round(((pts - STAGE_THRESHOLDS[i]) / (next - STAGE_THRESHOLDS[i])) * 100));
    }
  }
  return 0;
}

async function buildStatsCache() {
  const cached = cacheGet('stats');
  if (cached) return cached;

  // Fetch all data in parallel
  const [{ data: allSubs }, { data: approvedNews }, { data: allUsers }] = await Promise.all([
    supabase.from('submissions').select('*').order('date', { ascending: true }).order('id', { ascending: true }),
    supabase.from('good_news').select('*').eq('status', 'Approved'),
    supabase.from('users').select('real_name, department'),
  ]);

  const subs     = allSubs     ?? [];
  const news     = approvedNews ?? [];
  const users    = allUsers    ?? [];

  const weekNow    = currentWeekNumber();
  const launchWeek = dateToWeekNumber(LAUNCH_DATE);

  // Build dept → member list
  const deptMembers = {}; // dept → Set of real_name
  for (const u of users) {
    const dept = u.department ?? '';
    if (!deptMembers[dept]) deptMembers[dept] = new Set();
    deptMembers[dept].add(u.real_name.toLowerCase());
  }

  // Per-user submission map: name → weekNum → true/false (excused counts as true)
  const userWeekMap = {}; // lc_name → Map<weekNum, { submitted, excused }>
  for (const sub of subs) {
    const name = String(sub.real_name ?? '').toLowerCase().trim();
    const wk   = dateToWeekNumber(sub.date);
    if (!userWeekMap[name]) userWeekMap[name] = {};
    const excused = sub.q1 === '[Excused absence]';
    userWeekMap[name][wk] = { submitted: true, excused };
  }

  // Dept week submission rate: dept → weekNum → { submitted, total }
  const deptWeekRate = {};
  for (const u of users) {
    const dept = (u.department ?? '').trim();
    const name = u.real_name.toLowerCase().trim();
    if (EXCLUDED_DEPARTMENTS.includes(dept)) continue;
    if (!deptWeekRate[dept]) deptWeekRate[dept] = {};
    for (let wk = launchWeek; wk <= weekNow; wk++) {
      if (!deptWeekRate[dept][wk]) deptWeekRate[dept][wk] = { submitted: 0, total: 0 };
      deptWeekRate[dept][wk].total++;
      if (userWeekMap[name]?.[wk]?.submitted) deptWeekRate[dept][wk].submitted++;
    }
  }

  // Dept consecutive 100% weeks ending at each week (for bonus)
  // deptConsec[dept][wk] = consecutive 100% weeks up to and including wk
  const deptConsec = {};
  for (const dept of Object.keys(deptWeekRate)) {
    deptConsec[dept] = {};
    let run = 0;
    for (let wk = launchWeek; wk <= weekNow; wk++) {
      const rate = deptWeekRate[dept][wk];
      if (rate && rate.total > 0 && rate.submitted === rate.total) {
        run++;
      } else {
        run = 0;
      }
      deptConsec[dept][wk] = run;
    }
  }

  // Good news pts: nominator +pts_sharer, nominee +pts_nominee
  const goodNewsBonus = {}; // lc_name → extra pts
  for (const gn of news) {
    const nom  = (gn.nominator_name ?? '').toLowerCase().trim();
    const nomi = (gn.nominee_name   ?? '').toLowerCase().trim();
    goodNewsBonus[nom]  = (goodNewsBonus[nom]  ?? 0) + (gn.pts_sharer  ?? 5);
    goodNewsBonus[nomi] = (goodNewsBonus[nomi] ?? 0) + (gn.pts_nominee ?? 3);
  }

  // Calculate per-user stats
  const statsMap = {}; // lc_name → stats object
  for (const u of users) {
    const name = u.real_name.toLowerCase().trim();
    const dept = (u.department ?? '').trim();
    const weekMap = userWeekMap[name] ?? {};

    let totalPoints        = 0;
    let streak             = 0;
    let consecutiveMisses  = 0;
    let currentStreak      = 0;

    for (let wk = launchWeek; wk <= weekNow; wk++) {
      const entry = weekMap[wk];
      if (entry?.submitted) {
        consecutiveMisses = 0;
        if (!entry.excused) {
          // Base pts
          currentStreak++;
          let weekPts = 10 + (currentStreak - 1); // base 10 + streak bonus
          // Dept 2× bonus: 4+ consecutive 100% weeks
          if ((deptConsec[dept]?.[wk] ?? 0) >= 4) weekPts *= 2;
          totalPoints += weekPts;
        }
        // Excused: streak preserved, no pts earned
        streak = currentStreak;
      } else if (wk < weekNow) {
        // Missed past week
        currentStreak = 0;
        streak        = 0;
        consecutiveMisses++;
      }
      // Current week not yet submitted: don't penalise yet
    }

    totalPoints += goodNewsBonus[name] ?? 0;

    const submittedThisWeek = weekMap[weekNow]?.submitted ?? false;
    const plantStage        = pointsToStage(totalPoints);
    const progressPct       = stageProgressPct(totalPoints);

    statsMap[name] = {
      realName: u.real_name,
      department: dept,
      plantStage,
      progressPct,
      streak,
      submittedThisWeek,
      totalPoints,
      consecutiveMisses,
      rank: 0, // filled in below
    };
  }

  // Assign ranks (dense, by totalPoints desc)
  const sorted = Object.values(statsMap)
    .filter(s => !EXCLUDED_DEPARTMENTS.includes(s.department))
    .sort((a, b) => b.totalPoints - a.totalPoints);

  let denseRank = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0 || sorted[i].totalPoints !== sorted[i - 1].totalPoints) denseRank++;
    statsMap[sorted[i].realName.toLowerCase().trim()].rank = denseRank;
  }

  // Dept-level stats
  const deptStatsMap = {};
  for (const dept of Object.keys(deptWeekRate)) {
    const members = [...(deptMembers[dept] ?? [])].filter(n => !EXCLUDED_DEPARTMENTS.includes(dept));
    if (!members.length) continue;

    const memberStats = members.map(n => statsMap[n]).filter(Boolean);
    const avgPoints   = memberStats.length
      ? Math.round(memberStats.reduce((s, m) => s + m.totalPoints, 0) / memberStats.length)
      : 0;

    // Total submissions this Q2 (non-excused only)
    const totalSubs = members.reduce((s, n) => {
      return s + Object.values(userWeekMap[n] ?? {}).filter(e => e.submitted && !e.excused).length;
    }, 0);
    const targetSubs = members.length * (weekNow - launchWeek + 1);

    const gardenStage = pointsToStage(avgPoints);
    const progressPct  = stageProgressPct(avgPoints);

    // Dept streak = current consecutive 100% weeks
    const deptStreak = deptConsec[dept]?.[weekNow] ?? 0;

    const stages = memberStats.map(m => m.plantStage);

    deptStatsMap[dept.toLowerCase()] = {
      department: dept,
      gardenStage,
      progressPct,
      totalSubmissions:  totalSubs,
      targetSubmissions: targetSubs,
      avgPoints,
      deptStreak,
      stages,
      count: memberStats.length,
    };
  }

  const result = { statsMap, deptStatsMap, sorted };
  cacheSet('stats', result, TTL.STATS);
  return result;
}

// ---------------------------------------------------------------------------
// Users — cached reads, direct writes
// ---------------------------------------------------------------------------

async function getUsersRows() {
  const cached = cacheGet('users');
  if (cached) return cached;
  const { data } = await supabase.from('users').select('*');
  const rows = data ?? [];
  cacheSet('users', rows, TTL.USERS);
  return rows;
}

export async function getUserByChatId(chatId) {
  if (!chatId) return null;
  const rows = await getUsersRows();
  const needle = String(chatId).trim();
  const row = rows.find(r => r.chat_id && String(r.chat_id).trim() === needle);
  if (!row) return null;
  return { realName: row.real_name, department: row.department, chatId: row.chat_id };
}

export async function getUserByUsername(username) {
  if (!username) return null;
  const rows = await getUsersRows();
  const needle = username.toLowerCase().trim();
  const row = rows.find(r => String(r.username ?? '').toLowerCase().trim() === needle);
  if (!row) return null;
  return { realName: row.real_name, department: row.department, chatId: row.chat_id ?? null };
}

export async function getUserByRealName(realName) {
  if (!realName) return null;
  const rows = await getUsersRows();
  const needle = realName.toLowerCase().trim();
  const row = rows.find(r => String(r.real_name ?? '').toLowerCase().trim() === needle);
  if (!row) return null;
  return { realName: row.real_name, department: row.department, chatId: row.chat_id ?? null };
}

export async function getNickname(realName) {
  if (!realName) return null;
  const rows = await getUsersRows();
  const needle = realName.toLowerCase().trim();
  const row = rows.find(r => String(r.real_name ?? '').toLowerCase().trim() === needle);
  return row?.nickname ? String(row.nickname).trim() : null;
}

export async function getGoal(realName) {
  if (!realName) return null;
  const rows = await getUsersRows();
  const needle = realName.toLowerCase().trim();
  const row = rows.find(r => String(r.real_name ?? '').toLowerCase().trim() === needle);
  return row?.goal ? String(row.goal).trim() : null;
}

export async function getAllUsersWithChatId() {
  const rows = await getUsersRows();
  return rows
    .filter(r => r.chat_id && !EXCLUDED_DEPARTMENTS.includes(r.department ?? ''))
    .map(r => ({
      realName: r.real_name,
      chatId:   String(r.chat_id),
      nickname: r.nickname ?? null,
    }));
}

export async function setChatId(username, chatId) {
  if (!username || !chatId) return;
  const rows = await getUsersRows();
  const needle = username.toLowerCase().trim();
  const row = rows.find(r => String(r.username ?? '').toLowerCase().trim() === needle);
  if (!row || row.chat_id) return; // not found or already set
  await supabase.from('users').update({ chat_id: String(chatId) }).eq('real_name', row.real_name);
  cacheInvalidate('users');
}

export async function setNickname(realName, nickname) {
  if (!realName) return;
  await supabase.from('users').update({ nickname }).eq('real_name', realName);
  cacheInvalidate('users');
}

export async function setGoal(realName, goal) {
  if (!realName) return;
  await supabase.from('users').update({ goal }).eq('real_name', realName);
  cacheInvalidate('users');
}

// ---------------------------------------------------------------------------
// Stats — live calculation via cache
// ---------------------------------------------------------------------------

export async function getStatsForUser(realName) {
  if (!realName) return null;
  const { statsMap } = await buildStatsCache();
  return statsMap[realName.toLowerCase().trim()] ?? null;
}

export async function getAllUserStats() {
  const { sorted } = await buildStatsCache();
  return sorted.map(s => ({
    name:        s.realName,
    plantStage:  s.plantStage,
    totalPoints: s.totalPoints,
  }));
}

export async function getDeptStats(department) {
  if (!department) return null;
  const { deptStatsMap } = await buildStatsCache();
  return deptStatsMap[department.toLowerCase().trim()] ?? null;
}

export async function getAllDeptStats() {
  const { deptStatsMap } = await buildStatsCache();
  return Object.values(deptStatsMap)
    .filter(d => !EXCLUDED_DEPARTMENTS.includes(d.department));
}

export async function getMemberStagesForDept(department) {
  if (!department) return { count: 0, stages: [] };
  const { deptStatsMap } = await buildStatsCache();
  const dept = deptStatsMap[department.toLowerCase().trim()];
  if (!dept) return { count: 0, stages: [] };
  return { count: dept.count, stages: dept.stages };
}

// ---------------------------------------------------------------------------
// Submissions — never cached
// ---------------------------------------------------------------------------

export async function getSubmissionsForUser(realName, limit = 5) {
  if (!realName) return [];
  const { data } = await supabase
    .from('submissions')
    .select('*')
    .ilike('real_name', realName)
    .order('date', { ascending: true })
    .order('id', { ascending: true });

  const rows = (data ?? []).map(r => ({
    rowIndex: r.id,
    date:     r.date ?? '',
    time:     r.time ?? '',
    q1:       r.q1  ?? '',
    q2:       r.q2  ?? '',
    q3:       r.q3  ?? '',
  }));

  return rows.slice(-limit);
}

export async function updateSubmission(rowIndex, q1, q2) {
  await supabase.from('submissions').update({ q1, q2 }).eq('id', rowIndex);
}

export async function logSubmission(realName, department, q1, q2, q3 = '') {
  const { date, time } = getSGTDatetime();
  await supabase.from('submissions').insert({
    real_name: realName,
    department,
    date,
    time,
    q1,
    q2,
    q3,
  });
}

export async function logSkip(realName, department, weekNumber) {
  // Wednesday of week N (SGT) so the week-boundary logic places it correctly
  const Q2_MONDAY_UTC = Date.UTC(2026, 3, 6); // 2026-04-06 00:00 UTC
  const wednesdayUTC  = Q2_MONDAY_UTC + ((weekNumber - 1) * 7 + 2) * 86400000;
  const d    = new Date(wednesdayUTC);
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  await supabase.from('submissions').insert({
    real_name:  realName,
    department,
    date,
    time:       '12:00 PM',
    q1:         '[Excused absence]',
    q2:         '[Excused absence]',
    q3:         '',
  });
}

export async function logGoodNews(nominatorName, nominatorDept, nomineeName, nomineeDept, message, weekNum) {
  const { date, time } = getSGTDatetime();
  await supabase.from('good_news').insert({
    timestamp:      `${date} ${time}`,
    nominator_name: nominatorName,
    nominator_dept: nominatorDept,
    nominee_name:   nomineeName,
    nominee_dept:   nomineeDept,
    message,
    week_number:    weekNum,
    status:         'Pending',
    pts_sharer:     5,
    pts_nominee:    3,
  });
}
