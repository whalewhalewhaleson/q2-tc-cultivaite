// Unit tests for the TEMP Jun-1-2026 public-holiday shift.
// Run: node test-holiday-shift.js   (no DB connection needed)
// Verifies (1) Week 9 deadline extension and (2) cron-day guard, and proves
// the change is scoped to ONLY the Jun 1–7 week. Delete with the temp code.
import { dateTimeToWeekNumber, holidayAdjust, holidayRun } from './db.js';

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = got === want;
  console.log(`${ok ? '✅' : '❌'} ${label} → ${got}${ok ? '' : ` (expected ${want})`}`);
  ok ? pass++ : fail++;
}

console.log('\n── Deadline extension: submission → week placement ──');
// Week 9 normally closes Mon 1 Jun 16:00 SGT; extended to Tue 2 Jun 16:00.
eq('Sun 31 May 2:00 PM  (this week, untouched)', dateTimeToWeekNumber('2026-05-31', '2:00 PM'), 9);
eq('Mon 1 Jun 1:00 PM   (before old deadline)',  dateTimeToWeekNumber('2026-06-01', '1:00 PM'), 9);
eq('Mon 1 Jun 6:00 PM   (in extension window)',  dateTimeToWeekNumber('2026-06-01', '6:00 PM'), 9);
eq('Tue 2 Jun 2:00 PM   (extended deadline)',    dateTimeToWeekNumber('2026-06-02', '2:00 PM'), 9);
eq('Tue 2 Jun 4:00 PM   (exactly new boundary)', dateTimeToWeekNumber('2026-06-02', '4:00 PM'), 10);
eq('Tue 2 Jun 5:00 PM   (past extended)',        dateTimeToWeekNumber('2026-06-02', '5:00 PM'), 10);
eq('Wed 3 Jun 2:00 PM   (next week)',            dateTimeToWeekNumber('2026-06-03', '2:00 PM'), 10);
eq('Mon 8 Jun 2:00 PM   (week 10 unaffected)',   dateTimeToWeekNumber('2026-06-08', '2:00 PM'), 10);

console.log('\n── holidayAdjust boundary inclusivity (ms-level) ──');
const OLD = Date.parse('2026-06-01T16:00:00+08:00');
const NEW = Date.parse('2026-06-02T16:00:00+08:00');
eq('at OLD boundary (16:00 Mon) → clamps to 9', holidayAdjust(OLD, 10), 9);
eq('1ms before OLD → stays 10',                 holidayAdjust(OLD - 1, 10), 10);
eq('1ms before NEW → clamps to 9',              holidayAdjust(NEW - 1, 10), 9);
eq('at NEW boundary (16:00 Tue) → stays 10',    holidayAdjust(NEW, 10), 10);
eq('only touches week 10 (week 9 passthrough)', holidayAdjust(OLD, 9), 9);

console.log('\n── Cron-day guard: holidayRun(normalDow, now) ──');
const sgt = (iso) => new Date(iso + '+08:00'); // build an instant at SGT wall-clock
// HOLIDAY WEEK (Mon 1 Jun → Sun 7 Jun): Mon jobs → Tue, Tue jobs → Wed
eq('PH wk, Mon job, on MON → skip',  holidayRun(1, sgt('2026-06-01T10:00:00')), false);
eq('PH wk, Mon job, on TUE → run',   holidayRun(1, sgt('2026-06-02T10:00:00')), true);
eq('PH wk, Mon job, on WED → skip',  holidayRun(1, sgt('2026-06-03T10:00:00')), false);
eq('PH wk, Tue job, on TUE → skip',  holidayRun(2, sgt('2026-06-02T10:00:00')), false);
eq('PH wk, Tue job, on WED → run',   holidayRun(2, sgt('2026-06-03T10:00:00')), true);
eq('PH wk, Fri recap, on FRI → run', holidayRun(5, sgt('2026-06-05T15:30:00')), true);
// NORMAL WEEK (e.g. week of Mon 8 Jun): everything fires on its normal day
eq('Normal wk, Mon job, on MON → run',  holidayRun(1, sgt('2026-06-08T10:00:00')), true);
eq('Normal wk, Mon job, on TUE → skip', holidayRun(1, sgt('2026-06-09T10:00:00')), false);
eq('Normal wk, Tue job, on TUE → run',  holidayRun(2, sgt('2026-06-09T10:00:00')), true);
eq('Normal wk, Tue job, on WED → skip', holidayRun(2, sgt('2026-06-10T10:00:00')), false);
// PRIOR WEEK (this week, Mon 25 May): also unaffected
eq('Prior wk, Mon job, on MON → run',   holidayRun(1, sgt('2026-05-25T10:00:00')), true);
eq('Prior wk, Mon job, on TUE → skip',  holidayRun(1, sgt('2026-05-26T10:00:00')), false);

console.log(`\n${fail === 0 ? '🎉 ALL PASS' : '🔴 FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
