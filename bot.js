import 'dotenv/config';
import { Bot, session, InlineKeyboard } from 'grammy';
import { conversations, createConversation } from '@grammyjs/conversations';
import cron from 'node-cron';
import crypto from 'crypto';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as sheets from './db.js';
import { grantDashboardAccess, revokeDashboardAccess, listDashboardAccess, getDashboardAccessIds,
         getManager, addManager, removeManager, listManagers, getGoodNewsByDept,
         getUserByRealName, getUserByChatId, setGoodNewsWeek,
         getApprovedUnnotifiedGoodNews, markGoodNewsNotified,
         getGoodNewsById } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// MarkdownV2 helpers
// ---------------------------------------------------------------------------

// Escape all MarkdownV2 special characters in plain text.
// RULE: always pass RAW (unescaped) text to e(), bold(), italic().
// Passing pre-escaped text (e.g. 'hello\\!') double-escapes and causes 400 errors.
function e(text) {
  return String(text).replace(/[_*[\]()~`>#+=|{}.!\-]/g, '\\$&');
}

// Bold text
function bold(text) { return `*${e(text)}*`; }

// Italic text
function italic(text) { return `_${e(text)}_`; }

// Monospace / code text (no escaping needed inside backticks)
function mono(text) { return `\`${text}\``; }

// Splits an array of line strings into pages that fit within Telegram's 4096-char limit.
// reservedTail is the length of any footer appended only to the last page.
function paginateLines(lines, reservedTail = 0, maxChars = 3500) {
  const pages = [];
  let page = '';
  for (const line of lines) {
    const sep = page ? '\n' : '';
    const wouldExceed = page.length + sep.length + line.length + (pages.length === 0 ? reservedTail : 0) > maxChars;
    if (page && wouldExceed) {
      pages.push(page);
      page = line;
    } else {
      page += sep + line;
    }
  }
  if (page) pages.push(page);
  return pages.length ? pages : [''];
}

// ---------------------------------------------------------------------------
// Growth helpers
// ---------------------------------------------------------------------------

const STAGES = ['🌱', '🌿', '🌳', '🌼', '🍎', '🍂', '🥀'];
const STAGE_NAMES = {
  '🌱': 'Seedling',
  '🌿': 'Sprout',
  '🌳': 'Sapling',
  '🌼': 'Flowering',
  '🍎': 'Fruiting',
  '🍂': 'Dying',
  '🥀': 'Dead',
};
const HEALTHY_STAGES = ['🌱', '🌿', '🌳', '🌼', '🍎'];
// Points lower-bound per stage (mirrors apps-script.gs CONFIG.STAGE_THRESHOLDS)
const STAGE_THRESHOLDS_PTS = [0, 21, 51, 86, 116];
const shoutedDepts = new Set();
let firstShoutoutFiredThisWeek = false;
let lastRecapWeek = 0;

// Abort flags — set by /cancelnudge, checked by the corresponding cron before sending
const cronAbortFlags = { deadline: false };

function getWeekNumber() {
  const start = new Date('2026-03-30T16:00:00+08:00'); // Mon 4pm SGT boundary
  const ms = Date.now() - start.getTime();
  if (ms < 0) return 1;
  return Math.min(Math.max(Math.floor(ms / (7 * 24 * 60 * 60 * 1000)) + 1, 1), 13);
}

function toISOWeek(w) { return w + 13; }
function fromISOWeek(w) { return w - 13; }

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Progress bar using filled ● and empty ○, wrapped in monospace
function buildProgressBar(pct) {
  const filled = Math.floor(Math.max(0, Math.min(100, pct)) / 10);
  return mono('●'.repeat(filled) + '○'.repeat(10 - filled));
}

// Resolve the display emoji — dying/dead override the earned stage for display only
function resolveDisplayStage(plantStage, consecutiveMisses) {
  if (consecutiveMisses >= 2) return '🥀';
  if (consecutiveMisses === 1) return '🍂';
  return plantStage;
}

function buildRecapMessage(displayName, week, stats, totalUsers, deptRank, totalDepts, deptAvgPts, changelog = null) {
  let msg = `Hey ${e(displayName)}\\! Here's your week ${e(String(toISOWeek(week)))} check\\-in 🌱`;

  if (!stats.submittedThisWeek) {
    msg += ` Haven't reflected yet\\? /reflect when you're ready\\! 🌳🍎`;
  }

  msg += `\n\n`;

  if (stats.consecutiveMisses >= 1) {
    msg += `🍂 Your plant could use some water\n`;
  } else {
    const displayStage = resolveDisplayStage(stats.plantStage, stats.consecutiveMisses);
    const stageName = STAGE_NAMES[stats.plantStage] ?? 'Seedling';
    msg += `${displayStage} ${e(stageName)} · ${e(String(stats.totalPoints))} pts\n`;
  }

  if (stats.streak > 0 && stats.consecutiveMisses === 0) {
    msg += `🔥 ${e(String(stats.streak))}\\-week streak\n`;
  }

  if (stats.rank <= 3) {
    msg += `📊 \\#${e(String(stats.rank))} out of ${e(String(totalUsers))} 👑\n`;
  } else {
    msg += `📊 \\#${e(String(stats.rank))} out of ${e(String(totalUsers))}\n`;
  }

  if (deptRank != null && totalDepts != null && deptAvgPts != null) {
    msg += `🏡 \\#${e(String(deptRank))} out of ${e(String(totalDepts))} · ${e(String(deptAvgPts))} avg pts\n`;
  }

  if (changelog) {
    msg += `\n\n📣 ${bold('Announcements from the Team')}\n${e(changelog)}`;
  }
  msg += `\n\n→ /mystats · /leaderboard · /department`;
  return msg;
}

// How many more pts until the next stage
function getNextStageInfo(plantStage, totalPoints) {
  const idx = HEALTHY_STAGES.indexOf(plantStage);
  if (idx === -1 || idx === HEALTHY_STAGES.length - 1) return { nextEmoji: null, ptsNeeded: 0 };
  const ptsNeeded = Math.max(0, STAGE_THRESHOLDS_PTS[idx + 1] - totalPoints);
  return { nextEmoji: HEALTHY_STAGES[idx + 1], ptsNeeded };
}

// Full plant card block (used in /reflect, /mystats)
function buildPlantCard(stage, pct, streak, submittedThisWeek, totalPoints, consecutiveMisses, rank, totalUsers) {
  const displayStage = resolveDisplayStage(stage, consecutiveMisses);
  const bar = buildProgressBar(pct);
  const stageName = STAGE_NAMES[stage] ?? 'Seedling';
  const submittedLine = submittedThisWeek
    ? `✅ Submitted this week`
    : `❌ Not submitted yet this week`;

  // Streak: one 🔥 per week (max 5 shown, then show count)
  const streakCount = Math.min(streak, 5);
  const streakStr = streak > 0
    ? `${'🔥'.repeat(streakCount)}${streak > 5 ? ` ×${streak}` : ''} \\(${streak} week${streak !== 1 ? 's' : ''}\\)`
    : `None \\(0 weeks\\)`;

  // Line 1: Plant ▸ emoji StageName · pts
  let card = `Plant ▸ ${displayStage} ${e(stageName)} · ${e(String(totalPoints ?? 0))} pts\n`;

  // Line 2: Next ▸ bar X pts to next stage
  const { nextEmoji, ptsNeeded } = getNextStageInfo(stage, totalPoints ?? 0);
  if (nextEmoji) {
    card += `Next ▸ ${bar} ${e(String(ptsNeeded))} pts to ${nextEmoji}\n`;
  } else {
    card += `Next ▸ ${bar} ${italic('Full bloom! 🍎')}\n`;
  }

  card += `\n🔥 Streak ▸ ${streakStr}\n`;
  card += submittedLine;

  // Dying/dead flavour text at the bottom
  if (consecutiveMisses >= 2) {
    card += `\n\n${italic('Your plant has withered. Reflect to revive it!')}`;
  } else if (consecutiveMisses === 1) {
    card += `\n\n${italic('Your plant is struggling — reflect this week to save it!')}`;
  }

  return card;
}

function buildWeeklyBreakdown(stats) {
  const STATUS_ICON = {
    submitted: '✅', late: '⏰', extended: '📎',
    excused: '🟡', missed: '❌', pending: '⏳',
  };

  const gnByWeek = new Map();
  for (const gn of stats.goodNewsEvents) {
    if (gn.week == null) continue;
    if (!gnByWeek.has(gn.week)) gnByWeek.set(gn.week, []);
    gnByWeek.get(gn.week).push(gn);
  }

  let out = `\n\n📊 ${bold('Weekly Breakdown')}`;
  for (const w of stats.weeklyBreakdown) {
    const icon = STATUS_ICON[w.status] ?? '—';
    const ptsStr = w.pts > 0 ? `${e(String(w.pts))} pts` : '—';
    const bonus = w.dept2x ? ' ×2' : '';
    out += `\nW${toISOWeek(w.week)} ${icon} ${ptsStr}${e(bonus)}`;
    const gnEvents = gnByWeek.get(w.week);
    if (gnEvents) {
      const parts = gnEvents.map(gn => `${gn.kind === 'shared' ? 'Shared' : 'Received'} \\+${e(String(gn.pts))}`);
      out += `\n  🗞 ${parts.join(' · ')}`;
    }
  }

  return out;
}

// Returns nickname if set, otherwise falls back to realName
async function getDisplayName(realName) {
  const nick = await sheets.getNickname(realName);
  return nick ?? realName;
}

async function broadcastDeptShoutout(department) {
  if (shoutedDepts.has(department)) return;
  shoutedDepts.add(department);

  // Only the first dept to hit 100% each week gets a company-wide shoutout
  if (firstShoutoutFiredThisWeek) return;
  firstShoutoutFiredThisWeek = true;

  const rawCache = await sheets.getRawStatsCache();
  const deptMembers = rawCache.sorted.filter(s => s.department === department);
  const memberNames = await Promise.all(
    deptMembers.map(async m => {
      const nick = await sheets.getNickname(m.realName);
      return nick ?? m.realName;
    })
  );
  const nameList = memberNames.join(', ');

  const msg = `🎉 ${e(department)} is the first dept to hit 100% this week\\! ${e(nameList)} — leading the way 🌿💧`;
  console.log(`[Shoutout] ${department} is first to hit 100% — broadcasting to all users.`);

  const allUsers = await sheets.getAllUsersWithChatId();
  for (const { chatId } of allUsers) {
    try {
      await bot.api.sendMessage(chatId, msg, { parse_mode: 'MarkdownV2' });
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.error(`[Shoutout] Failed to send to ${chatId}:`, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// User lookup — prefers Telegram user ID over handle (IDs never change)
// ---------------------------------------------------------------------------

async function lookupUser(chatId, username) {
  // Try by persistent user ID first
  let user = await sheets.getUserByChatId(String(chatId));
  if (user) return user;

  // Fall back to username for first-time users
  if (username) {
    user = await sheets.getUserByUsername(username.toLowerCase());
    if (user) {
      // Store their ID so future lookups skip the username step
      await sheets.setChatId(username.toLowerCase(), String(chatId));
    }
    return user;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Admin helpers
// ---------------------------------------------------------------------------

// Returns true if the sender's Telegram user ID is in ADMIN_CHAT_IDS env var
// Set ADMIN_CHAT_IDS=806982232 (comma-separated for multiple admins)
function isAdmin(ctx) {
  const adminIds = (process.env.ADMIN_CHAT_IDS ?? '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);
  return adminIds.includes(String(ctx.from?.id ?? ''));
}

function isLeadershipOrAdmin(ctx) {
  const allIds = [
    ...(process.env.ADMIN_CHAT_IDS ?? '').split(','),
    ...(process.env.LEADERSHIP_CHAT_IDS ?? '').split(','),
  ].map(id => id.trim()).filter(Boolean);
  return allIds.includes(String(ctx.from?.id ?? ''));
}

// ---------------------------------------------------------------------------
// Command interceptor — use inside conversations instead of waitFor directly
// Returns the message context, or null if a command was typed (exits flow)
// ---------------------------------------------------------------------------

async function waitForText(conversation, ctx, cancelMsg = null) {
  const msgCtx = await conversation.waitFor('message:text');
  const text = msgCtx.message.text?.trim() ?? '';

  if (text.startsWith('/')) {
    await ctx.reply(
      cancelMsg ?? `No worries\\. Come back and /reflect whenever you're ready\\. 🌱`,
      { parse_mode: 'MarkdownV2' }
    );
    return null;
  }

  return msgCtx;
}

// Strip legacy "Nominated Name — " prefix from q3 field for display.
// Old submissions stored q3 as "Nominated X — message"; new ones store just the message.
function cleanQ3(q3) {
  if (!q3) return '';
  const match = q3.match(/^Nominated .+? — (.+)$/s);
  return match ? match[1] : q3;
}

// Guard against MarkdownV2 parse errors — retries as plain text so a bad escape
// never silently crashes a conversation. Use for complex formatted messages.
async function safeReply(ctx, text, options = {}) {
  try {
    return await ctx.reply(text, options);
  } catch (err) {
    if (err.error_code === 400 && options.parse_mode) {
      console.error('[safeReply] MarkdownV2 parse error, falling back to plain text:', err.description);
      return await ctx.reply(text.replace(/\\/g, ''), { ...options, parse_mode: undefined });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// /start setup conversation — nickname then goal
// ---------------------------------------------------------------------------

async function setupConversation(conversation, ctx) {
  const chatId = ctx.from?.id;
  const username = ctx.from?.username?.toLowerCase();

  const user = await conversation.external(() => lookupUser(chatId, username));

  if (!user?.realName) {
    await ctx.reply(
      `Looks like you're not in our system yet\\.\nText @whalewhalewhalee to get added, then come back here\\! 🌱`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const cancelMsg = `No worries\\! 🌱 You can always run /nick or /setgoal whenever you're ready\\.`;

  // --- Nickname ---
  const existingNick = await conversation.external(() => sheets.getNickname(user.realName));
  if (!existingNick) {
    await ctx.reply(
      `What should I call you? 🌱\n${italic("Type a nickname to get started — or /cancel if you're not ready yet.")}`,
      { parse_mode: 'MarkdownV2' }
    );
    const nickCtx = await waitForText(conversation, ctx, cancelMsg);
    if (!nickCtx) return;
    const nick = nickCtx.message.text.trim();
    await conversation.external(() => sheets.setNickname(user.realName, nick));
    await ctx.reply(`Nice to meet you, ${bold(nick)}\\! 🌿`, { parse_mode: 'MarkdownV2' });
  }

  // --- Goal ---
  const existingGoal = await conversation.external(() => sheets.getGoal(user.realName));
  if (!existingGoal) {
    await ctx.reply(
      `What kind of person do you want to be by the end of Q2? ❤️🎯🥊\n\n` +
      `${italic("This will show up every time you reflect — so make it personal. You can always change it with /setgoal.")}`,
      { parse_mode: 'MarkdownV2' }
    );
    const goalCtx = await waitForText(conversation, ctx, cancelMsg);
    if (!goalCtx) return;
    const goal = goalCtx.message.text.trim();
    await conversation.external(() => sheets.setGoal(user.realName, goal));
    const goalConfirms = [
      `✅ ${bold('Set.')} Let's lock it in\\! Ready to /reflect?`,
      `✅ ${bold('Locked in!')} Ready to /reflect?`,
      `✅ And you're set\\! /reflect whenever you're ready\\!`,
    ];
    const goalConfirm = goalConfirms[Math.floor(Math.random() * goalConfirms.length)];
    await ctx.reply(goalConfirm, { parse_mode: 'MarkdownV2' });
  }
}

// ---------------------------------------------------------------------------
// /nick conversation — set or update nickname
// ---------------------------------------------------------------------------

async function setNicknameConversation(conversation, ctx) {
  const chatId = ctx.from?.id;
  const username = ctx.from?.username?.toLowerCase();

  const user = await conversation.external(() => lookupUser(chatId, username));

  if (!user?.realName) {
    await ctx.reply(
      `Hey\\! 👋 You're not in our system yet\\.\nText @whalewhalewhalee to get added\\! 🌱`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const existing = await conversation.external(() => sheets.getNickname(user.realName));

  if (existing) {
    await ctx.reply(
      `Your current nickname is ${bold(existing)}\\.\n\nWhat would you like to change it to?`,
      { parse_mode: 'MarkdownV2' }
    );
  } else {
    await ctx.reply(
      `What should I call you? 🌱`,
      { parse_mode: 'MarkdownV2' }
    );
  }

  const nickCtx = await waitForText(conversation, ctx);
  if (!nickCtx) return;
  const nick = nickCtx.message.text.trim();

  await conversation.external(() => sheets.setNickname(user.realName, nick));
  await ctx.reply(`✅ Nickname set to ${bold(nick)}\\! 🌿`, { parse_mode: 'MarkdownV2' });
}

// ---------------------------------------------------------------------------
// /reflect conversation
// ---------------------------------------------------------------------------

async function reflectConversation(conversation, ctx) {
  const chatId = ctx.from?.id;
  const username = ctx.from?.username?.toLowerCase();

  if (!chatId) {
    await ctx.reply("Hmm, I couldn't identify you 😅 Text @whalewhalewhalee if this keeps happening\\!", { parse_mode: 'MarkdownV2' });
    return;
  }

  // --- Step 1: Look up user ---
  const user = await conversation.external(() => lookupUser(chatId, username));

  if (!user || !user.realName) {
    await ctx.reply(
      `Hey\\! 👋 Looks like you're not in our system yet\\.\n\n` +
      `Text @whalewhalewhalee to get added, then come back here — your reflection journey is waiting\\! 🌱`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // --- Step 2: Check if already submitted this week ---
  const [statsBefore, displayName] = await conversation.external(() =>
    Promise.all([sheets.getStatsForUser(user.realName), getDisplayName(user.realName)])
  );
  const alreadySubmitted = statsBefore?.submittedThisWeek === true;

  // --- Step 3: Greeting ---
  const weekNum = getWeekNumber();
  const stage              = statsBefore?.plantStage        ?? '🌱';
  const pct                = statsBefore?.progressPct       ?? 0;
  const streak             = statsBefore?.streak            ?? 0;
  const totalPoints        = statsBefore?.totalPoints       ?? 0;
  const consecutiveMisses  = statsBefore?.consecutiveMisses ?? 0;

  // --- Step 3b: Goal reminder / first-time prompt ---
  const existingGoal = await conversation.external(() => sheets.getGoal(user.realName));

  if (!existingGoal) {
    await ctx.reply(
      `Hey ${e(displayName)} 🐳 👋 One thing before we start —\n\n` +
      `${bold("Who do you want to be by the end of Q2?")} 🌱\n\n` +
      `${italic("Just type it out! I'll bring it up every time you reflect to keep you on track. (Change it anytime with /setgoal.)")}`,
      { parse_mode: 'MarkdownV2' }
    );
    const goalCtx = await waitForText(conversation, ctx);
    if (!goalCtx) return;
    const newGoal = goalCtx.message.text.trim();
    await conversation.external(() => sheets.setGoal(user.realName, newGoal));
    await ctx.reply(`✅ ${bold('Saved.')} Let's reflect\\. 🌱`, { parse_mode: 'MarkdownV2' });
  } else {
    const reflectOpeners = [
      `Nice to see you again, ${e(displayName)}\\! 🌳🦋 Week ${toISOWeek(weekNum)}, let's go\\!\n\n` +
      `🎯 Your goal: ${italic(`"${existingGoal}"`)}\\ — how's it going\\?\n\n` +
      `This week, did you spot yourself or someone displaying ${bold('Care · Leadership · Can-Do Attitude · Team')}\\? Keep an eye out as you reflect\\! 🌱\n\n` +
      `${italic('(Your reflections will be visible to your managers/HODs!)')}`,

      `Hey there, ${e(displayName)}\\! Ready for Week ${toISOWeek(weekNum)}\\? 🌱\n\n` +
      `Before we start — think about the past week\\. Did you or someone around you show ${bold('Care · Leadership · Can-Do Attitude · Team')}\\?\n\n` +
      `🎯 Your goal: ${italic(`"${existingGoal}"`)}\\ — any progress\\?\n\n` +
      `${italic('(Your reflections will be visible to your managers/HODs!)')}`,

      `How was your week, ${e(displayName)}\\? 😎 Week ${toISOWeek(weekNum)} — let's reflect\\.\n\n` +
      `🎯 Your goal: ${italic(`"${existingGoal}"`)}\\ — how is it coming along\\? 💭\n\n` +
      `As you reflect, think about who stood out this week — yourself or a teammate — living out ${bold('Care · Leadership · Can-Do Attitude · Team')}\\. 🌱\n\n` +
      `${italic('(Your reflections will be visible to your managers/HODs!)')}`,
    ];
    const opener = reflectOpeners[Math.floor(Math.random() * reflectOpeners.length)];
    await ctx.reply(opener, { parse_mode: 'MarkdownV2' });
  }

  // --- Step 4: Q1 prompt (message 2) ---
  await ctx.reply(
    `${bold("Q1: What is one TC value you've lived out and how? 🤔 And in the coming week, how can you live out our values even more? 🌱☁️")}`,
    { parse_mode: 'MarkdownV2' }
  );

  const q1Ctx = await waitForText(conversation, ctx);
  if (!q1Ctx) return;
  const q1 = q1Ctx.message.text;

  // --- Step 5: Q2 prompt (message 3) ---
  await ctx.reply(
    `${bold('Q2: How did you do in your role? What would a coach tell you? 💭💪🏻')}`,
    { parse_mode: 'MarkdownV2' }
  );

  // --- Step 6: Wait for Q2 (intercepts commands) ---
  const q2Ctx = await waitForText(conversation, ctx);
  if (!q2Ctx) return;
  const q2 = q2Ctx.message.text;

  // --- Step 6b: Optional Q3 — Good News ---
  let nomineeName = null;
  let nomineeDept = null;
  let hasGoodNews = false;
  let q3Raw = '';

  const q3Keyboard = new InlineKeyboard().text('Skip ⏭️', 'q3_skip');
  await ctx.reply(
    `${bold('Q3 (Optional): Any good news to share? ⭐️')}\n\n` +
    `${italic('Did someone display our core values, go the extra mile, or show great character? Tell us who and what happened — the more specific, the better!')}\n\n` +
    `${italic('You can shout out more than one person.')}\n\n` +
    `📬 ${italic('FYI: the people you shout out will receive a notification once the team reviews it.')}`,
    { parse_mode: 'MarkdownV2', reply_markup: q3Keyboard }
  );
  const q3Event = await conversation.waitFor(['message:text', 'callback_query:data']);
  let q3Input;
  if (q3Event.callbackQuery) {
    await q3Event.answerCallbackQuery();
    q3Input = 'skip';
  } else {
    const text = q3Event.message.text?.trim() ?? '';
    if (text.startsWith('/')) {
      await ctx.reply(`No worries\\. Come back and /reflect whenever you're ready\\. 🌱`, { parse_mode: 'MarkdownV2' });
      return;
    }
    q3Input = text;
  }

  if (q3Input.toLowerCase() !== 'skip') {
    nomineeName = 'Unknown';
    q3Raw = q3Input.trim();
    hasGoodNews = q3Raw.length > 0;
    if (hasGoodNews && nomineeName !== 'Unknown') {
      const nomineeUser = await conversation.external(() => sheets.getUserByRealName(nomineeName));
      nomineeDept = nomineeUser?.department ?? 'Unknown';
    }
  }

  // --- Step 7: Log submission + good news + trigger Apps Script ---
  const q3Stored = hasGoodNews ? q3Raw : '';
  await conversation.external(async () => {
    await sheets.logSubmission(user.realName, user.department, q1, q2, q3Stored);
    if (hasGoodNews && nomineeName) {
      await sheets.logGoodNews(user.realName, user.department, nomineeName, nomineeDept, q3Raw, getWeekNumber());
    }
    sheets.invalidateStatsCache();
  });

  // --- Step 8: Re-read stats (instant — calculated live from Supabase) ---
  const statsAfter = await conversation.external(() => sheets.getStatsForUser(user.realName));

  // --- Contextual celebration data ---
  const userRank = statsAfter?.rank ?? 999;
  const rawCache = await conversation.external(() => sheets.getRawStatsCache());
  const weekNow = rawCache.weekNow;
  const deptsToCheck = [user.department, user.secondaryDepartment].filter(Boolean);
  let completedDept = null;
  for (const dept of deptsToCheck) {
    const rate = rawCache.deptWeekRate[dept]?.[weekNow];
    if (rate && rate.total > 0 && rate.submitted === rate.total && !shoutedDepts.has(dept)) {
      completedDept = dept;
      break;
    }
  }

  const newStage          = statsAfter?.plantStage        ?? stage;
  const newPct            = statsAfter?.progressPct       ?? pct;
  const newStreak         = statsAfter?.streak            ?? streak;
  const newPoints         = statsAfter?.totalPoints       ?? totalPoints;
  const newMisses         = statsAfter?.consecutiveMisses ?? 0;
  const ptsGained         = newPoints - totalPoints;
  const levelledUp = statsAfter &&
    HEALTHY_STAGES.indexOf(newStage) > HEALTHY_STAGES.indexOf(stage);

  const rankTies = Object.values(rawCache.statsMap).filter(u => u.rank === userRank).length;
  const rankMsg = userRank <= 3
    ? (rankTies > 1
        ? `You're currently \\#${userRank} in the company with ${e(String(rankTies - 1))} others 👀 Tap /leaderboard to see who's around you\\!`
        : `You're currently \\#${userRank} in the company 👀 Tap /leaderboard to see who's around you\\!`)
    : null;

  let celebrationLine = '';
  if (!alreadySubmitted) {
    if (levelledUp) {
      if (userRank <= 3) {
        celebrationLine = `\n\n${rankMsg}`;
      } else if (completedDept) {
        celebrationLine = `\n\nYou just made it 100% for ${e(completedDept)}\\! 🎉`;
      } else {
        celebrationLine = `\n\nTap /mystats to see your full progress 🌱`;
      }
    } else if (userRank <= 3) {
      celebrationLine = `\n\n${rankMsg}`;
    } else if (newStreak > 0 && newStreak % 5 === 0) {
      celebrationLine = `\n\n${e(String(newStreak))} weeks straight 🔥 Tap /mystats to see your streak\\!`;
    } else if (completedDept) {
      celebrationLine = `\n\nYou just made it 100% for ${e(completedDept)}\\! 🎉`;
    } else {
      celebrationLine = `\n\nWanna see how you're tracking\\? Tap /mystats or check out /leaderboard 🌱`;
    }
  }

  // --- Step 9: Confirmation ---
  if (alreadySubmitted) {
    let msg = `📝 ${bold('Reflection stored.')}\n\nYour pts for this week are already in — but this one is saved too\\. Keep the habit going\\. 🌱 See you next Monday\\.`;
    if (hasGoodNews && nomineeName) {
      const goodNewsLine = nomineeName === 'Unknown'
        ? `Good news noted — the team will review it!`
        : `Your good news about ${nomineeName} has been noted — the team will review it!`;
      msg += `\n\n🌟 ${italic(goodNewsLine)}`;
    }
    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  } else if (levelledUp) {
    const { nextEmoji, ptsNeeded } = getNextStageInfo(newStage, newPoints);
    let msg = `💧 ${bold('Plant watered!')}\n\n${newStage} ${bold('Your plant just levelled up!')}\n`;
    if (nextEmoji) {
      const noun = ptsNeeded === 1 ? 'pt' : 'pts';
      msg += `\n${italic(`${ptsNeeded} more ${noun} to reach ${nextEmoji}`)}\n`;
    }
    if (ptsGained > 0) {
      msg += `\n\\+${e(String(ptsGained))} pts earned this week\\!\n`;
    }
    msg += `⭐ ${bold(`${newPoints} pts`)} total\\. Your plant is growing — and so are you\\. ${newStage}\n\n${italic('See you Monday — your team is counting on the streak.')}`;
    if (hasGoodNews && nomineeName) {
      msg += `\n\n🌟 ${italic(nomineeName === 'Unknown' ? `Good news noted — the team will review it!` : `Good news about ${nomineeName} noted — the team will review it!`)}`;
    }
    msg += celebrationLine;
    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  } else {
    let msg = `💧 ${bold('Plant watered!')}\n\n`;
    msg += buildPlantCard(newStage, newPct, newStreak, true, newPoints, newMisses, null, null);
    if (ptsGained > 0) {
      msg += `\n\n\\+${e(String(ptsGained))} pts earned this week\\!`;
    }
    msg += `\n\nGood work showing up this week\\. 🌱 See you Monday — the whole team is building this together\\.`;
    if (hasGoodNews && nomineeName) {
      msg += `\n\n🌟 ${italic(nomineeName === 'Unknown' ? `Good news noted — the team will review it!` : `Good news about ${nomineeName} noted — the team will review it!`)}`;
    }
    msg += celebrationLine;
    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  }

  if (completedDept && !alreadySubmitted) {
    conversation.external(() => broadcastDeptShoutout(completedDept));
  }
}

// ---------------------------------------------------------------------------
// /goodnews conversation
// ---------------------------------------------------------------------------

async function goodNewsConversation(conversation, ctx) {
  const chatId = ctx.from?.id;
  const username = ctx.from?.username?.toLowerCase();

  if (!chatId) {
    await ctx.reply("Hmm, I couldn't identify you 😅 Text @whalewhalewhalee if this keeps happening\\!", { parse_mode: 'MarkdownV2' });
    return;
  }

  const user = await conversation.external(() => lookupUser(chatId, username));
  if (!user?.realName) {
    await ctx.reply(
      `Hey\\! 👋 You're not in our system yet\\.\nText @whalewhalewhalee to get added\\! 🌱`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  await safeReply(ctx,
    `${bold('Got someone to shout out? ⭐️')}\n\n` +
    `${italic('Did someone display our core values, go the extra mile, or show great character? Tell us who and what happened — the more specific, the better!')}\n\n` +
    `${italic('You can shout out more than one person.')}`,
    { parse_mode: 'MarkdownV2' }
  );

  const inputCtx = await waitForText(conversation, ctx, `No worries\\. Come back anytime to share good news\\! ⭐️`);
  if (!inputCtx) return;

  const input = inputCtx.message.text.trim();
  let nomineeName, message;
  nomineeName = 'Unknown';
  message = input.trim();

  if (!message) {
    await ctx.reply(`Hmm, didn't catch a message there\\. Try again with /goodnews\\! ⭐️`, { parse_mode: 'MarkdownV2' });
    return;
  }

  await conversation.external(async () => {
    await sheets.logGoodNews(user.realName, user.department, nomineeName, 'Unknown', message, getWeekNumber());
    sheets.invalidateStatsCache();
  });

  await ctx.reply(`Logged\\! ⭐️ The team will review it on Monday\\! 😊`, { parse_mode: 'MarkdownV2' });
}

// ---------------------------------------------------------------------------
// /setgoal conversation
// ---------------------------------------------------------------------------

async function setGoalConversation(conversation, ctx) {
  const chatId = ctx.from?.id;
  const username = ctx.from?.username?.toLowerCase();
  const user = await conversation.external(() => lookupUser(chatId, username));

  if (!user?.realName) {
    await ctx.reply(
      `Hey\\! 👋 You're not in our system yet\\.\nText @whalewhalewhalee to get added\\! 🌱`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const existing = await conversation.external(() => sheets.getGoal(user.realName));

  if (existing) {
    await ctx.reply(
      `🎯 ${bold('Your current goal:')}\n${italic(existing)}\n\n` +
      `What do you want to change it to?`,
      { parse_mode: 'MarkdownV2' }
    );
  } else {
    await ctx.reply(
      `What kind of person do you want to be by the end of Q2? ❤️🎯🥊\n\n` +
      `${italic("This will show up every time you reflect — so make it personal. You can always change it with /setgoal.")}`,
      { parse_mode: 'MarkdownV2' }
    );
  }

  const goalCtx = await waitForText(conversation, ctx);
  if (!goalCtx) return;
  const newGoal = goalCtx.message.text.trim();

  await conversation.external(() => sheets.setGoal(user.realName, newGoal));
  await ctx.reply(
    (() => {
    const confirms = [
      `✅ ${bold('Set.')} Let's lock it in\\! Ready to /reflect?`,
      `✅ ${bold('Locked in!')} Ready to /reflect?`,
      `✅ And you're set\\! /reflect whenever you're ready\\!`,
    ];
    return confirms[Math.floor(Math.random() * confirms.length)];
  })(),
    { parse_mode: 'MarkdownV2' }
  );
}

// ---------------------------------------------------------------------------
// /editreflection conversation
// ---------------------------------------------------------------------------

// Shared helper — edit the user's most recent Pending good news entry.
// Called from both editReflectionConversation (Q3 button) and editGoodNewsConversation.
async function doEditGoodNews(conversation, ctx, user) {
  const latest = await conversation.external(() => sheets.getLatestGoodNewsForNominator(user.realName));
  if (!latest) {
    await ctx.reply(`No good news submissions found\\. Share one with /goodnews anytime\\! ⭐️`, { parse_mode: 'MarkdownV2' });
    return;
  }
  if (latest.status !== 'Pending') {
    await ctx.reply(
      `Your most recent good news has already been ${e(latest.status.toLowerCase())} by the team \\(W${e(String(latest.week_number))}\\)\\.\n\nOnly Pending submissions can be edited\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }
  await ctx.reply(
    `${bold('Your most recent good news')} ${italic(`(W${latest.week_number}, Pending)`)}\n\n` +
    `${e(latest.message)}\n\n` +
    `What would you like to change it to?`,
    { parse_mode: 'MarkdownV2' }
  );
  const inputCtx = await waitForText(conversation, ctx, `No worries\\. Come back whenever you're ready\\.`);
  if (!inputCtx) return;
  const message = inputCtx.message.text.trim();
  if (!message) {
    await ctx.reply(`Hmm, nothing there\\. Try again\\.`, { parse_mode: 'MarkdownV2' });
    return;
  }
  await conversation.external(() => sheets.updatePendingGoodNews(latest.id, latest.nominee_name, message));
  await ctx.reply(`✅ Good news updated\\! The team will still review it on Monday\\. 😊`, { parse_mode: 'MarkdownV2' });
}

async function editReflectionConversation(conversation, ctx) {
  const chatId = ctx.from?.id;
  const username = ctx.from?.username?.toLowerCase();

  const user = await conversation.external(() => lookupUser(chatId, username));
  if (!user?.realName) {
    await ctx.reply(`Hey\\! 👋 You're not in our system yet\\.\nText @whalewhalewhalee to get added\\! 🌱`, { parse_mode: 'MarkdownV2' });
    return;
  }

  const submissions = await conversation.external(() => sheets.getSubmissionsForUser(user.realName, 1));
  if (!submissions.length) {
    await ctx.reply(`No reflections stored yet\\. Your first one is just a /reflect away\\! 🌱`, { parse_mode: 'MarkdownV2' });
    return;
  }

  const latest = submissions[0];

  // 3 separate messages — one per question
  await ctx.reply(`${bold('Your most recent reflection')} · 📅 ${e(latest.date)}`, { parse_mode: 'MarkdownV2' });
  await ctx.reply(`${bold('Q1')}\n${e(latest.q1 || '—')}`, { parse_mode: 'MarkdownV2' });
  await ctx.reply(`${bold('Q2')}\n${e(latest.q2 || '—')}`, { parse_mode: 'MarkdownV2' });
  await ctx.reply(`${bold('Q3 ⭐️')}\n${e(cleanQ3(latest.q3) || 'None shared this week')}`, { parse_mode: 'MarkdownV2' });

  // Inline keyboard for choice
  const keyboard = new InlineKeyboard()
    .text('Q1', 'edit_q1').text('Q2', 'edit_q2').row()
    .text('Q1 + Q2', 'edit_both').text('Q3 Good News ⭐️', 'edit_q3');

  await ctx.reply('Which part would you like to update?', { reply_markup: keyboard });

  const event = await conversation.waitFor('callback_query:data');
  await event.answerCallbackQuery();
  const choice = event.callbackQuery.data;

  if (choice === 'edit_q3') {
    await doEditGoodNews(conversation, ctx, user);
    return;
  }

  let newQ1 = latest.q1;
  let newQ2 = latest.q2;

  if (choice === 'edit_q1' || choice === 'edit_both') {
    await ctx.reply(
      `${bold("Q1: What is one TC value you've lived out and how? 🤔")}\n\n` +
      `${italic('And in the coming week, how can you live out our values even more? 🌱☁️')}`,
      { parse_mode: 'MarkdownV2' }
    );
    const q1Ctx = await waitForText(conversation, ctx);
    if (!q1Ctx) return;
    newQ1 = q1Ctx.message.text;
  }

  if (choice === 'edit_q2' || choice === 'edit_both') {
    await ctx.reply(`${bold('Q2: How did you do in your role? What would a coach tell you? 💭💪🏻')}`, { parse_mode: 'MarkdownV2' });
    const q2Ctx = await waitForText(conversation, ctx);
    if (!q2Ctx) return;
    newQ2 = q2Ctx.message.text;
  }

  await conversation.external(() => sheets.updateSubmission(latest.rowIndex, newQ1, newQ2));
  await ctx.reply(`✅ ${bold('Reflection updated!')} Your words are saved\\. 🌱`, { parse_mode: 'MarkdownV2' });
}

// ---------------------------------------------------------------------------
// /editgoodnews conversation
// ---------------------------------------------------------------------------

async function editGoodNewsConversation(conversation, ctx) {
  const chatId = ctx.from?.id;
  const username = ctx.from?.username?.toLowerCase();
  const user = await conversation.external(() => lookupUser(chatId, username));
  if (!user?.realName) {
    await ctx.reply(`Hey\\! 👋 You're not in our system yet\\.\nText @whalewhalewhalee to get added\\! 🌱`, { parse_mode: 'MarkdownV2' });
    return;
  }
  await doEditGoodNews(conversation, ctx, user);
}

// ---------------------------------------------------------------------------
// Bot setup
// ---------------------------------------------------------------------------

if (!process.env.BOT_TOKEN?.match(/^\d+:[A-Za-z0-9_-]{25,}$/)) {
  throw new Error('BOT_TOKEN is missing or malformed — check your .env');
}

const bot = new Bot(process.env.BOT_TOKEN);

bot.use(session({ initial: () => ({}) }));
bot.use(conversations());
bot.use(createConversation(setupConversation));
bot.use(createConversation(setNicknameConversation));
bot.use(createConversation(reflectConversation));
bot.use(createConversation(goodNewsConversation));
bot.use(createConversation(editGoodNewsConversation));
bot.use(createConversation(setGoalConversation));
bot.use(createConversation(editReflectionConversation));

// ---------------------------------------------------------------------------
// /reflect
// ---------------------------------------------------------------------------

bot.command('reflect', async (ctx) => {
  try {
    await ctx.conversation.enter('reflectConversation');
  } catch (err) {
    console.error('/reflect error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

// ---------------------------------------------------------------------------
// /goodnews
// ---------------------------------------------------------------------------

bot.command('goodnews', async (ctx) => {
  try {
    await ctx.conversation.enter('goodNewsConversation');
  } catch (err) {
    console.error('/goodnews error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

// ---------------------------------------------------------------------------
// /department
// ---------------------------------------------------------------------------

function buildDeptBlock(deptName, deptStats, memberData) {
  if (!deptStats) {
    return `${bold(deptName)}\n${italic('Your garden is just taking root — check back after your first reflections come in!')}`;
  }
  const bar = buildProgressBar(deptStats.progressPct);
  const stageName = STAGE_NAMES[deptStats.gardenStage] ?? 'Growing';
  const avgPts = deptStats.avgPoints ?? 0;
  const totalPts = Math.round(avgPts * memberData.count);
  const deptStreak = deptStats.deptStreak ?? 0;
  const { nextEmoji, ptsNeeded } = getNextStageInfo(deptStats.gardenStage, Math.floor(avgPts));
  const gardenRow = memberData.stages.length
    ? shuffle(memberData.stages).join('')
    : '🌱 Still taking root\\.\\.\\.';

  let block =
    `${deptStats.gardenStage} ${bold(deptName)}\n` +
    `${e(String(memberData.count))} members · ${e(String(totalPts))} total pts\n\n` +
    `Plant ▸ ${deptStats.gardenStage} ${e(stageName)} · ${e(String(avgPts))} avg pts\n`;

  if (nextEmoji) {
    block += `Growth ▸ ${bar} ${e(String(ptsNeeded))} pts to ${nextEmoji}\n`;
  } else {
    block += `Growth ▸ ${bar} ${italic('Full bloom! 🍎')}\n`;
  }

  block +=
    `Streaks ▸ ${e(String(deptStreak))} consecutive 100% week${deptStreak !== 1 ? 's' : ''}\n\n` +
    `${bold('Department Garden')}\n` +
    `${italic('the plants of everyone in your dept!')}\n` +
    gardenRow;

  return block;
}

bot.command('department', async (ctx) => {
  try {
    const chatId = ctx.from?.id;
    const username = ctx.from?.username?.toLowerCase();
    const user = await lookupUser(chatId, username);

    if (!user?.realName) {
      await ctx.reply(
        `Hey\\! 👋 Looks like you're not in our system yet\\.\nText @whalewhalewhalee to get added\\! 🌱`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    const depts = [user.department, user.secondaryDepartment].filter(Boolean);

    const blocks = await Promise.all(depts.map(async (dept) => {
      const [deptStats, memberData] = await Promise.all([
        sheets.getDeptStats(dept),
        sheets.getMemberStagesForDept(dept),
      ]);
      return buildDeptBlock(dept, deptStats, memberData);
    }));

    const msg = blocks.join('\n\n─────────────────\n\n');
    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error('/department error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

// ---------------------------------------------------------------------------
// /deptleaderboard
// ---------------------------------------------------------------------------

bot.command('deptleaderboard', async (ctx) => {
  try {
    const allDepts = await sheets.getAllDeptStats();

    if (!allDepts.length) {
      await ctx.reply(
        `${bold('TC Q2 Dept Leaderboard')}\n\n${italic('No department data yet — check back once reflections start coming in! 🌱')}`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    // Sort by average pts descending
    const sorted = [...allDepts].sort((a, b) => (b.avgPoints ?? 0) - (a.avgPoints ?? 0));

    const medals = ['🥇', '🥈', '🥉'];
    let msg = `🌳 ${bold('TC Q2 Dept Leaderboard')}\n\n`;

    sorted.forEach((dept, i) => {
      const rank = medals[i] ?? `${i + 1}\\.`;
      const stageName = STAGE_NAMES[dept.gardenStage] ?? 'Growing';
      const avgPts = dept.avgPoints ?? 0;
      msg +=
        `${rank} ${dept.gardenStage} ${bold(dept.department)}\n` +
        `${e(String(avgPts))} avg pts — ${italic(stageName)}\n\n`;
    });

    msg += italic('Keep reflecting to climb the ranks! 🌿');

    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error('/deptleaderboard error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

// ---------------------------------------------------------------------------
// /leaderboard — individual top 5 + full company garden
// ---------------------------------------------------------------------------

bot.command('leaderboard', async (ctx) => {
  try {
    const allStats = await sheets.getAllUserStats();

    if (!allStats.length) {
      await ctx.reply(
        `🏆 ${bold('TC Q2 Leaderboard')}\n\n${italic('No data yet — check back once reflections start! 🌱')}`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    const chatId = ctx.from?.id;
    const username = ctx.from?.username?.toLowerCase();
    const currentUser = await lookupUser(chatId, username);

    const medals = ['🥇', '🥈', '🥉'];
    const companyGarden = shuffle(allStats.map(u => u.plantStage)).join('');

    // Assign ranks with dense ties (1,1,2 style)
    const ranked = [];
    let denseRank = 0;
    for (let i = 0; i < allStats.length; i++) {
      if (i === 0 || allStats[i].totalPoints !== allStats[i - 1].totalPoints) denseRank++;
      ranked.push({ ...allStats[i], rank: denseRank });
    }

    const top10 = ranked.slice(0, 10);

    let msg = `🏆 ${bold('TC Q2 Leaderboard')}\n\n`;

    top10.forEach(user => {
      const rankDisplay = medals[user.rank - 1] ?? `${e(String(user.rank))}\\.`;
      msg += `${rankDisplay} ${e(user.name)} ${user.plantStage} — ${e(String(user.totalPoints))} pts\n`;
    });

    // Show current user's rank if outside top 10
    if (currentUser?.realName) {
      const me = ranked.find(u => u.name.toLowerCase() === currentUser.realName.toLowerCase());
      if (me && me.rank > 10) {
        msg += `\n\\.\\.\\.\n${e(String(me.rank))}\\. ${e(me.name)} ${me.plantStage} — ${e(String(me.totalPoints))} pts ${italic('(you)')}\n`;
      }
    }

    msg += `\n${bold('The TC Garden')}\n${italic('the plants of everyone in the company')}\n${companyGarden}`;

    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error('/leaderboard error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

// ---------------------------------------------------------------------------
// /skipweek — admin only
// Usage: /skipweek [Name] [WeekNumber]
// Example: /skipweek Wilson 3
// ---------------------------------------------------------------------------

bot.command('skipweek', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      await ctx.reply(`Sorry, this command is only available to admins\\.`, { parse_mode: 'MarkdownV2' });
      return;
    }

    const args = (ctx.message?.text ?? '').split(/\s+/).slice(1);
    // Last arg is week number, everything before is the name
    const weekArg = args[args.length - 1];
    const nameArg = args.slice(0, -1).join(' ').trim();
    const weekNum = parseInt(weekArg, 10);

    if (!nameArg || isNaN(weekNum) || weekNum < 14 || weekNum > 26) {
      await ctx.reply(
        `${bold('Usage:')} /skipweek \\[Name\\] \\[Week\\]\n\n` +
        `Example: /skipweek Wilson ${toISOWeek(getWeekNumber())}\n\n` +
        `${italic('Week must be between 14 and 26.')}`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    const internalWeek = fromISOWeek(weekNum);

    const user = await sheets.getUserByRealName(nameArg);
    if (!user?.realName) {
      await ctx.reply(
        `${bold(nameArg)} not found in the Users tab\\.\n\nCheck the spelling matches column B exactly\\.`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    await sheets.logSkip(user.realName, user.department, internalWeek);
    sheets.invalidateStatsCache();

    await ctx.reply(
      `✅ ${bold('Week skipped!')}\n\n` +
      `${bold(user.realName)} \\(${e(user.department)}\\) has been marked as excused for ${bold(`Week ${weekNum}`)}\\.\n\n` +
      `Their streak will be preserved once Apps Script recalculates\\.`,
      { parse_mode: 'MarkdownV2' }
    );
  } catch (err) {
    console.error('/skipweek error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

// ---------------------------------------------------------------------------
// /testnudge — admin only, sends the Monday nudge message to yourself
// ---------------------------------------------------------------------------

bot.command('testnudge', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      await ctx.reply(`Sorry, this command is only available to admins\\.`, { parse_mode: 'MarkdownV2' });
      return;
    }

    const arg = ctx.message?.text?.split(' ')[1]?.replace(/^@/, '').toLowerCase();

    let targetChatId, targetDisplayName;

    if (arg) {
      // Look up specified user by realName (case-insensitive, partial match)
      const allUsers = await sheets.getAllUsersWithChatId();
      const match = allUsers.find(u => u.realName?.toLowerCase().includes(arg));
      if (!match) {
        await ctx.reply(`Couldn't find "${arg}" in the system\\.`, { parse_mode: 'MarkdownV2' });
        return;
      }
      targetChatId = match.chatId;
      targetDisplayName = match.nickname ?? match.realName;
    } else {
      // Default: send to self
      const chatId = ctx.from?.id;
      const username = ctx.from?.username?.toLowerCase();
      const user = await lookupUser(chatId, username);
      if (!user?.realName) {
        await ctx.reply(`You're not in the system yet\\. Text @whalewhalewhalee to get added\\! 🌱`, { parse_mode: 'MarkdownV2' });
        return;
      }
      targetChatId = chatId;
      targetDisplayName = await getDisplayName(user.realName);
    }

    const targetUser = arg
      ? (await sheets.getAllUsersWithChatId()).find(u => u.realName?.toLowerCase().includes(arg))
      : { realName: (await lookupUser(ctx.from?.id, ctx.from?.username?.toLowerCase()))?.realName };
    const stats = targetUser?.realName ? await sheets.getStatsForUser(targetUser.realName) : null;

    let nudgeMsg;
    if (stats) {
      const dn = e(targetDisplayName);
      const { nextEmoji, ptsNeeded } = getNextStageInfo(stats.plantStage, stats.totalPoints);
      if (stats.consecutiveMisses >= 1) {
        nudgeMsg = `Hey ${dn}\\! Your plant's looking a bit dry 🍂 — /reflect today to bring it back\\! Deadline 4PM\\.`;
      } else if (nextEmoji && ptsNeeded > 0 && ptsNeeded <= 10) {
        nudgeMsg = `Hey ${dn}\\! You're just ${e(String(ptsNeeded))} pts from reaching ${nextEmoji} — /reflect to keep growing\\! Deadline 4PM\\.`;
      } else if (stats.streak >= 2) {
        nudgeMsg = `Hey ${dn}\\! You're on a ${e(String(stats.streak))}\\-week streak 🔥 — /reflect today to keep it alive\\! Deadline 4PM\\.`;
      } else {
        nudgeMsg = `Hey ${dn}\\! Your ${stats.plantStage} is waiting for water — /reflect on your week\\! Deadline 4PM\\.`;
      }
    } else {
      nudgeMsg = `Hey ${e(targetDisplayName)}\\! /reflect on the past week yet\\? Deadline is today at 4PM\\! 🌱🌊`;
    }

    await bot.api.sendMessage(targetChatId, nudgeMsg, { parse_mode: 'MarkdownV2' });

    if (arg) {
      await ctx.reply(`Nudge sent to ${targetDisplayName} ✅`);
    }
  } catch (err) {
    console.error('/testnudge error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

// ---------------------------------------------------------------------------
// /test1hwarning — admin only, sends the 3PM 1-hour warning to yourself
// ---------------------------------------------------------------------------

bot.command('test1hwarning', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      await ctx.reply(`Sorry, this command is only available to admins\\.`, { parse_mode: 'MarkdownV2' });
      return;
    }

    const arg = ctx.message?.text?.split(' ')[1]?.replace(/^@/, '').toLowerCase();
    let targetChatId, targetDisplayName;

    if (arg) {
      const allUsers = await sheets.getAllUsersWithChatId();
      const match = allUsers.find(u => u.realName?.toLowerCase().includes(arg));
      if (!match) {
        await ctx.reply(`Couldn't find "${arg}" in the system\\.`, { parse_mode: 'MarkdownV2' });
        return;
      }
      targetChatId = match.chatId;
      targetDisplayName = match.nickname ?? match.realName;
    } else {
      const chatId = ctx.from?.id;
      const username = ctx.from?.username?.toLowerCase();
      const user = await lookupUser(chatId, username);
      if (!user?.realName) {
        await ctx.reply(`You're not in the system yet\\. Text @whalewhalewhalee to get added\\! 🌱`, { parse_mode: 'MarkdownV2' });
        return;
      }
      targetChatId = chatId;
      targetDisplayName = await getDisplayName(user.realName);
    }

    const dn = e(targetDisplayName);
    const msg = `Hey ${dn}\\! ⏰ 1 hour left to /reflect before the deadline\\! Don't let your streak slip 🌱`;
    await bot.api.sendMessage(targetChatId, msg, { parse_mode: 'MarkdownV2' });

    if (arg) await ctx.reply(`1h warning sent to ${targetDisplayName} ✅`);
  } catch (err) {
    console.error('/test1hwarning error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

// ---------------------------------------------------------------------------
// /testdeadlinenudge — admin only, sends the 4PM deadline-over message to yourself
// ---------------------------------------------------------------------------

bot.command('testdeadlinenudge', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      await ctx.reply(`Sorry, this command is only available to admins\\.`, { parse_mode: 'MarkdownV2' });
      return;
    }

    const arg = ctx.message?.text?.split(' ')[1]?.replace(/^@/, '').toLowerCase();

    let targetChatId, targetDisplayName;

    if (arg) {
      const allUsers = await sheets.getAllUsersWithChatId();
      const match = allUsers.find(u => u.realName?.toLowerCase().includes(arg));
      if (!match) {
        await ctx.reply(`Couldn't find "${arg}" in the system\\.`, { parse_mode: 'MarkdownV2' });
        return;
      }
      targetChatId = match.chatId;
      targetDisplayName = match.nickname ?? match.realName;
    } else {
      const chatId = ctx.from?.id;
      const username = ctx.from?.username?.toLowerCase();
      const user = await lookupUser(chatId, username);
      if (!user?.realName) {
        await ctx.reply(`You're not in the system yet\\. Text @whalewhalewhalee to get added\\! 🌱`, { parse_mode: 'MarkdownV2' });
        return;
      }
      targetChatId = chatId;
      targetDisplayName = await getDisplayName(user.realName);
    }

    const dn = e(targetDisplayName);
    const msg = `Hey ${dn}\\! This week's deadline has just passed 🌧️\n\nNo worries — you can still /reflect and earn 5 pts\\! Better late than never 🌱\n\nAny questions\\? Text @whalewhalewhalee\\.`;
    await bot.api.sendMessage(targetChatId, msg, { parse_mode: 'MarkdownV2' });

    if (arg) {
      await ctx.reply(`Deadline nudge sent to ${targetDisplayName} ✅`);
    }
  } catch (err) {
    console.error('/testdeadlinenudge error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

// ---------------------------------------------------------------------------
// /cancelnudge — admin only, aborts the upcoming 4PM deadline nudge
// ---------------------------------------------------------------------------

bot.command('cancelnudge', async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply(`Sorry, this command is only available to admins\\.`, { parse_mode: 'MarkdownV2' });
    return;
  }
  cronAbortFlags.deadline = true;
  await ctx.reply(`✅ Deadline nudge cancelled for this cycle\\. It will resume next Monday\\.`, { parse_mode: 'MarkdownV2' });
});

// ---------------------------------------------------------------------------
// /testrecap — admin only, sends the Friday recap message to yourself
// ---------------------------------------------------------------------------

bot.command('testrecap', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      await ctx.reply(`Sorry, this command is only available to admins\\.`, { parse_mode: 'MarkdownV2' });
      return;
    }

    const chatId = ctx.from?.id;
    const username = ctx.from?.username?.toLowerCase();
    const user = await lookupUser(chatId, username);
    if (!user?.realName) {
      await ctx.reply(`You're not in the system yet\\. Text @whalewhalewhalee to get added\\! 🌱`, { parse_mode: 'MarkdownV2' });
      return;
    }

    const stats = await sheets.getStatsForUser(user.realName);
    if (!stats) { await ctx.reply('No stats found.'); return; }

    const allStats = await sheets.getAllUserStats();
    const totalUsers = allStats.length;
    const week = currentQ2Week();
    const displayName = await getDisplayName(user.realName);
    const allDepts = await sheets.getAllDeptStats();
    const deptsSorted = [...allDepts].sort((a, b) => b.avgPoints - a.avgPoints);
    const totalDepts = deptsSorted.length;
    const deptKey = user.department?.toLowerCase();
    const deptRank = deptKey ? (deptsSorted.findIndex(d => d.department.toLowerCase() === deptKey) + 1 || null) : null;
    const deptAvgPts = deptKey ? (deptsSorted.find(d => d.department.toLowerCase() === deptKey)?.avgPoints ?? null) : null;
    const cl = await sheets.getChangelog();
    const msg = buildRecapMessage(displayName, week, stats, totalUsers, deptRank, totalDepts, deptAvgPts, cl?.text ?? null);

    await bot.api.sendMessage(chatId, msg, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error('/testrecap error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

bot.command('firerecap', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      await ctx.reply(`Sorry, this command is only available to admins\\.`, { parse_mode: 'MarkdownV2' });
      return;
    }
    const week = currentQ2Week();
    if (lastRecapWeek >= week) {
      await ctx.reply(`Recap already sent for week ${e(String(toISOWeek(week)))}\\. Use /testrecap to preview without re\\-sending\\.`, { parse_mode: 'MarkdownV2' });
      return;
    }
    await ctx.reply(`🚀 Firing recap to all users now\\.\\.\\.`, { parse_mode: 'MarkdownV2' });
    await runRecapBroadcast();
    await ctx.reply(`✅ Weekly recap sent\\!`, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error('/firerecap error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

// ---------------------------------------------------------------------------
// /pendingnotifications — admin only, list what good news is queued to go out
// ---------------------------------------------------------------------------

bot.command('pendingnotifications', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      await ctx.reply(`Sorry, this command is only available to admins\\.`, { parse_mode: 'MarkdownV2' });
      return;
    }
    const entries = await getApprovedUnnotifiedGoodNews();
    if (!entries.length) {
      await ctx.reply(`No pending good news notifications right now\\.`, { parse_mode: 'MarkdownV2' });
      return;
    }
    await ctx.reply(
      `📨 ${bold(`Pending Good News Notifications (${entries.length})`)}\n\n` +
      `Showing one card per nomination below\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    for (const gn of entries) {
      const names = gn.awards.length > 0
        ? gn.awards.map(a => a.recipient_name)
        : [gn.nominee_name];
      const recipients = names.map(n => e(n)).join(', ');
      const msg =
        `🌟 ${bold(`W${e(String(toISOWeek(gn.week_number ?? 0)))}`)}\n` +
        `${e(gn.nominator_name)} → ${recipients}\n` +
        `_"${e(gn.message)}"_`;
      await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
    }
    await ctx.reply(
      `Use /firenotifications to send now, or they fire automatically Tue 10:15AM SGT\\.`,
      { parse_mode: 'MarkdownV2' }
    );
  } catch (err) {
    console.error('/pendingnotifications error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

// ---------------------------------------------------------------------------
// /dismissnotifications — admin only, mark all pending as notified without sending
// Use this to clear a backlog of old entries you don't want to fire
// ---------------------------------------------------------------------------

bot.command('dismissnotifications', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      await ctx.reply(`Sorry, this command is only available to admins\\.`, { parse_mode: 'MarkdownV2' });
      return;
    }
    const entries = await getApprovedUnnotifiedGoodNews();
    if (!entries.length) {
      await ctx.reply(`No pending good news notifications to dismiss\\.`, { parse_mode: 'MarkdownV2' });
      return;
    }
    await markGoodNewsNotified(entries.map(gn => gn.id));
    await ctx.reply(
      `🗑 ${bold(`Dismissed ${entries.length} pending notification${entries.length === 1 ? '' : 's'}`)}\n\n` +
      `They've been marked as sent without notifying anyone\\. Only new approvals from here on will fire\\.`,
      { parse_mode: 'MarkdownV2' }
    );
  } catch (err) {
    console.error('/dismissnotifications error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

// ---------------------------------------------------------------------------
// /setchangelog /clearchangelog /showchangelog — admin only, edit Friday recap announcement
// ---------------------------------------------------------------------------

bot.command('setchangelog', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      await ctx.reply(`Sorry, this command is only available to admins\\.`, { parse_mode: 'MarkdownV2' });
      return;
    }
    const text = ctx.match?.trim();
    if (!text) {
      await ctx.reply(
        `Usage: /setchangelog <message>\n\nThe message will appear in the next /testrecap and /firerecap, then auto\\-clear after broadcast\\.`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }
    await sheets.setChangelog(text, String(ctx.from?.id));
    await ctx.reply(`✅ Saved\\. Will appear in the next /testrecap and /firerecap\\.`, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error('/setchangelog error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

bot.command('clearchangelog', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      await ctx.reply(`Sorry, this command is only available to admins\\.`, { parse_mode: 'MarkdownV2' });
      return;
    }
    await sheets.clearChangelog();
    await ctx.reply(`✅ Changelog cleared\\.`, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error('/clearchangelog error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

bot.command('showchangelog', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      await ctx.reply(`Sorry, this command is only available to admins\\.`, { parse_mode: 'MarkdownV2' });
      return;
    }
    const cl = await sheets.getChangelog();
    if (!cl?.text) {
      await ctx.reply(`No changelog set\\.`, { parse_mode: 'MarkdownV2' });
      return;
    }
    const updatedAt = cl.updated_at ? new Date(cl.updated_at).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' }) : 'unknown';
    await ctx.reply(
      `📣 ${bold('Current changelog:')}\n\n${e(cl.text)}\n\n${italic(`Last updated: ${updatedAt}`)}`,
      { parse_mode: 'MarkdownV2' }
    );
  } catch (err) {
    console.error('/showchangelog error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

// ---------------------------------------------------------------------------
// /testnotification — admin only, preview both notification messages to yourself
// Uses the first pending unnotified entry, or a sample if none exist
// ---------------------------------------------------------------------------

bot.command('testnotification', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      await ctx.reply(`Sorry, this command is only available to admins\\.`, { parse_mode: 'MarkdownV2' });
      return;
    }
    const adminChatId = ctx.from.id;

    const entries = await getApprovedUnnotifiedGoodNews();
    let nominator, nominee, message, pts, nominatorPts;

    if (entries.length > 0) {
      const gn = entries[0];
      nominator = gn.nominator_name;
      const firstAward = gn.awards[0];
      nominee = firstAward?.recipient_name ?? gn.nominee_name;
      pts = firstAward?.pts ?? 3;
      message = gn.message;
      nominatorPts = gn.pts_sharer ?? 5;
    } else {
      nominator = 'Wilson Tan';
      nominee = 'Sarah Lim';
      pts = 3;
      nominatorPts = 5;
      message = 'She went above and beyond helping the new team members settle in this week — really showed care and initiative!';
    }

    await ctx.reply(`${italic('Preview — nominee receives:')}\n​`, { parse_mode: 'MarkdownV2' });

    const nomineeMsg =
      `🌟 ${bold('Good News Shoutout!')}\n\n` +
      `${e(nominator)} shared good news about you:\n\n` +
      `_"${e(message)}"_\n\n` +
      `You've earned \\+${e(String(pts))} pts 🎉`;
    await bot.api.sendMessage(adminChatId, nomineeMsg, { parse_mode: 'MarkdownV2' });

    await ctx.reply(`${italic('Preview — nominator receives:')}\n​`, { parse_mode: 'MarkdownV2' });

    const nominatorMsg =
      `✅ ${bold('Your Good News was Approved!')}\n\n` +
      `Your shoutout about ${e(nominee)} went through\\!\n\n` +
      `You've earned \\+${e(String(nominatorPts))} pts 🌟`;
    await bot.api.sendMessage(adminChatId, nominatorMsg, { parse_mode: 'MarkdownV2' });

    const source = entries.length > 0 ? `\\(using real entry from ${e(nominator)}\\)` : `\\(sample data — no pending entries\\)`;
    await ctx.reply(`That's what they'll see\\. ${source}`, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error('/testnotification error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

// ---------------------------------------------------------------------------
// /firenotifications — admin only, send pending good news notifications now
// ---------------------------------------------------------------------------

bot.command('firenotifications', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      await ctx.reply(`Sorry, this command is only available to admins\\.`, { parse_mode: 'MarkdownV2' });
      return;
    }
    const entries = await getApprovedUnnotifiedGoodNews();
    if (!entries.length) {
      await ctx.reply(`No pending good news notifications right now\\.`, { parse_mode: 'MarkdownV2' });
      return;
    }
    await ctx.reply(
      `📨 Sending ${e(String(entries.length))} good news notification${entries.length === 1 ? '' : 's'}\\.\\.\\. `,
      { parse_mode: 'MarkdownV2' }
    );
    const { sent, noChat } = await sendGoodNewsNotifications();
    const sentLines = sent.map(s => `• ${e(s.name)} \\(from ${e(s.fromName)}, \\+${e(String(s.pts))} pts\\)`);
    const noChatLines = noChat.map(n => `• ${e(n)}`);
    const summaryHeader = `✅ Done\\!\n\n`;
    const summaryParts = [];
    if (sentLines.length) summaryParts.push(`Notified:\n` + sentLines.join('\n'));
    if (noChatLines.length) summaryParts.push(`No Telegram \\(not reached\\):\n` + noChatLines.join('\n'));
    const summaryBody = summaryParts.join('\n\n');
    const pages = paginateLines(summaryBody.split('\n'), 0);
    await ctx.reply(summaryHeader + pages[0], { parse_mode: 'MarkdownV2' });
    for (let i = 1; i < pages.length; i++) {
      await ctx.reply(pages[i], { parse_mode: 'MarkdownV2' });
    }
  } catch (err) {
    console.error('/firenotifications error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

// ---------------------------------------------------------------------------
// /testshoutout — admin only, sends a dept 100% shoutout to yourself
// Usage: /testshoutout [Department Name]
// ---------------------------------------------------------------------------

bot.command('testshoutout', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      await ctx.reply(`Sorry, this command is only available to admins\\.`, { parse_mode: 'MarkdownV2' });
      return;
    }

    const chatId = ctx.from?.id;
    const username = ctx.from?.username?.toLowerCase();
    const user = await lookupUser(chatId, username);
    if (!user?.realName) {
      await ctx.reply(`You're not in the system yet\\. Text @whalewhalewhalee to get added\\! 🌱`, { parse_mode: 'MarkdownV2' });
      return;
    }

    const dept = ctx.message?.text?.split(' ').slice(1).join(' ').trim() || user.department;
    if (!dept) { await ctx.reply('No department found.'); return; }

    const rawCache = await sheets.getRawStatsCache();
    const deptMembers = rawCache.sorted.filter(s => s.department === dept);
    if (!deptMembers.length) {
      await ctx.reply(`No members found for "${dept}".`);
      return;
    }

    const memberNames = await Promise.all(
      deptMembers.map(async m => {
        const nick = await sheets.getNickname(m.realName);
        return nick ?? m.realName;
      })
    );
    const nameList = memberNames.join(', ');

    const msg = `🎉 ${e(dept)}'s at 100% this week\\! ${e(nameList)} — what a team 🌿💧`;
    await bot.api.sendMessage(chatId, msg, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error('/testshoutout error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

// ---------------------------------------------------------------------------
// /broadcast — admin only, send a message to all registered users (or one person)
//
// Usage:
//   /broadcast all <message>     — sends to everyone registered
//   /broadcast me <message>      — sends only to yourself (test before bulk)
//   /broadcast <Name> <message>  — sends to one person by real name
// ---------------------------------------------------------------------------

bot.command('broadcast', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      await ctx.reply('Sorry, this command is only available to admins.');
      return;
    }

    const args = (ctx.message?.text ?? '').slice('/broadcast'.length).trim();
    if (!args) {
      await ctx.reply(
        'Usage:\n' +
        '/broadcast all <message> — send to everyone\n' +
        '/broadcast me <message> — send to yourself (test)\n' +
        '/broadcast <Name> <message> — send to one person'
      );
      return;
    }

    const spaceIdx = args.indexOf(' ');
    const firstWord = spaceIdx === -1 ? args : args.slice(0, spaceIdx);
    const rest = spaceIdx === -1 ? '' : args.slice(spaceIdx + 1).trim();

    // /broadcast me <message>
    if (firstWord.toLowerCase() === 'me') {
      if (!rest) { await ctx.reply('Please include a message after "me".'); return; }
      await bot.api.sendMessage(ctx.from.id, rest);
      await ctx.reply('✅ Sent to you.');
      return;
    }

    // /broadcast all <message>
    if (firstWord.toLowerCase() === 'all') {
      if (!rest) { await ctx.reply('Please include a message after "all".'); return; }
      const users = await sheets.getAllUsersWithChatId();
      let sent = 0, failed = 0;
      for (const { realName, chatId } of users) {
        try {
          await bot.api.sendMessage(chatId, rest);
          sent++;
        } catch (err) {
          console.error(`[Broadcast] Failed to send to ${realName}:`, err.message);
          failed++;
        }
        await new Promise(r => setTimeout(r, 200));
      }
      await ctx.reply(`✅ Broadcast complete — sent to ${sent} user${sent !== 1 ? 's' : ''}${failed ? `, ${failed} failed` : ''}.`);
      return;
    }

    // /broadcast <Name> <message> — try matching 3, 2, or 1 words as a real name
    const words = args.split(' ');
    let targetUser = null;
    let msgStart = 0;
    for (let n = Math.min(3, words.length - 1); n >= 1; n--) {
      const candidate = words.slice(0, n).join(' ');
      const found = await sheets.getUserByRealName(candidate);
      if (found?.chatId) {
        targetUser = found;
        msgStart = n;
        break;
      }
    }
    if (!targetUser) {
      await ctx.reply(`Couldn't find that person in the system. Check the spelling matches their real name, or use /broadcast all or /broadcast me.`);
      return;
    }
    const message = words.slice(msgStart).join(' ').trim();
    if (!message) { await ctx.reply('Please include a message after the name.'); return; }
    await bot.api.sendMessage(targetUser.chatId, message);
    await ctx.reply(`✅ Sent to ${targetUser.realName}.`);
  } catch (err) {
    console.error('/broadcast error:', err);
    await ctx.reply('Something went wrong. Try again or check the server logs.');
  }
});

// ---------------------------------------------------------------------------
// /grantaccess /revokeaccess /listaccess — admin only, manage dashboard access
// ---------------------------------------------------------------------------

bot.command('grantaccess', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Admin only.');
  // Usage: /grantaccess 123456789 John
  const args = (ctx.message?.text ?? '').slice('/grantaccess'.length).trim().split(/\s+/);
  const userId = args[0];
  const name = args.slice(1).join(' ');
  if (!userId || !name) return ctx.reply('Usage: /grantaccess <user_id> <name>\n\nTo get someone\'s Telegram user ID, have them message @userinfobot.');
  try {
    await grantDashboardAccess(userId, name, String(ctx.from.id));
    await ctx.reply(`✅ Dashboard access granted to ${name} (${userId}).`);
  } catch (err) {
    console.error('/grantaccess error:', err);
    await ctx.reply('Something went wrong. Check the logs.');
  }
});

bot.command('revokeaccess', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Admin only.');
  // Usage: /revokeaccess 123456789
  const userId = (ctx.message?.text ?? '').slice('/revokeaccess'.length).trim();
  if (!userId) return ctx.reply('Usage: /revokeaccess <user_id>');
  try {
    await revokeDashboardAccess(userId);
    await ctx.reply(`✅ Dashboard access revoked for user ${userId}.`);
  } catch (err) {
    console.error('/revokeaccess error:', err);
    await ctx.reply('Something went wrong. Check the logs.');
  }
});

bot.command('listaccess', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Admin only.');
  try {
    const rows = await listDashboardAccess();
    const envIds = [
      ...(process.env.ADMIN_CHAT_IDS ?? '').split(','),
      ...(process.env.LEADERSHIP_CHAT_IDS ?? '').split(','),
    ].map(id => id.trim()).filter(Boolean);

    let msg = '*Dashboard Access List*\n\n';
    if (envIds.length) msg += `_Env vars \\(edit in Railway\\):_\n${envIds.map(id => `• ${id}`).join('\n')}\n\n`;
    if (rows.length) {
      msg += `_Granted via bot:_\n${rows.map(r => `• ${r.name.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&')} — ${r.user_id}`).join('\n')}`;
    } else {
      msg += '_No users granted via bot yet\\._';
    }
    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error('/listaccess error:', err);
    await ctx.reply('Something went wrong. Check the logs.');
  }
});

// ---------------------------------------------------------------------------
// /grantmanager /revokemanager /listmanagers — admin only, manage manager access
// ---------------------------------------------------------------------------

bot.command('grantmanager', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Admin only.');
  const userId = (ctx.message?.text ?? '').slice('/grantmanager'.length).trim();
  if (!userId) return ctx.reply('Usage: /grantmanager <user_id>\n\nExample: /grantmanager 123456789\n\nTo get a Telegram user ID, have them message @userinfobot.');
  try {
    const user = await getUserByChatId(userId);
    if (!user) return ctx.reply(`❌ No user found with Telegram ID ${userId}. Make sure they've started the bot first.`);
    await addManager(userId, user.realName, user.department, user.secondaryDepartment);
    const deptLabel = user.secondaryDepartment
      ? `${user.department} + ${user.secondaryDepartment} departments`
      : `${user.department} department`;
    await ctx.reply(`✅ ${user.realName} granted manager access for the ${deptLabel}.`);
  } catch (err) {
    console.error('/grantmanager error:', err);
    await ctx.reply('Something went wrong. Check the logs.');
  }
});

bot.command('revokemanager', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Admin only.');
  // Usage: /revokemanager <user_id>
  const userId = (ctx.message?.text ?? '').slice('/revokemanager'.length).trim();
  if (!userId) return ctx.reply('Usage: /revokemanager <user_id>');
  try {
    await removeManager(userId);
    await ctx.reply(`✅ Manager access revoked for user ${userId}.`);
  } catch (err) {
    console.error('/revokemanager error:', err);
    await ctx.reply('Something went wrong. Check the logs.');
  }
});

bot.command('listmanagers', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Admin only.');
  try {
    const rows = await listManagers();
    if (!rows.length) return ctx.reply('No managers granted yet.');
    const lines = rows.map(r => {
      const name = r.real_name.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
      const depts = [r.department, r.secondary_department].filter(Boolean).map(d => d.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&')).join(' \\+ ');
      return `• ${name} \\(${depts}\\) — ${r.telegram_id}`;
    }).join('\n');
    await ctx.reply(`*Manager Access List*\n\n${lines}`, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error('/listmanagers error:', err);
    await ctx.reply('Something went wrong. Check the logs.');
  }
});

// ---------------------------------------------------------------------------
// /testmystats — admin only, preview any user's /mystats output (useful for dual-dept LT/Core Team)
// ---------------------------------------------------------------------------

bot.command('testmystats', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Admin only.');
  const name = (ctx.message?.text ?? '').slice('/testmystats'.length).trim();
  if (!name) return ctx.reply('Usage: /testmystats <Real Name>\n\nExample: /testmystats Wilson Tan');
  try {
    const user = await getUserByRealName(name);
    if (!user) return ctx.reply(`❌ "${name}" not found. Check the spelling matches the users table exactly.`);

    const [stats, allUsers, displayName] = await Promise.all([
      sheets.getStatsForUser(user.realName),
      sheets.getAllUsersWithChatId(),
      getDisplayName(user.realName),
    ]);
    const weekNum = getWeekNumber();
    const totalUsers = allUsers.length;

    const deptLine = [user.department, user.secondaryDepartment].filter(Boolean).join(' + ');
    let msg = `${bold('Preview: /mystats for')} ${e(displayName)}\n${italic(deptLine)} · Week ${toISOWeek(weekNum)}\n\n`;

    if (!stats) {
      msg +=
        `Plant ▸ 🌱 Seedling · 0 pts\n` +
        `Next ▸ ${mono('○○○○○○○○○○')} 21 pts to 🌿\n\n` +
        `🔥 Streak ▸ None \\(0 weeks\\)\n` +
        `❌ Not submitted yet this week\n\n` +
        `Ready to plant your first seed? /reflect 💧`;
    } else {
      msg += buildPlantCard(
        stats.plantStage, stats.progressPct, stats.streak, stats.submittedThisWeek,
        stats.totalPoints ?? 0, stats.consecutiveMisses ?? 0,
        stats.rank || null, totalUsers || null
      );
      if (stats.weeklyBreakdown?.length) {
        msg += buildWeeklyBreakdown(stats);
      }
    }

    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error('/testmystats error:', err);
    await ctx.reply('Something went wrong. Check the logs.');
  }
});

// ---------------------------------------------------------------------------
// /dashboard — admin + leadership, get live stats summary + dashboard link
// ---------------------------------------------------------------------------

function currentQ2Week() {
  return getWeekNumber();
}

bot.command('dashboard', async (ctx) => {
  try {
    const dashUrl = process.env.DASHBOARD_URL ?? 'Not configured — set DASHBOARD_URL in .env';

    // Managers just get the link — they'll see their dept view after logging in
    const managerRecord = await getManager(ctx.from?.id);
    if (managerRecord) {
      await ctx.reply(`📊 Your department dashboard:\n👉 ${dashUrl}`);
      return;
    }

    if (!isLeadershipOrAdmin(ctx)) {
      await ctx.reply('Sorry, this command is only available to the leadership team.');
      return;
    }

    const [registeredUsers, deptStats] = await Promise.all([
      sheets.getAllUsersWithChatId(),
      sheets.getAllDeptStats(),
    ]);

    // Get submission stats (all hit the same 30s cache after first call)
    const allStats = await Promise.all(
      registeredUsers.map(u => sheets.getStatsForUser(u.realName))
    );
    const validStats = allStats.filter(Boolean);
    const submittedCount = validStats.filter(s => s.submittedThisWeek).length;
    const totalCount = validStats.length;
    const rateThisWeek = totalCount ? Math.round((submittedCount / totalCount) * 100) : 0;

    const topDept = deptStats
      .sort((a, b) => b.avgPoints - a.avgPoints)[0];

    const weekNum = currentQ2Week();
    const onTrack = rateThisWeek >= 90 ? '✅ On track' : rateThisWeek >= 70 ? '⚠️ Behind' : '❌ Needs attention';

    await ctx.reply(
      `📊 TC CultivAIte Dashboard — Week ${toISOWeek(weekNum)}\n\n` +
      `This week: ${rateThisWeek}% submitted (${submittedCount}/${totalCount})\n` +
      `Top dept: ${topDept?.department ?? 'N/A'} 🥇 (${topDept?.avgPoints ?? 0} avg pts)\n` +
      `Target 90%: ${onTrack}\n\n` +
      `👉 Full dashboard: ${dashUrl}`
    );
  } catch (err) {
    console.error('/dashboard error:', err);
    await ctx.reply('Something went wrong fetching stats. Try again in a moment.');
  }
});

// ---------------------------------------------------------------------------
// /mystats
// ---------------------------------------------------------------------------

bot.command('mystats', async (ctx) => {
  try {
    const chatId = ctx.from?.id;
    const username = ctx.from?.username?.toLowerCase();
    const user = await lookupUser(chatId, username);

    if (!user?.realName) {
      await ctx.reply(
        `Hey\\! 👋 You're not in our system yet\\.\nText @whalewhalewhalee to get added\\! 🌱`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    const [stats, allUsers, displayName] = await Promise.all([
      sheets.getStatsForUser(user.realName),
      sheets.getAllUsersWithChatId(),
      getDisplayName(user.realName),
    ]);
    const weekNum = getWeekNumber();
    const totalUsers = allUsers.length;

    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Singapore' }));
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const dd = now.getDate();
    const yyyy = now.getFullYear();
    const todayStr = `${dd} ${months[now.getMonth()]} ${yyyy}`;

    let msg = `${e(todayStr)} \\(Week ${toISOWeek(weekNum)}\\)\n\n`;

    if (!stats) {
      msg +=
        `Plant ▸ 🌱 Seedling · 0 pts\n` +
        `Next ▸ ${mono('○○○○○○○○○○')} 21 pts to 🌿\n\n` +
        `🔥 Streak ▸ None \\(0 weeks\\)\n` +
        `❌ Not submitted yet this week\n\n` +
        `Ready to plant your first seed? /reflect 💧`;
    } else {
      msg += buildPlantCard(
        stats.plantStage, stats.progressPct, stats.streak, stats.submittedThisWeek,
        stats.totalPoints ?? 0, stats.consecutiveMisses ?? 0,
        stats.rank || null, totalUsers || null
      );
      if (stats.weeklyBreakdown?.length) {
        msg += buildWeeklyBreakdown(stats);
      }
      if (!stats.submittedThisWeek) {
        msg += `\n\nYour plant is thirsty\\! 💧 /reflect to water it\\.`;
      }
    }

    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error('/mystats error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

// ---------------------------------------------------------------------------
// /myreflections
// ---------------------------------------------------------------------------

bot.command('myreflections', async (ctx) => {
  try {
    const chatId = ctx.from?.id;
    const username = ctx.from?.username?.toLowerCase();
    const user = await lookupUser(chatId, username);

    if (!user?.realName) {
      await ctx.reply(
        `Hey\\! 👋 You're not in our system yet\\.\nText @whalewhalewhalee to get added\\! 🌱`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    const submissions = await sheets.getSubmissionsForUser(user.realName, 50);

    if (!submissions.length) {
      await ctx.reply(
        `Nothing here yet\\! 🌱 Once you start reflecting, they'll all show up here\\.\n\nReady to begin? /reflect`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    const ordered = [...submissions].reverse(); // newest first = #1
    let msg = `📋 ${bold('Your Reflections')}\n\n`;
    ordered.forEach((sub, i) => {
      msg += `/${i + 1} · ${e(sub.date)}\n`;
    });
    msg += `\n${italic('Type /1, /2 etc. to read a reflection.')}`;

    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error('/myreflections error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

// ---------------------------------------------------------------------------
// /1, /2, /3 ... — read a specific reflection (used after /myreflections)
// ---------------------------------------------------------------------------

bot.hears(/^\/(\d+)$/, async (ctx) => {
  try {
    const n = parseInt(ctx.match[1], 10);
    if (n < 1 || n > 50) return; // ignore out-of-range or unrelated numeric commands

    const chatId = ctx.from?.id;
    const username = ctx.from?.username?.toLowerCase();
    const user = await lookupUser(chatId, username);

    if (!user?.realName) return;

    const submissions = await sheets.getSubmissionsForUser(user.realName, 50);
    const ordered = [...submissions].reverse(); // newest first = #1

    if (n > ordered.length) {
      await ctx.reply(
        `You only have ${e(String(ordered.length))} reflection${ordered.length !== 1 ? 's' : ''} so far\\. Try a lower number\\.`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    const sub = ordered[n - 1];
    let msg =
      `📋 ${bold(`Reflection #${n}`)} — ${e(sub.date)}\n\n` +
      `${bold('Q1')} ${italic(sub.q1)}\n\n` +
      `${bold('Q2')} ${italic(sub.q2)}\n\n`;

    const q3Clean = cleanQ3(sub.q3);
    if (q3Clean) {
      msg += `${bold('Q3')} ${italic(q3Clean)}`;
    } else {
      msg += `${bold('Q3')} ${italic('—')}`;
    }

    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error('/N reflection lookup error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

// ---------------------------------------------------------------------------
// /editreflection
// ---------------------------------------------------------------------------

bot.command('editreflection', async (ctx) => {
  try {
    await ctx.conversation.enter('editReflectionConversation');
  } catch (err) {
    console.error('/editreflection error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

// ---------------------------------------------------------------------------
// /editgoodnews
// ---------------------------------------------------------------------------

bot.command('editgoodnews', async (ctx) => {
  try {
    await ctx.conversation.enter('editGoodNewsConversation');
  } catch (err) {
    console.error('/editgoodnews error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

// ---------------------------------------------------------------------------
// /tutorial
// ---------------------------------------------------------------------------

bot.command('tutorial', async (ctx) => {
  await ctx.reply(
    `📖 ${bold('How TC CultivAIte Works')}\n\n` +

    `🍎 Everyone starts off with one of these: 🌱 — as you /reflect every week, earn points and watch the plant grow with you\\!\n\n` +

    `${bold('⭐️ Earning Points')}\n` +
    `• Reflect each week ▸ ${bold('10 pts')}\n` +
    `• Streak bonus ▸ ${bold('+1 pt')} for each consecutive week\n` +
    `  ${italic('(week 3 of a streak = 12 pts)')}\n` +
    `• Share good news ▸ ${bold('+5 pts')} ${italic('(admin-reviewed — both you and the person you shout out earn pts!)')}\n\n` +

    `${bold('🏆 Department Points')}\n` +
    `• Dept score \\= average of all members' pts\n` +
    `• Everyone in your dept submits 4 weeks in a row → ${bold('2× pts')} for everyone that week\\!\n\n` +

    `${bold('🪴 Plant Stages')}\n` +
    `🌱 Seedling ▸ 0–20 pts\n` +
    `🌿 Sprout ▸ 21–50 pts\n` +
    `🌳 Sapling ▸ 51–85 pts\n` +
    `🌼 Flowering ▸ 86–115 pts\n` +
    `🍎 Fruiting ▸ 116\\+ pts\n\n` +

    `${bold('🍂 If You Miss a Week')}\n` +
    `• Miss 1 week ▸ plant goes 🍂 Dying\n` +
    `• Miss 2\\+ weeks ▸ plant goes 🥀 Dead\n` +
    `• ${italic('Your pts never decrease — reflect to revive your plant!')}\n\n` +

    `${bold('💧 Streak Bonus')}\n` +
    `• Each consecutive week you reflect adds a 💧\n` +
    `• Longer streak \\= bigger pts bonus per week\n\n` +

    `Type /help for a list of all the commands available to you\\!\n\n` +

    `${italic('Reflect weekly. Grow together. 🌱')}`,
    { parse_mode: 'MarkdownV2' }
  );
});

// ---------------------------------------------------------------------------
// /setgoal
// ---------------------------------------------------------------------------

bot.command('setgoal', async (ctx) => {
  try {
    await ctx.conversation.enter('setGoalConversation');
  } catch (err) {
    console.error('/setgoal error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

// ---------------------------------------------------------------------------
// /nick
// ---------------------------------------------------------------------------

bot.command('nick', async (ctx) => {
  try {
    await ctx.conversation.enter('setNicknameConversation');
  } catch (err) {
    console.error('/nick error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------

bot.command('help', async (ctx) => {
  let msg =
    `🌱 ${bold('TC CultivAIte')}\n` +
    `${italic('Your Q2 reflection companion')}\n\n` +
    `/reflect — 💧 Submit your weekly reflection\n` +
    `/goodnews — ⭐️ Share an adhoc shoutout about a teammate\n` +
    `/mystats — 🌿 Check your plant, pts & streak\n` +
    `/setgoal — 🎯 Set or update your Q2 goal\n` +
    `/nick — 🏷 Set or update your nickname\n` +
    `/department — 🌳 See your department garden\n` +
    `/leaderboard — 🏆 Top 5 individuals \\+ company garden\n` +
    `/deptleaderboard — 🌳 See all departments ranked by pts\n` +
    `/tutorial — 📖 How points and stages work\n` +
    `/myreflections — 📋 List your past reflections\n` +
    `/1, /2\\.\\.\\. — 📖 Read a specific reflection\n` +
    `/editreflection — ✏️ Update your most recent reflection \\(Q1, Q2, or Q3 good news\\)\n` +
    `/editgoodnews — ✏️ Edit your most recent Pending good news submission\n` +
    `/cancel — ❌ Cancel whatever's in progress\n` +
    `/help — Show this message\n`;

  if (isAdmin(ctx)) {
    msg +=
      `\n${bold('Admin')}\n` +
      `/skipweek — 🗓 Excuse a user for a week \\(e\\.g\\. W${toISOWeek(getWeekNumber())}\\)\n` +
      `/testnudge — 🔔 Preview the Monday morning nudge\n` +
      `  • /testnudge wilson — send to a specific person\n` +
      `/test1hwarning — ⏳ Preview the Monday 3PM 1\\-hour warning\n` +
      `  • /test1hwarning wilson — send to a specific person\n` +
      `/testdeadlinenudge — ⏰ Preview the Monday 4PM deadline\\-over nudge\n` +
      `  • /testdeadlinenudge wilson — send to a specific person\n` +
      `/cancelnudge — 🚫 Abort the upcoming 4PM deadline nudge \\(use after the 3:55PM preview if needed\\)\n` +
      `/testrecap — 📊 Preview the weekly recap message\n` +
      `/firerecap — 🚀 Send the weekly recap to everyone now\n` +
      `/pendingnotifications — 📋 List what good news is queued to send\n` +
      `/dismissnotifications — 🗑 Mark all pending as sent without notifying \\(clears backlog\\)\n` +
      `/testnotification — 👀 Preview both notification messages to yourself\n` +
      `/firenotifications — 📨 Send pending good news notifications now\n` +
      `/setchangelog \\<msg\\> — 📣 Set the announcement block in Friday's recap\n` +
      `/showchangelog — 👀 Preview the current changelog\n` +
      `/clearchangelog — 🗑 Clear the current changelog\n` +
      `/testshoutout — 🎉 Preview first\\-dept\\-100% shoutout \\(only fires once per week\\)\n` +
      `  • /testshoutout Marketing — preview for a specific dept\n` +
      `/broadcast — 📣 Send a message to all or one user\n` +
      `  • /broadcast me \\<msg\\> — test send to yourself\n` +
      `  • /broadcast all \\<msg\\> — send to everyone\n` +
      `  • /broadcast \\<Name\\> \\<msg\\> — send to one person\n` +
      `/dashboard — 📊 Live stats summary \\+ dashboard link\n` +
      `  • Add \\?preview\\=manager\\&dept\\=DEPT to the URL to open a specific dept view\n` +
      `/grantaccess \\<id\\> \\<name\\> — 🔑 Grant dashboard access\n` +
      `/revokeaccess \\<id\\> — 🚫 Revoke dashboard access\n` +
      `/listaccess — 👥 View who has dashboard access\n` +
      `/grantmanager \\<id\\> — 👔 Grant manager view \\(name \\+ dept auto\\-detected\\)\n` +
      `/revokemanager \\<id\\> — 🚫 Revoke manager access\n` +
      `/listmanagers — 👥 View all dept managers\n` +
      `/testmystats \\<name\\> — 🌿 Preview any user's /mystats \\(incl\\. dual\\-dept\\)\n` +
      `\n${bold('Automations')}\n` +
      `Mon 9:30AM SGT — Pre\\-flight count to admins before 10AM nudge\n` +
      `Mon 10AM SGT — Morning nudge to non\\-submitters\n` +
      `Mon 2:30PM SGT — Pre\\-flight count to admins before 3PM warning\n` +
      `Mon 3PM SGT — 1\\-hour warning to non\\-submitters\n` +
      `Mon 3:30PM SGT — Pre\\-flight preview \\+ recipient list to admins \\(cancel with /cancelnudge\\)\n` +
      `Mon 4PM SGT — Deadline\\-over nudge to non\\-submitters\n` +
      `Fri 10AM SGT — Recap reminder to admins\n` +
      `Fri 3:30PM SGT — Weekly recap to everyone \\(skips if already sent via /firerecap\\)\n` +
      `Tue 9:30AM SGT — Good news notification preview to admins \\(45 min before send\\)\n` +
      `Tue 10:15AM SGT — Good news notifications to nominees \\+ nominators\n` +
      `On submit — Dept 100% shoutout \\(first dept to hit 100% that week\\)\n`;
  }

  msg += `\n${italic('Reflect weekly. Grow together.')}`;

  await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
});

// ---------------------------------------------------------------------------
// /cancel
// ---------------------------------------------------------------------------

bot.command('cancel', async (ctx) => {
  await ctx.conversation.exit();
  await ctx.reply(`No worries\\. Come back and /reflect whenever you're ready\\. 🌱`, { parse_mode: 'MarkdownV2' });
});

// ---------------------------------------------------------------------------
// /start
// ---------------------------------------------------------------------------

bot.command('start', async (ctx) => {
  try {
    const chatId = ctx.from?.id;
    const username = ctx.from?.username?.toLowerCase();
    const user = await lookupUser(chatId, username);
    const nick = user?.realName
      ? await sheets.getNickname(user.realName) ?? user.realName
      : null;
    const greeting = nick ? `Hey ${e(nick)}\\!` : `Hey\\!`;

    await ctx.reply(
      `Hey there\\! 🤟 Heard you're ${bold(user?.realName ?? 'you')} — ready to grow this quarter? I'm here to help you out\\!\n\n` +
      `🌱 ▸ This is your plant, and the goal is for it to bear many fruits 🍎\\! Water it weekly with a /reflect and watch it grow with you\\! 🌳\n\n` +
      `Type /tutorial for a quick crash course, /help to explore all the commands available to you\\! 🙂`,
      { parse_mode: 'MarkdownV2' }
    );
    await ctx.conversation.enter('setupConversation');
  } catch (err) {
    console.error('/start error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
  }
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

bot.catch((err) => {
  console.error('Unhandled bot error:', err);
  err.ctx?.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!').catch(() => {});
});

// ---------------------------------------------------------------------------
// Monday nudge cron — 10:00 AM SGT = 02:00 UTC, every Monday
// ---------------------------------------------------------------------------

cron.schedule('0 2 * * 1', async () => {
  if (currentQ2Week() === 1) {
    console.log('[Cron] Skipping nudge — Week 1 launch week.');
    return;
  }
  shoutedDepts.clear();
  firstShoutoutFiredThisWeek = false;
  console.log('[Cron] Running Monday nudge...');
  try {
    const users = await sheets.getAllUsersWithChatId();
    for (const { realName, chatId, nickname } of users) {
      try {
        const stats = await sheets.getStatsForUser(realName);
        if (stats && stats.submittedThisWeek === false) {
          const displayName = nickname ?? realName;
          const { nextEmoji, ptsNeeded } = getNextStageInfo(stats.plantStage, stats.totalPoints);

          let nudgeMsg;
          if (stats.consecutiveMisses >= 1) {
            nudgeMsg = `Hey ${e(displayName)}\\! Your plant's looking a bit dry 🍂 — /reflect today to bring it back\\! Deadline 4PM\\.`;
          } else if (nextEmoji && ptsNeeded > 0 && ptsNeeded <= 10) {
            nudgeMsg = `Hey ${e(displayName)}\\! You're just ${e(String(ptsNeeded))} pts from reaching ${nextEmoji} — /reflect to keep growing\\! Deadline 4PM\\.`;
          } else if (stats.streak >= 2) {
            nudgeMsg = `Hey ${e(displayName)}\\! You're on a ${e(String(stats.streak))}\\-week streak 🔥 — /reflect today to keep it alive\\! Deadline 4PM\\.`;
          } else {
            nudgeMsg = `Hey ${e(displayName)}\\! Your ${stats.plantStage} is waiting for water — /reflect on your week\\! Deadline 4PM\\.`;
          }

          await bot.api.sendMessage(chatId, nudgeMsg, { parse_mode: 'MarkdownV2' });
          await new Promise(r => setTimeout(r, 200));
        }
      } catch (userErr) {
        console.error(`[Cron] Failed to nudge ${realName}:`, userErr.message);
      }
    }
    console.log('[Cron] Monday nudge complete.');
  } catch (err) {
    console.error('[Cron] Nudge error:', err);
  }
}, { timezone: 'UTC' });

// ---------------------------------------------------------------------------
// Monday 3PM 1-hour warning cron — 3:00 PM SGT = 07:00 UTC, every Monday
// ---------------------------------------------------------------------------

cron.schedule('0 7 * * 1', async () => {
  if (currentQ2Week() === 1) return;
  console.log('[Cron] Running 3PM 1-hour warning...');
  try {
    const users = await sheets.getAllUsersWithChatId();
    for (const { realName, chatId, nickname } of users) {
      try {
        const stats = await sheets.getStatsForUser(realName);
        if (stats && stats.submittedThisWeek === false) {
          const dn = e(nickname ?? realName);
          const msg = `Hey ${dn}\\! ⏰ 1 hour left to /reflect before the deadline\\! Don't let your streak slip 🌱`;
          await bot.api.sendMessage(chatId, msg, { parse_mode: 'MarkdownV2' });
          await new Promise(r => setTimeout(r, 200));
        }
      } catch (userErr) {
        console.error(`[Cron] Failed to send 1h warning to ${realName}:`, userErr.message);
      }
    }
    console.log('[Cron] 3PM 1-hour warning complete.');
  } catch (err) {
    console.error('[Cron] 3PM 1-hour warning error:', err);
  }
}, { timezone: 'UTC' });

// ---------------------------------------------------------------------------
// Monday pre-flight preview crons — heads-up to admins before nudges fire
// ---------------------------------------------------------------------------

// 9:30 AM SGT (01:30 UTC) — light count before 10 AM nudge
cron.schedule('30 1 * * 1', async () => {
  if (currentQ2Week() === 1) return;
  const adminIds = (process.env.ADMIN_CHAT_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean);
  if (!adminIds.length) return;
  try {
    const users = await sheets.getAllUsersWithChatId();
    let count = 0;
    for (const { realName } of users) {
      const stats = await sheets.getStatsForUser(realName);
      if (stats && stats.submittedThisWeek === false) count++;
    }
    const msg = count === 0
      ? `✅ 10AM nudge fires in 5 min — everyone has already submitted this week\\.`
      : `👋 10AM nudge fires in 30 min — ${e(String(count))} ${count === 1 ? "person hasn't" : "people haven't"} submitted yet\\.`;
    for (const adminId of adminIds) {
      try { await bot.api.sendMessage(adminId, msg, { parse_mode: 'MarkdownV2' }); } catch {}
    }
  } catch (err) { console.error('[Cron] 10AM preview error:', err); }
}, { timezone: 'UTC' });

// 2:30 PM SGT (06:30 UTC) — light count before 3 PM warning
cron.schedule('30 6 * * 1', async () => {
  if (currentQ2Week() === 1) return;
  const adminIds = (process.env.ADMIN_CHAT_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean);
  if (!adminIds.length) return;
  try {
    const users = await sheets.getAllUsersWithChatId();
    let count = 0;
    for (const { realName } of users) {
      const stats = await sheets.getStatsForUser(realName);
      if (stats && stats.submittedThisWeek === false) count++;
    }
    const msg = count === 0
      ? `✅ 3PM 1\\-hour warning fires in 5 min — everyone has already submitted\\.`
      : `⏰ 3PM 1\\-hour warning fires in 30 min — ${e(String(count))} ${count === 1 ? "person hasn't" : "people haven't"} submitted yet\\.`;
    for (const adminId of adminIds) {
      try { await bot.api.sendMessage(adminId, msg, { parse_mode: 'MarkdownV2' }); } catch {}
    }
  } catch (err) { console.error('[Cron] 3PM preview error:', err); }
}, { timezone: 'UTC' });

// 3:30 PM SGT (07:30 UTC) — full preview + names + cancel before 4PM deadline nudge
cron.schedule('30 7 * * 1', async () => {
  if (currentQ2Week() === 1) return;
  const adminIds = (process.env.ADMIN_CHAT_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean);
  if (!adminIds.length) return;
  cronAbortFlags.deadline = false; // reset each week so last week's cancel doesn't carry over
  try {
    const users = await sheets.getAllUsersWithChatId();
    const missed = [];
    for (const { realName, nickname } of users) {
      const stats = await sheets.getStatsForUser(realName);
      if (stats && stats.submittedThisWeek === false) missed.push(nickname ?? realName);
    }
    let msg;
    if (missed.length === 0) {
      msg = `✅ Deadline nudge fires in 5 min — everyone submitted this week, nothing to send\\.`;
    } else {
      const nameList = missed.map(n => `• ${e(n)}`).join('\n');
      msg =
        `⚠️ *Deadline nudge fires in 30 min*\n\n` +
        `${e(String(missed.length))} ${missed.length === 1 ? 'person' : 'people'} will receive:\n` +
        `_"Hey\\! This week's deadline has just passed 🌧️ — you can still /reflect and earn 5 pts\\!"_\n\n` +
        `${nameList}\n\n` +
        `Run /cancelnudge to abort\\.`;
    }
    for (const adminId of adminIds) {
      try { await bot.api.sendMessage(adminId, msg, { parse_mode: 'MarkdownV2' }); } catch {}
    }
  } catch (err) { console.error('[Cron] 3:55PM preview error:', err); }
}, { timezone: 'UTC' });

// ---------------------------------------------------------------------------
// Monday 4PM deadline cron — 4:00 PM SGT = 08:00 UTC, every Monday
// ---------------------------------------------------------------------------

cron.schedule('0 8 * * 1', async () => {
  // At exactly 4PM SGT the week counter flips to the NEW week.
  // We must check the just-CLOSED week (weekNow - 1), not weekNow.
  const weekNow = currentQ2Week();
  if (weekNow === 1) return;
  if (cronAbortFlags.deadline) {
    console.log('[Cron] 4PM deadline nudge aborted by /cancelnudge.');
    cronAbortFlags.deadline = false;
    return;
  }
  const closedWeek = weekNow - 1;
  console.log(`[Cron] Running 4PM deadline nudge for closed week ${closedWeek}...`);
  try {
    const users = await sheets.getAllUsersWithChatId();
    for (const { realName, chatId, nickname } of users) {
      try {
        const stats = await sheets.getStatsForUser(realName);
        const closedEntry = stats?.weeklyBreakdown?.find(w => w.week === closedWeek);
        // If no breakdown entry for that week (pre-launch or unregistered), skip.
        if (!closedEntry) continue;
        if (closedEntry.status === 'missed') {
          const dn = e(nickname ?? realName);
          const msg = `Hey ${dn}\\! This week's deadline has just passed 🌧️\n\nNo worries — you can still /reflect and earn 5 pts\\! Better late than never 🌱\n\nAny questions\\? Text @whalewhalewhalee\\.`;
          await bot.api.sendMessage(chatId, msg, { parse_mode: 'MarkdownV2' });
          await new Promise(r => setTimeout(r, 200));
        }
      } catch (userErr) {
        console.error(`[Cron] Failed to send deadline nudge to ${realName}:`, userErr.message);
      }
    }
    console.log('[Cron] 4PM deadline nudge complete.');
  } catch (err) {
    console.error('[Cron] 4PM deadline nudge error:', err);
  }
}, { timezone: 'UTC' });

// ---------------------------------------------------------------------------
// Good news notifications — shared by cron and /firenotifications
// ---------------------------------------------------------------------------

async function sendGoodNewsNotifications() {
  const entries = await getApprovedUnnotifiedGoodNews();
  if (!entries.length) return { sent: [], noChat: [], count: 0 };

  const sent = [];
  const noChat = [];

  for (const gn of entries) {
    const { nominator_name, message, pts_sharer, awards } = gn;
    const recipients = awards.length > 0 ? awards : [{ recipient_name: gn.nominee_name, pts: 3 }];

    // Notify each recipient (pts=0 = notify-only, no points line)
    for (const award of recipients) {
      const user = await getUserByRealName(award.recipient_name);
      if (!user?.chatId) { noChat.push(award.recipient_name); continue; }
      const notifyOnly = award.pts === 0;
      const msg = notifyOnly
        ? `🌟 ${bold('Good News Shoutout!')}\n\n` +
          `${e(nominator_name)} shared good news about you:\n\n` +
          `_"${e(message)}"_`
        : `🌟 ${bold('Good News Shoutout!')}\n\n` +
          `${e(nominator_name)} shared good news about you:\n\n` +
          `_"${e(message)}"_\n\n` +
          `You've earned \\+${e(String(award.pts))} pts 🎉`;
      try {
        await bot.api.sendMessage(user.chatId, msg, { parse_mode: 'MarkdownV2' });
        sent.push({ name: award.recipient_name, fromName: nominator_name, pts: award.pts });
      } catch (err) {
        console.error(`[GN notify] Failed → ${award.recipient_name}:`, err.message);
        noChat.push(award.recipient_name);
      }
    }

    // Notify nominator
    const nominatorUser = await getUserByRealName(nominator_name);
    if (nominatorUser?.chatId) {
      const names = recipients.map(a => a.recipient_name);
      const recipientList = names.length === 1
        ? e(names[0])
        : names.slice(0, -1).map(e).join(', ') + ' and ' + e(names.at(-1));
      const nominatorMsg =
        `✅ ${bold('Your Good News was Approved!')}\n\n` +
        `Your shoutout about ${recipientList} went through\\!\n\n` +
        `You've earned \\+${e(String(pts_sharer ?? 5))} pts 🌟`;
      try {
        await bot.api.sendMessage(nominatorUser.chatId, nominatorMsg, { parse_mode: 'MarkdownV2' });
      } catch (err) {
        console.error(`[GN notify] Failed → nominator ${nominator_name}:`, err.message);
      }
    }
  }

  await markGoodNewsNotified(entries.map(gn => gn.id));
  return { sent, noChat, count: entries.length };
}

// Recap broadcast — shared by cron, /firerecap, and one-off triggers
// ---------------------------------------------------------------------------

async function runRecapBroadcast() {
  const week = currentQ2Week();
  if (week < 1 || week > 13) {
    console.log('[Recap] Skipping — outside Q2 window.');
    return;
  }
  console.log('[Recap] Running weekly recap...');
  try {
    const users = await sheets.getAllUsersWithChatId();
    const allStats = await sheets.getAllUserStats();
    const totalUsers = allStats.length;

    const allDepts = await sheets.getAllDeptStats();
    const deptsSorted = [...allDepts].sort((a, b) => b.avgPoints - a.avgPoints);
    const totalDepts = deptsSorted.length;
    const deptRankMap = {};
    for (let i = 0; i < deptsSorted.length; i++) {
      deptRankMap[deptsSorted[i].department.toLowerCase()] = i + 1;
    }

    const cl = await sheets.getChangelog();
    const changelogText = cl?.text ?? null;

    for (const { realName, chatId, nickname, department } of users) {
      try {
        const stats = await sheets.getStatsForUser(realName);
        if (!stats) continue;

        const displayName = nickname ?? realName;
        const deptKey = department?.toLowerCase();
        const deptRank = deptKey ? (deptRankMap[deptKey] ?? null) : null;
        const deptAvgPts = deptKey ? (deptsSorted.find(d => d.department.toLowerCase() === deptKey)?.avgPoints ?? null) : null;
        const msg = buildRecapMessage(displayName, week, stats, totalUsers, deptRank, totalDepts, deptAvgPts, changelogText);

        await bot.api.sendMessage(chatId, msg, { parse_mode: 'MarkdownV2' });
        await new Promise(r => setTimeout(r, 200));
      } catch (userErr) {
        console.error(`[Recap] Failed for ${realName}:`, userErr.message);
      }
    }
    lastRecapWeek = week;
    if (changelogText) await sheets.clearChangelog();
    console.log('[Recap] Weekly recap complete.');
  } catch (err) {
    console.error('[Recap] Error:', err);
  }
}

// ---------------------------------------------------------------------------
// Friday recap cron — 3:30 PM SGT = 07:30 UTC, every Friday
// ---------------------------------------------------------------------------

cron.schedule('30 7 * * 5', async () => {
  const week = currentQ2Week();
  if (lastRecapWeek >= week) {
    console.log('[Cron] Skipping Friday recap — already sent this week.');
    return;
  }
  await runRecapBroadcast();
}, { timezone: 'UTC' });

// ---------------------------------------------------------------------------
// Friday 10 AM SGT reminder — heads-up to admins before recap fires
// ---------------------------------------------------------------------------

cron.schedule('0 2 * * 5', async () => {
  const week = currentQ2Week();
  if (week < 1 || week > 13) return;
  if (lastRecapWeek >= week) return;
  const adminIds = (process.env.ADMIN_CHAT_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean);
  for (const adminId of adminIds) {
    try {
      await bot.api.sendMessage(adminId, `⏰ Heads up — the weekly recap fires at 3:30 PM SGT today\\.\n\n1\\. Run /testrecap to preview what everyone will receive\n2\\. Add an announcement with /setchangelog \\<message\\> if needed\n3\\. Run /firerecap when ready, or let it fire automatically at 3:30 PM\\.`, { parse_mode: 'MarkdownV2' });
    } catch (err) {
      console.error(`[Cron] Failed recap reminder to admin ${adminId}:`, err.message);
    }
  }
}, { timezone: 'UTC' });

// ---------------------------------------------------------------------------
// Tuesday 9:30 AM SGT (01:30 UTC) — admin heads-up preview before good news notifications
// ---------------------------------------------------------------------------

cron.schedule('30 1 * * 2', async () => {
  const week = currentQ2Week();
  if (week < 1 || week > 13) return;
  const adminIds = (process.env.ADMIN_CHAT_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean);
  if (!adminIds.length) return;
  try {
    const entries = await getApprovedUnnotifiedGoodNews();
    let msg;
    if (!entries.length) {
      msg = `📨 No pending good news notifications for today\\.`;
    } else {
      const lines = entries.flatMap(gn => {
        const names = gn.awards.length > 0
          ? gn.awards.map(a => a.recipient_name)
          : [gn.nominee_name];
        return names.map(r => `• ${e(gn.nominator_name)} → ${e(r)} \\(W${e(String(gn.week_number))}\\)`);
      }).join('\n');
      msg =
        `📨 Good news notifications fire at *10:15 AM SGT* today\\.\n\n` +
        `${e(String(entries.length))} entr${entries.length === 1 ? 'y' : 'ies'} will go out:\n${lines}\n\n` +
        `Use /firenotifications to send now, or let it fire automatically\\.`;
    }
    for (const adminId of adminIds) {
      try {
        await bot.api.sendMessage(adminId, msg, { parse_mode: 'MarkdownV2' });
      } catch (err) {
        console.error(`[Cron] GN heads-up failed for admin ${adminId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Cron] GN heads-up error:', err);
  }
}, { timezone: 'UTC' });

// ---------------------------------------------------------------------------
// Tuesday 10:15 AM SGT (02:15 UTC) — send good news notifications
// ---------------------------------------------------------------------------

cron.schedule('15 2 * * 2', async () => {
  const week = currentQ2Week();
  if (week < 1 || week > 13) return;
  const adminIds = (process.env.ADMIN_CHAT_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean);
  try {
    const { sent, noChat, count } = await sendGoodNewsNotifications();
    if (count === 0) return;
    let summary = `✅ Good news notifications sent\\!\n\n`;
    if (sent.length) {
      summary += `Notified:\n` + sent.map(s => `• ${e(s.name)} \\(from ${e(s.fromName)}, \\+${e(String(s.pts))} pts\\)`).join('\n');
    }
    if (noChat.length) {
      summary += `\n\nNo Telegram \\(not reached\\):\n` + noChat.map(n => `• ${e(n)}`).join('\n');
    }
    for (const adminId of adminIds) {
      try {
        await bot.api.sendMessage(adminId, summary, { parse_mode: 'MarkdownV2' });
      } catch (err) {
        console.error(`[Cron] GN summary failed for admin ${adminId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Cron] GN notifications error:', err);
    for (const adminId of adminIds) {
      try {
        await bot.api.sendMessage(adminId, `⚠️ Good news notifications failed\\. Check Railway logs\\.`, { parse_mode: 'MarkdownV2' });
      } catch {}
    }
  }
}, { timezone: 'UTC' });

// ---------------------------------------------------------------------------
// One-off: fire recap today (Thursday Apr 30, 2026) at 3:30 PM SGT
// ---------------------------------------------------------------------------
{
  const now = new Date();
  const todaySGT = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
  if (todaySGT === '2026-04-30') {
    const target = new Date('2026-04-30T07:30:00Z');
    const delay = target.getTime() - now.getTime();
    if (delay > 0) {
      console.log(`[Cron] One-off Thursday recap scheduled in ${Math.round(delay / 60000)} minutes.`);
      setTimeout(() => runRecapBroadcast(), delay);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP server — serves the leadership dashboard + JSON API
// Railway exposes PORT automatically.
// ---------------------------------------------------------------------------

const PORT            = process.env.PORT ?? 3000;
const DASHBOARD_FILE  = path.join(__dirname, 'dashboard.html');
const COOKIE_SECRET   = process.env.COOKIE_SECRET;
const AUTH_COOKIE     = 'dash_session';
const BOT_USERNAME    = 'TC_CultivAIte_Bot';

if (!COOKIE_SECRET) {
  console.warn('⚠️  COOKIE_SECRET not set — dashboard auth disabled. Set it in .env / Railway env.');
}

async function getAllowedIds() {
  const envIds = [
    ...(process.env.ADMIN_CHAT_IDS ?? '').split(','),
    ...(process.env.LEADERSHIP_CHAT_IDS ?? '').split(','),
  ].map(id => id.trim()).filter(Boolean);
  const dbIds = await getDashboardAccessIds().catch(() => []);
  return [...new Set([...envIds, ...dbIds])];
}

function verifyTelegramLogin(params) {
  const { hash, ...data } = params;
  if (!hash) return false;
  const secret = crypto.createHash('sha256').update(process.env.BOT_TOKEN).digest();
  const checkString = Object.keys(data).sort().map(k => `${k}=${data[k]}`).join('\n');
  const hmac = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  if (hmac !== hash) return false;
  const authDate = parseInt(data.auth_date ?? '0');
  if (Date.now() / 1000 - authDate > 300) return false;
  return true;
}

function signCookie(userId, firstName, role = 'admin', dept = null, dept2 = null) {
  const payload = JSON.stringify({ id: userId, name: firstName, role, dept, dept2: dept2 || null, ts: Date.now() });
  const sig = crypto.createHmac('sha256', COOKIE_SECRET).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64')}.${sig}`;
}

function verifyCookie(raw) {
  if (!raw || !COOKIE_SECRET) return null;
  const [b64, sig] = raw.split('.');
  if (!b64 || !sig) return null;
  try {
    const payload = Buffer.from(b64, 'base64').toString();
    const expected = crypto.createHmac('sha256', COOKIE_SECRET).update(payload).digest('hex');
    if (sig !== expected) return null;
    const data = JSON.parse(payload);
    if (Date.now() - data.ts > 7 * 24 * 60 * 60 * 1000) return null;
    return data;
  } catch { return null; }
}

function getCookie(req, name) {
  const raw = req.headers.cookie ?? '';
  const m = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function getSessionUser(req) {
  return verifyCookie(getCookie(req, AUTH_COOKIE));
}

function loginPage() {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CultivAIte Dashboard — Login</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: linear-gradient(135deg, #e8f5e9 0%, #fff8e1 100%);
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .card { text-align: center; background: #fff; padding: 3rem 2.5rem; border-radius: 1rem;
          box-shadow: 0 4px 24px rgba(0,0,0,.08); max-width: 380px; width: 90%; }
  .card h1 { font-size: 1.4rem; margin-bottom: .5rem; color: #2e7d32; }
  .card p { color: #666; margin-bottom: 1.5rem; font-size: .95rem; }
  .card .emoji { font-size: 3rem; margin-bottom: 1rem; }
  #tg-widget { min-height: 46px; }
</style>
</head><body>
<div class="card">
  <div class="emoji">🌱</div>
  <h1>CultivAIte Dashboard</h1>
  <p>Log in with Telegram to continue</p>
  <div id="tg-widget">
    <script async src="https://telegram.org/js/telegram-widget.js?22"
      data-telegram-login="${BOT_USERNAME}"
      data-size="large"
      data-auth-url="/auth/telegram"
      data-request-access="write"></script>
  </div>
</div>
</body></html>`;
}

function unauthorizedPage() {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unauthorized</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #fafafa; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .card { text-align: center; padding: 3rem 2.5rem; }
  .card h1 { font-size: 1.3rem; color: #c62828; margin-bottom: .5rem; }
  .card p { color: #666; font-size: .95rem; }
</style>
</head><body>
<div class="card">
  <h1>Not authorized</h1>
  <p>Your Telegram account isn't in the leadership list.<br>Ask Wilson to add your ID.</p>
</div>
</body></html>`;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function jsonRes(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

http.createServer(async (req, res) => {
  const url_  = new URL(req.url, `http://localhost`);
  const route = url_.pathname;

  // Telegram Login Widget callback
  if (req.method === 'GET' && route === '/auth/telegram') {
    const params = Object.fromEntries(url_.searchParams.entries());
    if (!verifyTelegramLogin(params)) {
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end('<h3>Login verification failed. <a href="/">Try again</a></h3>');
      return;
    }
    const [allowedIds, managerRecord] = await Promise.all([
      getAllowedIds(),
      getManager(params.id),
    ]);
    const isAllowedAdmin = allowedIds.includes(String(params.id));
    if (!isAllowedAdmin && !managerRecord) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(unauthorizedPage());
      return;
    }
    const role   = isAllowedAdmin ? 'admin' : 'manager';
    const dept   = isAllowedAdmin ? null : managerRecord.department;
    const dept2  = isAllowedAdmin ? null : (managerRecord.secondary_department || null);
    const cookie = signCookie(params.id, params.first_name ?? 'User', role, dept, dept2);
    res.writeHead(302, {
      'Location': '/dashboard',
      'Set-Cookie': `${AUTH_COOKIE}=${encodeURIComponent(cookie)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`,
    });
    res.end();
    return;
  }

  // Logout
  if (req.method === 'GET' && route === '/logout') {
    res.writeHead(302, {
      'Location': '/',
      'Set-Cookie': `${AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    });
    res.end();
    return;
  }

  // Serve dashboard HTML
  if (req.method === 'GET' && (route === '/' || route === '/dashboard')) {
    if (!getSessionUser(req)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(loginPage());
      return;
    }
    fs.readFile(DASHBOARD_FILE, 'utf8', (err, html) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    return;
  }

  if (!route.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return;
  }

  const user = getSessionUser(req);
  if (!user) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  try {
    // GET /api/me — returns role + dept from session cookie
    if (req.method === 'GET' && route === '/api/me') {
      return jsonRes(res, { role: user.role ?? 'admin', dept: user.dept ?? null, dept2: user.dept2 ?? null, name: user.name ?? '' });
    }

    // GET /api/stats
    if (req.method === 'GET' && route === '/api/stats') {
      return jsonRes(res, await sheets.getFullDashboardStats());
    }

    // GET /api/good-news/pending
    if (req.method === 'GET' && route === '/api/good-news/pending') {
      if (user.role === 'manager') return jsonRes(res, { error: 'Admin only' }, 403);
      return jsonRes(res, await sheets.getPendingGoodNews());
    }

    // GET /api/good-news/reviewed  — approved + rejected rows for the edit-after-approval flow
    if (req.method === 'GET' && route === '/api/good-news/reviewed') {
      if (user.role === 'manager') return jsonRes(res, { error: 'Admin only' }, 403);
      return jsonRes(res, await sheets.getReviewedGoodNews());
    }

    // GET /api/good-news/dept?dept=SM  — manager view: nominations involving a specific dept
    if (req.method === 'GET' && route === '/api/good-news/dept') {
      const dept = url_.searchParams.get('dept');
      if (!dept) return jsonRes(res, { error: 'dept required' }, 400);
      return jsonRes(res, await getGoodNewsByDept(dept));
    }

    // POST /api/good-news/:id/approve
    const approveM = route.match(/^\/api\/good-news\/(\d+)\/approve$/);
    if (req.method === 'POST' && approveM) {
      if (user.role === 'manager') return jsonRes(res, { error: 'Admin only' }, 403);
      const body = await parseBody(req);
      await sheets.approveGoodNews(parseInt(approveM[1]), body.awards ?? []);
      return jsonRes(res, { ok: true });
    }

    // POST /api/good-news/:id/reject
    const rejectM = route.match(/^\/api\/good-news\/(\d+)\/reject$/);
    if (req.method === 'POST' && rejectM) {
      if (user.role === 'manager') return jsonRes(res, { error: 'Admin only' }, 403);
      await sheets.rejectGoodNews(parseInt(rejectM[1]));
      return jsonRes(res, { ok: true });
    }

    // POST /api/good-news/:id/re-approve  — change awards on an already-approved row
    const reapproveM = route.match(/^\/api\/good-news\/(\d+)\/re-approve$/);
    if (req.method === 'POST' && reapproveM) {
      if (user.role === 'manager') return jsonRes(res, { error: 'Admin only' }, 403);
      const body = await parseBody(req);
      await sheets.reapproveGoodNews(parseInt(reapproveM[1]), body.awards ?? []);
      return jsonRes(res, { ok: true });
    }

    // POST /api/good-news/:id/un-reject  — flip a rejected row back to pending
    const unRejectM = route.match(/^\/api\/good-news\/(\d+)\/un-reject$/);
    if (req.method === 'POST' && unRejectM) {
      if (user.role === 'manager') return jsonRes(res, { error: 'Admin only' }, 403);
      await sheets.unRejectGoodNews(parseInt(unRejectM[1]));
      return jsonRes(res, { ok: true });
    }

    // POST /api/good-news/:id/unapprove  — revert approved entry to Pending, delete award rows
    const unapproveM = route.match(/^\/api\/good-news\/(\d+)\/unapprove$/);
    if (req.method === 'POST' && unapproveM) {
      if (user.role === 'manager') return jsonRes(res, { error: 'Admin only' }, 403);
      await sheets.unapproveGoodNews(parseInt(unapproveM[1]));
      return jsonRes(res, { ok: true });
    }

    // POST /api/good-news/:id/notify-rejected — send notify-only messages without approving
    const notifyRejectedM = route.match(/^\/api\/good-news\/(\d+)\/notify-rejected$/);
    if (req.method === 'POST' && notifyRejectedM) {
      if (user.role === 'manager') return jsonRes(res, { error: 'Admin only' }, 403);
      const gnId = parseInt(notifyRejectedM[1]);
      const body = await parseBody(req);
      const recipients = body.recipients ?? []; // [{ name, dept }]
      const gn = await getGoodNewsById(gnId);
      if (!gn) return jsonRes(res, { error: 'Not found' }, 404);

      const sent = [];
      const noChat = [];
      for (const r of recipients) {
        const recipUser = await getUserByRealName(r.name);
        if (!recipUser?.chatId) { noChat.push(r.name); continue; }
        const msg =
          `🌟 ${bold('Good News Shoutout!')}\n\n` +
          `${e(gn.nominator_name)} shared good news about you:\n\n` +
          `_"${e(gn.message)}"_`;
        try {
          await bot.api.sendMessage(recipUser.chatId, msg, { parse_mode: 'MarkdownV2' });
          sent.push(r.name);
        } catch (err) {
          console.error(`[GN notify-rejected] Failed → ${r.name}:`, err.message);
          noChat.push(r.name);
        }
      }
      await markGoodNewsNotified([gnId]);
      return jsonRes(res, { ok: true, sent, noChat });
    }

    // GET /api/reflections?week=N
    if (req.method === 'GET' && route === '/api/reflections') {
      const weekNum = parseInt(url_.searchParams.get('week') ?? '1');
      let [subs, { statsMap }] = await Promise.all([
        sheets.getReflectionsForWeek(weekNum),
        sheets.getRawStatsCache(),
      ]);
      if (user.role === 'manager' && user.dept) {
        const mgrDepts = [user.dept, user.dept2].filter(Boolean);
        subs = subs.filter(s => mgrDepts.includes(s.department));
      }
      const enriched = subs.map(s => {
        const stat = statsMap[(s.real_name ?? '').toLowerCase().trim()] ?? {};
        return { ...s, plantStage: stat.plantStage ?? '🌱', totalPoints: stat.totalPoints ?? 0, goal: stat.goal ?? null };
      });
      return jsonRes(res, enriched);
    }

    // POST /api/user/:name/active  — toggle active status
    const activeM = route.match(/^\/api\/user\/(.+)\/active$/);
    if (req.method === 'POST' && activeM) {
      const body = await parseBody(req);
      const { active } = body;
      await sheets.setActive(decodeURIComponent(activeM[1]), active);
      return jsonRes(res, { ok: true });
    }

    // GET /api/person/:name
    const personM = route.match(/^\/api\/person\/(.+)$/);
    if (req.method === 'GET' && personM) {
      const subs = await sheets.getSubmissionsForUser(decodeURIComponent(personM[1]), 13);
      return jsonRes(res, subs);
    }

    // GET /api/extensions
    if (req.method === 'GET' && route === '/api/extensions') {
      const exts = await sheets.listExtensions();
      return jsonRes(res, exts);
    }

    // POST /api/extensions  — body: { realName, weekNumber, type }
    if (req.method === 'POST' && route === '/api/extensions') {
      const body = await parseBody(req);
      const { realName, weekNumber, type } = body;
      if (!realName || !weekNumber) { res.writeHead(400); return res.end('Missing realName or weekNumber'); }
      await sheets.grantExtension(realName, weekNumber, type ?? 'extension');
      return jsonRes(res, { ok: true });
    }

    // PATCH /api/submissions/:id/week  — move submission to target week
    const subWeekM = route.match(/^\/api\/submissions\/(\d+)\/week$/);
    if (req.method === 'PATCH' && subWeekM) {
      const body = await parseBody(req);
      const { weekNum } = body;
      if (!weekNum) { res.writeHead(400); return res.end('Missing weekNum'); }
      await sheets.setSubmissionWeek(parseInt(subWeekM[1]), parseInt(weekNum));
      return jsonRes(res, { ok: true });
    }

    // PATCH /api/good-news/:id/week  — reassign good news to a different week
    const gnWeekM = route.match(/^\/api\/good-news\/(\d+)\/week$/);
    if (req.method === 'PATCH' && gnWeekM) {
      if (user.role === 'manager') return jsonRes(res, { error: 'Admin only' }, 403);
      const body = await parseBody(req);
      const { weekNum } = body;
      if (!weekNum) { res.writeHead(400); return res.end('Missing weekNum'); }
      await setGoodNewsWeek(parseInt(gnWeekM[1]), parseInt(weekNum));
      return jsonRes(res, { ok: true });
    }

    // POST /api/late  — body: { realName, weekNumber }  — toggle late flag
    if (req.method === 'POST' && route === '/api/late') {
      if (user.role === 'manager') return jsonRes(res, { error: 'Admin only' }, 403);
      const body = await parseBody(req);
      const { realName, weekNumber } = body;
      if (!realName || !weekNumber) { res.writeHead(400); return res.end('Missing realName or weekNumber'); }
      const result = await sheets.toggleLateSubmission(realName, parseInt(weekNumber));
      return jsonRes(res, result);
    }

    // DELETE /api/extensions  — body: { realName, weekNumber }
    if (req.method === 'DELETE' && route === '/api/extensions') {
      const body = await parseBody(req);
      const { realName, weekNumber } = body;
      if (!realName || !weekNumber) { res.writeHead(400); return res.end('Missing realName or weekNumber'); }
      await sheets.removeExtension(realName, weekNumber);
      return jsonRes(res, { ok: true });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
  } catch (err) {
    console.error('API error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}).listen(PORT, () => {
  console.log(`🌐 Dashboard server running on port ${PORT}`);
});

// ---------------------------------------------------------------------------
// Start polling (must be last)
// ---------------------------------------------------------------------------

console.log('🌱 TC CultivAIte bot starting...');
bot.start({
  onStart: () => console.log('✅ Bot is running! Press Ctrl+C to stop.'),
});

// Graceful shutdown — stops polling before the process exits so Railway
// rolling deploys don't cause a 409 Conflict from two concurrent getUpdates.
const shutdown = () => bot.stop();
process.once('SIGTERM', shutdown);
process.once('SIGINT',  shutdown);
