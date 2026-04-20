import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const EXCLUDED_DEPARTMENTS = [];

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
const LAUNCH_DATE = '2026-04-27'; // Points count from Week 5 (Apr 27); Week 4 is soft launch

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
  const [{ data: allSubs }, { data: approvedNews }, { data: gnAwards }, { data: allUsers }] = await Promise.all([
    supabase.from('submissions').select('*').order('date', { ascending: true }).order('id', { ascending: true }),
    supabase.from('good_news').select('id, nominator_name, nominee_name, pts_sharer, pts_nominee').eq('status', 'Approved'),
    supabase.from('good_news_awards').select('good_news_id, recipient_name, pts'),
    supabase.from('users').select('real_name, department, secondary_department, goal, nickname'),
  ]);

  const subs     = allSubs      ?? [];
  const news     = approvedNews ?? [];
  const awards   = gnAwards     ?? [];
  const users    = allUsers     ?? [];

  const weekNow    = currentWeekNumber();
  const launchWeek = dateToWeekNumber(LAUNCH_DATE);

  // Build dept → member list (supports dual-dept membership)
  const deptMembers = {}; // dept → Set of real_name
  for (const u of users) {
    const depts = [u.department, u.secondary_department].filter(Boolean);
    for (const dept of depts) {
      if (!deptMembers[dept]) deptMembers[dept] = new Set();
      deptMembers[dept].add(u.real_name.toLowerCase());
    }
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
  // Dual-dept members count toward both departments.
  const deptWeekRate = {};
  for (const u of users) {
    const name = u.real_name.toLowerCase().trim();
    const depts = [u.department, u.secondary_department].map(d => (d ?? '').trim()).filter(Boolean);
    for (const dept of depts) {
      if (!deptWeekRate[dept]) deptWeekRate[dept] = {};
      for (let wk = launchWeek; wk <= weekNow; wk++) {
        if (!deptWeekRate[dept][wk]) deptWeekRate[dept][wk] = { submitted: 0, total: 0 };
        deptWeekRate[dept][wk].total++;
        if (userWeekMap[name]?.[wk]?.submitted) deptWeekRate[dept][wk].submitted++;
      }
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

  // Good news pts: nominator always gets pts_sharer.
  // Recipients come from good_news_awards (new); falls back to legacy nominee_name
  // for approved rows that pre-date the awards table.
  const goodNewsBonus  = {}; // lc_name → extra pts
  const gnWithAwards   = new Set(awards.map(a => a.good_news_id));
  for (const gn of news) {
    const nom = (gn.nominator_name ?? '').toLowerCase().trim();
    goodNewsBonus[nom] = (goodNewsBonus[nom] ?? 0) + (gn.pts_sharer ?? 5);
    // Legacy fallback: row approved before awards table existed
    if (!gnWithAwards.has(gn.id) && gn.nominee_name) {
      const nomi = gn.nominee_name.toLowerCase().trim();
      goodNewsBonus[nomi] = (goodNewsBonus[nomi] ?? 0) + (gn.pts_nominee ?? 3);
    }
  }
  for (const award of awards) {
    const recipient = (award.recipient_name ?? '').toLowerCase().trim();
    goodNewsBonus[recipient] = (goodNewsBonus[recipient] ?? 0) + (award.pts ?? 3);
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
      secondaryDepartment: (u.secondary_department ?? '').trim() || null,
      goal: (u.goal ?? '').trim() || null,
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

  const result = { statsMap, deptStatsMap, sorted, userWeekMap, deptWeekRate, weekNow, launchWeek };
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
  return { realName: row.real_name, department: row.department, secondaryDepartment: row.secondary_department ?? null, chatId: row.chat_id };
}

export async function getUserByUsername(username) {
  if (!username) return null;
  const rows = await getUsersRows();
  const needle = username.toLowerCase().trim();
  const row = rows.find(r => String(r.username ?? '').toLowerCase().trim() === needle);
  if (!row) return null;
  return { realName: row.real_name, department: row.department, secondaryDepartment: row.secondary_department ?? null, chatId: row.chat_id ?? null };
}

export async function getUserByRealName(realName) {
  if (!realName) return null;
  const rows = await getUsersRows();
  const needle = realName.toLowerCase().trim();
  const row = rows.find(r => String(r.real_name ?? '').toLowerCase().trim() === needle);
  if (!row) return null;
  return { realName: row.real_name, department: row.department, secondaryDepartment: row.secondary_department ?? null, chatId: row.chat_id ?? null };
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

// Returns all pending Good News nominations for the dashboard approval flow.
export async function getPendingGoodNews() {
  const { data, error } = await supabase
    .from('good_news')
    .select('id, timestamp, nominator_name, nominator_dept, nominee_name, nominee_dept, message, week_number, pts_sharer')
    .eq('status', 'Pending')
    .order('timestamp', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

// Approve a Good News nomination and record who gets pts.
// awards: [{ recipientName, recipientDept, pts }]  (1 or more)
// The nominator's pts_sharer is fixed on the good_news row and applied in buildStatsCache.
export async function approveGoodNews(gnId, awards = []) {
  if (!gnId || !awards.length) throw new Error('gnId and at least one award required');

  const awardRows = awards.map(a => ({
    good_news_id:   gnId,
    recipient_name: a.recipientName,
    recipient_dept: a.recipientDept ?? null,
    pts:            a.pts ?? 3,
  }));

  const [updateResult, insertResult] = await Promise.all([
    supabase.from('good_news').update({ status: 'Approved' }).eq('id', gnId),
    supabase.from('good_news_awards').insert(awardRows),
  ]);

  if (updateResult.error) throw updateResult.error;
  if (insertResult.error) throw insertResult.error;

  cacheInvalidate('stats');
}

export async function rejectGoodNews(gnId) {
  const { error } = await supabase.from('good_news').update({ status: 'Rejected' }).eq('id', gnId);
  if (error) throw error;
  cacheInvalidate('stats');
}

// Returns approved + rejected nominations (for the "already reviewed" section).
export async function getReviewedGoodNews() {
  const [{ data: rows, error: e1 }, { data: awards, error: e2 }] = await Promise.all([
    supabase
      .from('good_news')
      .select('id, timestamp, nominator_name, nominator_dept, nominee_name, nominee_dept, message, week_number, pts_sharer, status')
      .in('status', ['Approved', 'Rejected'])
      .order('timestamp', { ascending: false }),
    supabase.from('good_news_awards').select('good_news_id, recipient_name, recipient_dept, pts'),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;

  const awardsByGnId = {};
  for (const a of (awards ?? [])) {
    if (!awardsByGnId[a.good_news_id]) awardsByGnId[a.good_news_id] = [];
    awardsByGnId[a.good_news_id].push(a);
  }
  return (rows ?? []).map(r => ({ ...r, awards: awardsByGnId[r.id] ?? [] }));
}

// Re-approve: delete old award rows and insert new ones (updates who gets pts).
export async function reapproveGoodNews(gnId, awards = []) {
  if (!gnId || !awards.length) throw new Error('gnId and at least one award required');
  const awardRows = awards.map(a => ({
    good_news_id:   gnId,
    recipient_name: a.recipientName,
    recipient_dept: a.recipientDept ?? null,
    pts:            a.pts ?? 3,
  }));
  const [delResult, insResult, updResult] = await Promise.all([
    supabase.from('good_news_awards').delete().eq('good_news_id', gnId),
    supabase.from('good_news_awards').insert(awardRows),
    supabase.from('good_news').update({ status: 'Approved' }).eq('id', gnId),
  ]);
  if (delResult.error) throw delResult.error;
  if (insResult.error) throw insResult.error;
  if (updResult.error) throw updResult.error;
  cacheInvalidate('stats');
}

// Un-reject: flip a rejected nomination back to Pending so it can be re-reviewed.
export async function unRejectGoodNews(gnId) {
  const { error } = await supabase.from('good_news').update({ status: 'Pending' }).eq('id', gnId);
  if (error) throw error;
}

// Returns all data the leadership dashboard needs in one call.
export async function getFullDashboardStats() {
  const { sorted, deptStatsMap, userWeekMap, deptWeekRate, weekNow, launchWeek } = await buildStatsCache();

  const totalUsers         = sorted.length;
  const submittedThisWeek  = sorted.filter(u => u.submittedThisWeek).length;
  const totalPoints        = sorted.reduce((s, u) => s + u.totalPoints, 0);
  const goalsSet           = sorted.filter(u => u.goal).length;

  const users = sorted.map(u => ({
    realName:            u.realName,
    department:          u.department,
    secondaryDepartment: u.secondaryDepartment,
    goal:                u.goal,
    plantStage:          u.plantStage,
    progressPct:         u.progressPct,
    streak:              u.streak,
    submittedThisWeek:   u.submittedThisWeek,
    totalPoints:         u.totalPoints,
    consecutiveMisses:   u.consecutiveMisses,
    rank:                u.rank,
    weekHistory:         userWeekMap[u.realName.toLowerCase().trim()] ?? {},
  }));

  const depts = Object.values(deptStatsMap).map(d => {
    const tw = deptWeekRate[d.department]?.[weekNow] ?? { submitted: 0, total: d.count };
    return {
      ...d,
      thisWeekSubmitted: tw.submitted,
      thisWeekTotal:     tw.total,
      thisWeekRate:      tw.total ? Math.round(tw.submitted / tw.total * 100) : 0,
    };
  }).sort((a, b) => b.thisWeekRate - a.thisWeekRate || b.avgPoints - a.avgPoints);

  return { weekNow, launchWeek, totalWeeks: 13, totalUsers, submittedThisWeek, totalPoints, goalsSet, users, depts };
}

export async function getRawStatsCache() {
  return buildStatsCache();
}

// Returns submissions for a given Q2 week number (excused absences excluded).
export async function getReflectionsForWeek(weekNum) {
  // Q2 starts 2026-03-30 00:00 SGT = 2026-03-29 16:00 UTC
  const Q2_EPOCH_UTC = Date.UTC(2026, 2, 29, 16, 0, 0);
  const DAY_MS       = 86400000;
  const startUTC     = Q2_EPOCH_UTC + (weekNum - 1) * 7 * DAY_MS;
  const endUTC       = startUTC + 7 * DAY_MS - 1;
  const toSGTDate    = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('submissions')
    .select('real_name, department, date, time, q1, q2, q3')
    .gte('date', toSGTDate(startUTC))
    .lte('date', toSGTDate(endUTC))
    .neq('q1', '[Excused absence]')
    .order('department')
    .order('real_name');
  if (error) throw error;
  return data ?? [];
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
