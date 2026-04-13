import { google } from 'googleapis';
import { readFileSync } from 'fs';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

let _authClient = null;

async function getAuthClient() {
  if (_authClient) return _authClient;

  let credentials;
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  } else if (process.env.GOOGLE_CREDENTIALS_PATH) {
    credentials = JSON.parse(readFileSync(process.env.GOOGLE_CREDENTIALS_PATH, 'utf8'));
  } else {
    throw new Error('No Google credentials found. Set GOOGLE_CREDENTIALS_JSON or GOOGLE_CREDENTIALS_PATH in .env');
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  _authClient = await auth.getClient();
  return _authClient;
}

async function getSheetsClient() {
  const auth = await getAuthClient();
  return google.sheets({ version: 'v4', auth });
}

// ---------------------------------------------------------------------------
// SGT timestamp helper
// ---------------------------------------------------------------------------

function getSGTDatetime() {
  const now = new Date();
  const sgt = new Date(now.getTime() + 8 * 60 * 60 * 1000); // UTC+8
  const date = sgt.toISOString().slice(0, 10); // YYYY-MM-DD
  let hours = sgt.getUTCHours();
  const minutes = String(sgt.getUTCMinutes()).padStart(2, '0');
  const period = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return { date, time: `${hours}:${minutes} ${period}` };
}

// ---------------------------------------------------------------------------
// Users tab
// ---------------------------------------------------------------------------

/**
 * Look up a user by their Telegram username (case-insensitive).
 * Returns { realName, department, chatId } or null if not found.
 */
export async function getUserByUsername(username) {
  if (!username) return null;
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: 'Users!A:D',
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const rows = res.data.values ?? [];
  const needle = username.toLowerCase();

  for (const row of rows) {
    const rowUsername = String(row[0] ?? '').toLowerCase().trim();
    if (rowUsername === needle) {
      return {
        realName: String(row[1] ?? '').trim(),
        department: String(row[2] ?? '').trim(),
        chatId: row[3] ? String(row[3]).trim() : null,
      };
    }
  }
  return null;
}

/**
 * Write the user's Telegram chat ID into column D of the Users tab.
 * Only writes if the cell is currently empty (avoids unnecessary API calls).
 */
export async function setChatId(username, chatId) {
  if (!username || !chatId) return;
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: 'Users!A:D',
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const rows = res.data.values ?? [];
  const needle = username.toLowerCase();

  for (let i = 0; i < rows.length; i++) {
    const rowUsername = String(rows[i][0] ?? '').toLowerCase().trim();
    if (rowUsername === needle) {
      const existingChatId = rows[i][3];
      if (existingChatId) return; // already set

      const rowNumber = i + 1; // Sheets rows are 1-indexed
      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.SHEET_ID,
        range: `Users!D${rowNumber}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[String(chatId)]] },
      });
      return;
    }
  }
}

/**
 * Returns all users with a Chat ID set — used by the Sunday cron job.
 * Returns array of { realName, chatId }.
 */
export async function getAllUsersWithChatId() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: 'Users!A:D',
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const rows = res.data.values ?? [];
  const result = [];
  for (const row of rows) {
    const chatId = row[3] ? String(row[3]).trim() : null;
    if (chatId) {
      result.push({
        realName: String(row[1] ?? '').trim(),
        chatId,
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Stats tab (Apps Script writes; bot reads)
// ---------------------------------------------------------------------------

/**
 * Get a user's plant stats from the Stats tab.
 * Returns { plantStage, progressPct, streak, submittedThisWeek } or null.
 */
export async function getStatsForUser(realName) {
  if (!realName) return null;
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: 'Stats!A:E',
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const rows = res.data.values ?? [];
  const needle = realName.toLowerCase().trim();

  for (const row of rows) {
    const rowName = String(row[0] ?? '').toLowerCase().trim();
    if (rowName === needle) {
      return {
        plantStage: String(row[1] ?? '🌱').trim(),
        progressPct: Number(row[2] ?? 0),
        streak: Number(row[3] ?? 0),
        submittedThisWeek: Boolean(row[4]), // UNFORMATTED_VALUE returns actual booleans
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// DeptStats tab (Apps Script writes; bot reads)
// ---------------------------------------------------------------------------

/**
 * Get department garden stats for a given department.
 * Returns { gardenStage, progressPct, totalSubmissions, targetSubmissions } or null.
 */
export async function getDeptStats(department) {
  if (!department) return null;
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: 'DeptStats!A:E',
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const rows = res.data.values ?? [];
  const needle = department.toLowerCase().trim();

  for (const row of rows) {
    const rowDept = String(row[0] ?? '').toLowerCase().trim();
    if (rowDept === needle) {
      return {
        gardenStage: String(row[1] ?? '🌱').trim(),
        progressPct: Number(row[2] ?? 0),
        totalSubmissions: Number(row[3] ?? 0),
        targetSubmissions: Number(row[4] ?? 0),
      };
    }
  }
  return null;
}

/**
 * Returns all rows from DeptStats — used to count gardens in bloom for TC Forest.
 */
export async function getAllDeptStats() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: 'DeptStats!A:E',
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const rows = res.data.values ?? [];
  return rows
    .filter(row => row[0]) // skip empty rows
    .map(row => ({
      department: String(row[0] ?? '').trim(),
      gardenStage: String(row[1] ?? '🌱').trim(),
      progressPct: Number(row[2] ?? 0),
      totalSubmissions: Number(row[3] ?? 0),
      targetSubmissions: Number(row[4] ?? 0),
    }));
}

// ---------------------------------------------------------------------------
// Submissions tab (bot writes)
// ---------------------------------------------------------------------------

/**
 * Append one submission row to the Submissions tab.
 * Columns: Name | Department | Date (YYYY-MM-DD) | Time (HH:MM AM/PM) | Q1 | Q2
 */
export async function logSubmission(realName, department, q1, q2) {
  const { date, time } = getSGTDatetime();
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: 'Submissions!A:F',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[realName, department, date, time, q1, q2]],
    },
  });
}
