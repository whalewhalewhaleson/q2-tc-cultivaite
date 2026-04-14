import { google } from 'googleapis';
import { readFileSync } from 'fs';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

let _authClient = null;

async function getAuthClient() {
  if (_authClient) return _authClient;

  let credentials;
  if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    // Preferred: two separate env vars — avoids JSON mangling issues
    credentials = {
      type: 'service_account',
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
  } else if (process.env.GOOGLE_CREDENTIALS_JSON) {
    credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    if (credentials.private_key) {
      credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
    }
  } else if (process.env.GOOGLE_CREDENTIALS_PATH) {
    credentials = JSON.parse(readFileSync(process.env.GOOGLE_CREDENTIALS_PATH, 'utf8'));
  } else {
    throw new Error('No Google credentials found. Set GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY in Railway variables.');
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
 * Look up a user by their Telegram user ID (numeric, stored in column D).
 * More reliable than username — IDs never change even if handle does.
 * Returns { realName, department, chatId } or null if not found.
 */
export async function getUserByChatId(chatId) {
  if (!chatId) return null;
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: 'Users!A:D',
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const rows = res.data.values ?? [];
  const needle = String(chatId).trim();

  for (const row of rows) {
    const rowChatId = row[3] ? String(row[3]).trim() : null;
    if (rowChatId === needle) {
      return {
        realName: String(row[1] ?? '').trim(),
        department: String(row[2] ?? '').trim(),
        chatId: rowChatId,
      };
    }
  }
  return null;
}

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
 * Look up a user by their real name (case-insensitive, column B).
 * Returns { realName, department, chatId } or null if not found.
 */
export async function getUserByRealName(realName) {
  if (!realName) return null;
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: 'Users!A:D',
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const rows = res.data.values ?? [];
  const needle = realName.toLowerCase().trim();

  for (const row of rows) {
    const rowName = String(row[1] ?? '').toLowerCase().trim();
    if (rowName === needle) {
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
 * Returns the last N submissions for a user, most recent last.
 * Each row includes rowIndex (1-based) for potential editing.
 */
export async function getSubmissionsForUser(realName, limit = 5) {
  if (!realName) return [];
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: 'Submissions!A:F',
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const rows = res.data.values ?? [];
  const needle = realName.toLowerCase().trim();
  const userRows = [];

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] ?? '').toLowerCase().trim() === needle) {
      userRows.push({
        rowIndex: i + 1, // 1-based Sheets row number
        date: String(rows[i][2] ?? '').trim(),
        time: String(rows[i][3] ?? '').trim(),
        q1: String(rows[i][4] ?? '').trim(),
        q2: String(rows[i][5] ?? '').trim(),
      });
    }
  }

  return userRows.slice(-limit);
}

/**
 * Update Q1 and/or Q2 of an existing submission row.
 * rowIndex is 1-based (as returned by getSubmissionsForUser).
 */
export async function updateSubmission(rowIndex, q1, q2) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SHEET_ID,
    range: `Submissions!E${rowIndex}:F${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[q1, q2]] },
  });
}

/**
 * Write an excused-absence row for a user into the Submissions tab.
 * Uses Wednesday 12:00 PM SGT of the target week so the Apps Script
 * week-boundary logic (Mon 6 PM SGT cutoff) reliably places it in the right week.
 * Q2_START is week 1 Monday: 2026-04-20.
 */
export async function logSkip(realName, department, weekNumber) {
  // Wednesday of week N = Q2 Monday + (N-1)*7 + 2 days
  const Q2_MONDAY_UTC = Date.UTC(2026, 3, 20); // 2026-04-20 00:00 UTC
  const wednesdayUTC = Q2_MONDAY_UTC + ((weekNumber - 1) * 7 + 2) * 86400000;
  const d = new Date(wednesdayUTC);
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const time = '12:00 PM';

  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: 'Submissions!A:F',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[realName, department, date, time, '[Excused absence]', '[Excused absence]']],
    },
  });
}

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
