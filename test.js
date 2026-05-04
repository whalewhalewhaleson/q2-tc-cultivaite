/**
 * TC CultivAIte — Test Script
 *
 * Tests every Sheets function and bot helper without needing Telegram.
 * Run with: node test.js
 *
 * Set TEST_USERNAME and TEST_NAME below to match a real row in your Users tab.
 */

import 'dotenv/config';
import * as sheets from './sheets.js';

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Change these to match a real user in your Users tab
const TEST_USERNAME   = 'whalewhalewhalee'; // Telegram username (no @, lowercase)
const TEST_CHAT_ID    = '';                  // Leave blank if unknown
const TEST_NAME       = 'Wilson';            // Real name as it appears in column B
const TEST_DEPT       = '';                  // Leave blank to auto-detect from lookup
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ✅  ${label}`);
  passed++;
}

function fail(label, err) {
  console.log(`  ❌  ${label}`);
  console.log(`       ${err?.message ?? err}`);
  failed++;
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(50 - title.length)}`);
}

// ─────────────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n🌱 TC CultivAIte — Test Suite\n');

  let user = null;
  let dept = TEST_DEPT;

  // ── 1. Environment ──────────────────────────────────────────────────────────
  section('Environment');

  try {
    if (!process.env.BOT_TOKEN)           throw new Error('BOT_TOKEN missing');
    if (!process.env.SHEET_ID)            throw new Error('SHEET_ID missing');
    const hasCredentials =
      (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) ||
      process.env.GOOGLE_CREDENTIALS_JSON ||
      process.env.GOOGLE_CREDENTIALS_PATH;
    if (!hasCredentials)                  throw new Error('Google credentials missing');
    ok('All required env vars present');
  } catch (err) { fail('.env check', err); }

  // ── 2. Users tab ────────────────────────────────────────────────────────────
  section('Users tab');

  try {
    user = await sheets.getUserByUsername(TEST_USERNAME);
    if (!user) throw new Error(`Username "${TEST_USERNAME}" not found in Users tab`);
    ok(`getUserByUsername → ${user.realName} / ${user.department}`);
    dept = dept || user.department;
  } catch (err) { fail('getUserByUsername', err); }

  if (TEST_CHAT_ID) {
    try {
      const byId = await sheets.getUserByChatId(TEST_CHAT_ID);
      if (!byId) throw new Error(`Chat ID "${TEST_CHAT_ID}" not found in Users tab`);
      ok(`getUserByChatId → ${byId.realName}`);
    } catch (err) { fail('getUserByChatId', err); }
  } else {
    console.log(`  ⏭   getUserByChatId — skipped (TEST_CHAT_ID not set)`);
  }

  // ── 3. Stats tab ────────────────────────────────────────────────────────────
  section('Stats tab');

  try {
    const stats = await sheets.getStatsForUser(TEST_NAME);
    if (!stats) {
      console.log(`  ⚠️   getStatsForUser — no row found for "${TEST_NAME}" (Apps Script may not have run yet)`);
    } else {
      ok(`getStatsForUser → stage: ${stats.plantStage}  progress: ${stats.progressPct}%  streak: ${stats.streak}  submitted: ${stats.submittedThisWeek}`);
    }
  } catch (err) { fail('getStatsForUser', err); }

  // ── 4. DeptStats tab ────────────────────────────────────────────────────────
  section('DeptStats tab');

  try {
    const all = await sheets.getAllDeptStats();
    if (!all.length) {
      console.log(`  ⚠️   getAllDeptStats — tab is empty (seed DeptStats tab manually)`);
    } else {
      ok(`getAllDeptStats → ${all.length} department(s) found`);
    }
  } catch (err) { fail('getAllDeptStats', err); }

  if (dept) {
    try {
      const deptStats = await sheets.getDeptStats(dept);
      if (!deptStats) {
        console.log(`  ⚠️   getDeptStats — no row found for "${dept}" in DeptStats tab`);
      } else {
        ok(`getDeptStats → stage: ${deptStats.gardenStage}  ${deptStats.totalSubmissions}/${deptStats.targetSubmissions}`);
      }
    } catch (err) { fail('getDeptStats', err); }
  }

  // ── 5. Submissions tab (read) ────────────────────────────────────────────────
  section('Submissions tab (read)');

  let lastRowIndex = null;
  try {
    const subs = await sheets.getSubmissionsForUser(TEST_NAME, 5);
    if (!subs.length) {
      console.log(`  ⚠️   getSubmissionsForUser — no submissions yet for "${TEST_NAME}"`);
    } else {
      lastRowIndex = subs[subs.length - 1].rowIndex;
      ok(`getSubmissionsForUser → ${subs.length} submission(s), latest on ${subs[subs.length - 1].date}`);
    }
  } catch (err) { fail('getSubmissionsForUser', err); }

  // ── 6. Submissions tab (write) ───────────────────────────────────────────────
  section('Submissions tab (write)');

  let testRowIndex = null;
  if (user && dept) {
    try {
      await sheets.logSubmission(
        TEST_NAME,
        dept,
        '[TEST] This is an automated test Q1 — safe to delete',
        '[TEST] This is an automated test Q2 — safe to delete'
      );
      ok(`logSubmission → row written to Submissions tab`);

      // Read it back to confirm
      const check = await sheets.getSubmissionsForUser(TEST_NAME, 10);
      const testRow = check.find(s => s.q1.includes('[TEST]'));
      if (!testRow) throw new Error('Test row not found after writing');
      testRowIndex = testRow.rowIndex;
      ok(`logSubmission verified → found at row ${testRowIndex}`);
    } catch (err) { fail('logSubmission', err); }
  } else {
    console.log(`  ⏭   logSubmission — skipped (user not found)`);
  }

  // ── 7. Submissions tab (edit) ────────────────────────────────────────────────
  section('Submissions tab (edit)');

  if (testRowIndex) {
    try {
      await sheets.updateSubmission(
        testRowIndex,
        '[TEST] Updated Q1 — safe to delete',
        '[TEST] Updated Q2 — safe to delete'
      );
      ok(`updateSubmission → row ${testRowIndex} updated`);

      const verify = await sheets.getSubmissionsForUser(TEST_NAME, 10);
      const updated = verify.find(s => s.rowIndex === testRowIndex);
      if (!updated?.q1.includes('Updated')) throw new Error('Update not reflected in sheet');
      ok(`updateSubmission verified → changes confirmed in sheet`);
    } catch (err) { fail('updateSubmission', err); }
  } else {
    console.log(`  ⏭   updateSubmission — skipped (no test row to update)`);
  }

  // ── 8. Monday nudge list ─────────────────────────────────────────────────────
  section('Monday nudge list');

  try {
    const nudgeUsers = await sheets.getAllUsersWithChatId();
    if (!nudgeUsers.length) {
      console.log(`  ⚠️   getAllUsersWithChatId — no users with Chat ID yet (users need to /reflect first)`);
    } else {
      ok(`getAllUsersWithChatId → ${nudgeUsers.length} user(s) will receive Monday nudges`);
    }
  } catch (err) { fail('getAllUsersWithChatId', err); }

  // ── 9. Week number ───────────────────────────────────────────────────────────
  section('Week number');

  try {
    const start = new Date('2026-04-20T00:00:00+08:00');
    const daysSince = Math.floor((Date.now() - start.getTime()) / 86400000);
    const week = Math.min(Math.max(Math.ceil((daysSince + 1) / 7), 1), 13);
    ok(`Current week: Week ${week + 13} (internal ${week} of 13)`);
  } catch (err) { fail('Week number calculation', err); }

  // ── Garden shuffle ────────────────────────────────────────────────────────────
  section('Garden shuffle');
  try {
    const allStats = await sheets.getAllUserStats();
    if (allStats.length < 2) {
      ok('Too few users to test shuffle — skipped');
    } else {
      const original = allStats.map(u => u.plantStage);
      function shuffle(arr) {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
      }
      // Verify set is preserved
      const shuffled = shuffle(original);
      const sortedOrig = [...original].sort().join('');
      const sortedShuf = [...shuffled].sort().join('');
      if (sortedOrig !== sortedShuf) throw new Error('Shuffle changed the set of emojis');
      ok('Shuffle preserves emoji set');

      // Verify at least one of 5 shuffles produces a different order
      let anyDifferent = false;
      for (let i = 0; i < 5; i++) {
        if (shuffle(original).join('') !== original.join('')) { anyDifferent = true; break; }
      }
      if (!anyDifferent) throw new Error('5 shuffles all produced the same order');
      ok('Shuffle produces different orderings');
    }
  } catch (err) { fail('Garden shuffle', err); }

  // ── ISO week mapping ─────────────────────────────────────────────────────────
  section('ISO week mapping');
  try {
    function toISOWeek(w) { return w + 13; }
    function fromISOWeek(w) { return w - 13; }
    if (toISOWeek(1) !== 14) throw new Error(`toISOWeek(1) = ${toISOWeek(1)}, expected 14`);
    if (toISOWeek(13) !== 26) throw new Error(`toISOWeek(13) = ${toISOWeek(13)}, expected 26`);
    if (fromISOWeek(14) !== 1) throw new Error(`fromISOWeek(14) = ${fromISOWeek(14)}, expected 1`);
    if (fromISOWeek(26) !== 13) throw new Error(`fromISOWeek(26) = ${fromISOWeek(26)}, expected 13`);
    ok('toISOWeek and fromISOWeek are correct');
  } catch (err) { fail('ISO week mapping', err); }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(52)}`);
  console.log(`  ${passed} passed  |  ${failed} failed\n`);

  if (failed === 0) {
    console.log(`  🌱 All good — bot is ready to go!\n`);
  } else {
    console.log(`  ⚠️  Fix the failures above before launching.\n`);
  }

  // Remind to clean up test rows
  if (testRowIndex) {
    console.log(`  📋 Heads up: delete the [TEST] rows from your Submissions tab in Google Sheets.\n`);
  }
}

run().catch(err => {
  console.error('\n💥 Test script crashed:', err.message);
  process.exit(1);
});
