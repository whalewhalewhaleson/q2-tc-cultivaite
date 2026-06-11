// Unit tests for per-person custom deadlines (deadlines.js + offset-aware
// week placement in db.js). No live DB — only pure functions are exercised.
// Run: node -r dotenv/config test-deadlines.js
//
// Anchor: week 11 closes / week 12 opens at Mon 15 Jun 2026 16:00 SGT (the
// default boundary), chosen to sit clear of the Jun-1 holiday hack.
import { dateTimeToWeekNumber } from './db.js';
import { groupForUser, offsetMinutesForUser } from './deadlines.js';

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = got === want;
  console.log(`${ok ? '✅' : '❌'} ${label} → ${JSON.stringify(got)}${ok ? '' : ` (expected ${JSON.stringify(want)})`}`);
  ok ? pass++ : fail++;
}

console.log('\n── Group membership resolution ──');
eq('Goh Xin Yi → monday_off',                groupForUser('Goh Xin Yi', 'RS & GL', null), 'monday_off');
eq('Teoh Wee Shing ("Wee Shing") → monday_off', groupForUser('Teoh Wee Shing', 'Brands', null), 'monday_off');
eq('Regine Tan (LT) → monday_off',           groupForUser('Regine Tan', 'LT + Core Team', null), 'monday_off');
eq('Toh Lu Suan Regine (Accounts) → default (different person!)', groupForUser('Toh Lu Suan Regine', 'Accounts', null), 'default');
eq('Emsphere dept member → thailand',        groupForUser('Karntima Tachakkaew (Nam)', 'Emsphere', null), 'thailand');
eq('Retail Thailand (RTH) dept member → thailand', groupForUser('Atisthan Pitichotwattana (Garfiw)', 'Retail Thailand (RTH)', null), 'thailand');
eq('RTH as SECONDARY dept → thailand',       groupForUser('Pawarisa Attrang (Pear)', 'Emsphere', 'Retail Thailand (RTH)'), 'thailand');
eq('Maprang (full stored name) → thailand',  groupForUser('Suphaphon Chuchan (Maprang)', 'Online', null), 'thailand');
eq('Mo Ka Chun → thailand',                  groupForUser('Mo Ka Chun', 'Marketing (Lead Gen/PR/Web)', null), 'thailand');
eq('Weerapan Donkitpai (X) → thailand',      groupForUser('Weerapan Donkitpai (X)', 'Ops/ Purchasing/ IT', null), 'thailand');
eq('Wilson Tan → default',                   groupForUser('Wilson Tan', 'Marketing (Social Media)', null), 'default');
eq('bare "Maprang" → default (proves typo would silently drop them)', groupForUser('Maprang', 'Online', null), 'default');

console.log('\n── Offset minutes ──');
eq('default offset',     offsetMinutesForUser('Wilson Tan', 'Marketing (Social Media)', null), 0);
eq('thailand offset',    offsetMinutesForUser('Mo Ka Chun', 'Marketing (Lead Gen/PR/Web)', null), 60);
eq('monday_off offset',  offsetMinutesForUser('Goh Xin Yi', 'RS & GL', null), 1590);

console.log('\n── Default deadline: boundary at Mon 15 Jun 4:00 PM SGT (wk 11 → 12) ──');
eq('Mon 15 Jun 3:00 PM  (before 4PM)', dateTimeToWeekNumber('2026-06-15', '3:00 PM', 0), 11);
eq('Mon 15 Jun 4:00 PM  (at boundary)', dateTimeToWeekNumber('2026-06-15', '4:00 PM', 0), 12);
eq('Mon 15 Jun 4:30 PM  (after 4PM → next week)', dateTimeToWeekNumber('2026-06-15', '4:30 PM', 0), 12);

console.log('\n── Thailand (+60): deadline Mon 5:00 PM SGT ──');
eq('Mon 15 Jun 4:30 PM  (before their 5PM → still wk 11)', dateTimeToWeekNumber('2026-06-15', '4:30 PM', 60), 11);
eq('Mon 15 Jun 5:00 PM  (at their boundary → wk 12)',      dateTimeToWeekNumber('2026-06-15', '5:00 PM', 60), 12);
eq('Mon 15 Jun 5:30 PM  (after their 5PM → wk 12)',        dateTimeToWeekNumber('2026-06-15', '5:30 PM', 60), 12);

console.log('\n── Monday-off (+1590): deadline Tue 6:30 PM SGT ──');
eq('Mon 15 Jun 4:30 PM  (their off-day, well early → wk 11)', dateTimeToWeekNumber('2026-06-15', '4:30 PM', 1590), 11);
eq('Tue 16 Jun 5:00 PM  (before their Tue 6:30PM → on-time wk 11)', dateTimeToWeekNumber('2026-06-16', '5:00 PM', 1590), 11);
eq('Tue 16 Jun 6:00 PM  (still before 6:30PM → wk 11)',      dateTimeToWeekNumber('2026-06-16', '6:00 PM', 1590), 11);
eq('Tue 16 Jun 6:30 PM  (at their boundary → wk 12)',        dateTimeToWeekNumber('2026-06-16', '6:30 PM', 1590), 12);
eq('Tue 16 Jun 7:00 PM  (after their deadline → wk 12 / missed wk11)', dateTimeToWeekNumber('2026-06-16', '7:00 PM', 1590), 12);
eq('Wed 17 Jun 10:00 AM (next week)',                        dateTimeToWeekNumber('2026-06-17', '10:00 AM', 1590), 12);

console.log(`\n${fail === 0 ? '🎉 ALL PASS' : '🔴 FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
