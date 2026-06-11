// deadlines.js — Per-person custom submission deadlines for TC CultivAIte.
//
// THE WHOLE FEATURE IS ONE NUMBER PER PERSON: an offset in minutes added to the
// default Monday-4PM-SGT week boundary. Week attribution, on-time status,
// streaks, points and dept rates all derive from that single boundary in db.js,
// so shifting it per-user shifts everything downstream automatically — and it
// only ever EXTENDS a deadline, never shrinks one, so nobody is disadvantaged.
//
// Groups:
//   • default    — Mon 4:00 PM SGT  (offset 0)
//   • thailand   — Mon 5:00 PM SGT  (offset +60)   = 4 PM Thailand time
//   • monday_off — Tue 6:30 PM SGT  (offset +1590) for staff whose off-day is Mon
//
// Membership matches case-insensitively against the EXACT stored real_name /
// department (verified against the users table on 2026-06-11). Note the stored
// forms differ from how people are casually named — e.g. "Maprang" is stored as
// "Suphaphon Chuchan (Maprang)", "Wee Shing" as "Teoh Wee Shing", and the dept
// is "Emsphere" (no 'p'), not "Empsphere".

// Cron times below are UTC (SGT = UTC+8). Day-of-week: 1 = Mon, 2 = Tue.
export const GROUPS = {
  default: {
    offsetMin: 0,
    deadlineLabel: '4PM',
    nudges: {
      morning:  '0 2 * * 1',   // Mon 10:00 SGT
      warning:  '0 7 * * 1',   // Mon 15:00 SGT
      deadline: '0 8 * * 1',   // Mon 16:00 SGT
      preview:  '30 7 * * 1',  // Mon 15:30 SGT — admin heads-up + /cancelnudge
    },
  },
  thailand: {
    offsetMin: 60,
    deadlineLabel: '5PM',
    nudges: {
      morning:  '0 3 * * 1',   // Mon 11:00 SGT (= 10 AM Thai)
      warning:  '0 8 * * 1',   // Mon 16:00 SGT (= 3 PM Thai)
      deadline: '0 9 * * 1',   // Mon 17:00 SGT (= 4 PM Thai)
      preview:  '30 8 * * 1',  // Mon 16:30 SGT — admin heads-up + /cancelnudge
    },
  },
  monday_off: {
    offsetMin: 1590,
    deadlineLabel: 'Tue 6:30PM',
    nudges: {
      morning:  '0 2 * * 2',    // Tue 10:00 SGT
      warning:  '30 9 * * 2',   // Tue 17:30 SGT
      deadline: '30 10 * * 2',  // Tue 18:30 SGT
      preview:  '0 10 * * 2',   // Tue 18:00 SGT — admin heads-up + /cancelnudge
    },
  },
};

// Whole departments on Thai time (matched against primary OR secondary dept).
const THAILAND_DEPTS = new Set([
  'emsphere',
  'retail thailand (rth)',
]);

// Individuals on Thai time who sit in SG-named departments.
const THAILAND_NAMES = new Set([
  'suphaphon chuchan (maprang)',
  'mo ka chun',
  'siriwat seniwong na ayutthaya (karn)',
  'siriwarin chinnikorn (mulan)',
  'thawaree klinchoo (nine)',
  'weerapan donkitpai (x)',
  'thanabodee sugreedith (tony)',
  'thipchanoktep vijitprapapong (thip)',
]);

// Individuals whose off-day is Monday → deadline pushed to Tue 6:30 PM SGT.
const MONDAY_OFF_NAMES = new Set([
  'goh xin yi',
  'valerie iskandar',
  'christian honegger',
  'regine tan',          // the one in LT + Core Team, not "Toh Lu Suan Regine"
  'tan jian ming',
  'teoh wee shing',
]);

const norm = (s) => (s ?? '').toLowerCase().trim();

// Resolve a user to their deadline group. monday_off wins over thailand if a
// name somehow appears in both (shouldn't happen, but keeps it deterministic).
export function groupForUser(realName, department, secondaryDepartment) {
  const name = norm(realName);
  if (MONDAY_OFF_NAMES.has(name)) return 'monday_off';
  if (THAILAND_NAMES.has(name)) return 'thailand';
  if (THAILAND_DEPTS.has(norm(department)) || THAILAND_DEPTS.has(norm(secondaryDepartment))) return 'thailand';
  return 'default';
}

export function offsetMinutesForUser(realName, department, secondaryDepartment) {
  return GROUPS[groupForUser(realName, department, secondaryDepartment)].offsetMin;
}
