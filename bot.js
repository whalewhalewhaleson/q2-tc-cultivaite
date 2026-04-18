import 'dotenv/config';
import { Bot, session } from 'grammy';
import { conversations, createConversation } from '@grammyjs/conversations';
import cron from 'node-cron';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as sheets from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// MarkdownV2 helpers
// ---------------------------------------------------------------------------

// Escape all MarkdownV2 special characters in plain text
function e(text) {
  return String(text).replace(/[_*[\]()~`>#+=|{}.!\-]/g, '\\$&');
}

// Bold text
function bold(text) { return `*${e(text)}*`; }

// Italic text
function italic(text) { return `_${e(text)}_`; }

// Monospace / code text (no escaping needed inside backticks)
function mono(text) { return `\`${text}\``; }

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

function getWeekNumber() {
  const start = new Date('2026-03-30T00:00:00+08:00');
  const daysSince = Math.floor((Date.now() - start.getTime()) / 86400000);
  return Math.min(Math.max(Math.ceil((daysSince + 1) / 7), 1), 13);
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



// Returns nickname if set, otherwise falls back to realName
async function getDisplayName(realName) {
  const nick = await sheets.getNickname(realName);
  return nick ?? realName;
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
      `Hey ${e(displayName)} 👋 ${bold(`Week ${weekNum} / 13`)}\n\n` +
      `Before we start — ${bold("What kind of person do you want to be by the end of Q2?")} ${italic("I'll show it to you every time you reflect. Change it anytime with /setgoal.")}`,
      { parse_mode: 'MarkdownV2' }
    );
    const goalCtx = await waitForText(conversation, ctx);
    if (!goalCtx) return;
    const newGoal = goalCtx.message.text.trim();
    await conversation.external(() => sheets.setGoal(user.realName, newGoal));
    await ctx.reply(`✅ ${bold('Saved.')} Let's reflect\\. 🌱`, { parse_mode: 'MarkdownV2' });
  } else {
    const reflectOpeners = [
      `Nice to see you again, ${e(displayName)}\\! 🌳🦋 Week ${weekNum}, let's go\\!\n\n` +
      `🎯 Your goal this quarter was: ${italic(`"${existingGoal}"`)}\\ — how's it going\\?\n\n` +
      `${italic('(Your reflections will be visible to your managers/HODs!)')}`,

      `Hey there, ${e(displayName)}\\! Ready for week ${weekNum}\\? 🌱\n\n` +
      `Made any progress on your goal 🎯 ${italic(`"${existingGoal}"`)}\?\n\n` +
      `${italic('(Your reflections will be visible to your managers/HODs!)')}`,

      `How was your week, ${e(displayName)}\\? 😎 Your 🎯 goal this quarter is: ${italic(`"${existingGoal}"`)}\\ — how is it coming along\\? 💭\n\n` +
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
  await ctx.reply(
    `${bold('Q3 (Optional): Any good news to share about someone this week? ⭐️')}\n` +
    `${italic("(Type out their name or type skip if you don't have any!)")}`,
    { parse_mode: 'MarkdownV2' }
  );
  const nomineeCtx = await waitForText(conversation, ctx);
  if (!nomineeCtx) return;
  nomineeName = nomineeCtx.message.text.trim();

  let hasGoodNews = false;
  let q3Raw = '';

  if (nomineeName.toLowerCase() !== 'skip') {
    await ctx.reply(
      `${bold('Q3: What did they do? Both your dept and theirs earn bonus pts — share away!')}`,
      { parse_mode: 'MarkdownV2' }
    );

    const q3Ctx = await waitForText(conversation, ctx);
    if (!q3Ctx) return;
    q3Raw = q3Ctx.message.text.trim();
    hasGoodNews = q3Raw.length > 0;

    if (hasGoodNews) {
      const nomineeUser = await conversation.external(() => sheets.getUserByRealName(nomineeName));
      nomineeDept = nomineeUser?.department ?? 'Unknown';
    }
  }

  // --- Step 7: Log submission + good news + trigger Apps Script ---
  const q3Stored = (hasGoodNews && nomineeName) ? `Nominated ${nomineeName} — ${q3Raw}` : '';
  await conversation.external(async () => {
    await sheets.logSubmission(user.realName, user.department, q1, q2, q3Stored);
    if (hasGoodNews && nomineeName) {
      await sheets.logGoodNews(user.realName, user.department, nomineeName, nomineeDept, q3Raw, getWeekNumber());
    }
    sheets.invalidateStatsCache();
  });

  // --- Step 8: Re-read stats (instant — calculated live from Supabase) ---
  const statsAfter = await conversation.external(() => sheets.getStatsForUser(user.realName));

  const newStage          = statsAfter?.plantStage        ?? stage;
  const newPct            = statsAfter?.progressPct       ?? pct;
  const newStreak         = statsAfter?.streak            ?? streak;
  const newPoints         = statsAfter?.totalPoints       ?? totalPoints;
  const newMisses         = statsAfter?.consecutiveMisses ?? 0;
  const ptsGained         = newPoints - totalPoints;
  const levelledUp = statsAfter &&
    HEALTHY_STAGES.indexOf(newStage) > HEALTHY_STAGES.indexOf(stage);

  // --- Step 9: Confirmation ---
  if (alreadySubmitted) {
    let msg = `📝 ${bold('Reflection stored.')}\n\nYour pts for this week are already in — but this one is saved too\\. Keep the habit going\\. 🌱 See you next Monday\\.`;
    if (hasGoodNews && nomineeName) {
      msg += `\n\n🌟 ${italic(`Your good news about ${nomineeName} has been noted — the team will review it!`)}`;
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
      msg += `\n\n🌟 ${italic(`Good news about ${nomineeName} noted — the team will review it!`)}`;
    }
    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  } else {
    let msg = `💧 ${bold('Plant watered!')}\n\n`;
    msg += buildPlantCard(newStage, newPct, newStreak, true, newPoints, newMisses, null, null);
    if (ptsGained > 0) {
      msg += `\n\n\\+${e(String(ptsGained))} pts earned this week\\!`;
    }
    msg += `\n\nGood work showing up this week\\. 🌱 See you Monday — the whole team is building this together\\.`;
    if (hasGoodNews && nomineeName) {
      msg += `\n\n🌟 ${italic(`Good news about ${nomineeName} noted — the team will review it!`)}`;
    }
    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  }
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
  await ctx.reply(
    `${bold('Your most recent reflection:')}\n\n` +
    `📅 ${e(latest.date)}\n\n` +
    `${bold('Q1:')} ${e(latest.q1)}\n\n` +
    `${bold('Q2:')} ${e(latest.q2)}\n\n` +
    `Which part would you like to update?\nReply ${bold('1')} for Q1, ${bold('2')} for Q2, or ${bold('3')} for both`,
    { parse_mode: 'MarkdownV2' }
  );

  const choiceCtx = await waitForText(conversation, ctx);
  if (!choiceCtx) return;
  const choice = choiceCtx.message.text.trim();

  if (!['1', '2', '3'].includes(choice)) {
    await ctx.reply(`Just reply with 1, 2, or 3\\. Try /editreflection again whenever you're ready\\.`, { parse_mode: 'MarkdownV2' });
    return;
  }

  let newQ1 = latest.q1;
  let newQ2 = latest.q2;

  if (choice === '1' || choice === '3') {
    await ctx.reply(
      `${bold("Q1: What is one TC value you've lived out and how? 🤔")}\n\n` +
      `${italic('And in the coming week, how can you live out our values even more? 🌱☁️')}`,
      { parse_mode: 'MarkdownV2' }
    );
    const q1Ctx = await waitForText(conversation, ctx);
    if (!q1Ctx) return;
    newQ1 = q1Ctx.message.text;
  }

  if (choice === '2' || choice === '3') {
    await ctx.reply(
      `${bold('Q2: How did you do in your role? What would a coach tell you? 💭💪🏻')}`,
      { parse_mode: 'MarkdownV2' }
    );
    const q2Ctx = await waitForText(conversation, ctx);
    if (!q2Ctx) return;
    newQ2 = q2Ctx.message.text;
  }

  await conversation.external(() => sheets.updateSubmission(latest.rowIndex, newQ1, newQ2));
  await ctx.reply(`✅ ${bold('Reflection updated!')} Your words are saved\\. 🌱`, { parse_mode: 'MarkdownV2' });
}

// ---------------------------------------------------------------------------
// Bot setup
// ---------------------------------------------------------------------------

const bot = new Bot(process.env.BOT_TOKEN);

bot.use(session({ initial: () => ({}) }));
bot.use(conversations());
bot.use(createConversation(setupConversation));
bot.use(createConversation(setNicknameConversation));
bot.use(createConversation(reflectConversation));
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
    ? memberData.stages.join('')
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
    const companyGarden = allStats.map(u => u.plantStage).join('');

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

    if (!nameArg || isNaN(weekNum) || weekNum < 1 || weekNum > 13) {
      await ctx.reply(
        `${bold('Usage:')} /skipweek \\[Name\\] \\[Week\\]\n\n` +
        `Example: /skipweek Wilson 3\n\n` +
        `${italic('Week must be a number between 1 and 13.')}`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    const user = await sheets.getUserByRealName(nameArg);
    if (!user?.realName) {
      await ctx.reply(
        `${bold(nameArg)} not found in the Users tab\\.\n\nCheck the spelling matches column B exactly\\.`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    await sheets.logSkip(user.realName, user.department, weekNum);
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

    await bot.api.sendMessage(
      targetChatId,
      `Hey ${e(targetDisplayName)}\\! /reflect on the past week yet\\? Take a break to water your plant\\! 🌱🌊`,
      { parse_mode: 'MarkdownV2' }
    );

    if (arg) {
      await ctx.reply(`Nudge sent to ${targetDisplayName} ✅`);
    }
  } catch (err) {
    console.error('/testnudge error:', err);
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
// /dashboard — admin + leadership, get live stats summary + dashboard link
// ---------------------------------------------------------------------------

const Q2_START_MS = new Date('2026-03-30T00:00:00+08:00').getTime();

function currentQ2Week() {
  return Math.min(13, Math.max(1, Math.floor((Date.now() - Q2_START_MS) / (7 * 86400000)) + 1));
}

bot.command('dashboard', async (ctx) => {
  try {
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
    const dashUrl = process.env.DASHBOARD_URL ?? 'Not configured — set DASHBOARD_URL in .env';

    await ctx.reply(
      `📊 TC CultivAIte Dashboard — Week ${weekNum} of 13\n\n` +
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

    let msg = `${e(todayStr)} \\(Week ${weekNum}\\)\n\n`;

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

    if (sub.q3) {
      msg += `${bold('Q3')} ${italic(sub.q3)}`;
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
    `/mystats — 🌿 Check your plant, pts & streak\n` +
    `/setgoal — 🎯 Set or update your Q2 goal\n` +
    `/nick — 🏷 Set or update your nickname\n` +
    `/department — 🌳 See your department garden\n` +
    `/leaderboard — 🏆 Top 5 individuals \\+ company garden\n` +
    `/deptleaderboard — 🌳 See all departments ranked by pts\n` +
    `/tutorial — 📖 How points and stages work\n` +
    `/myreflections — 📋 List your past reflections\n` +
    `/1, /2\\.\\.\\. — 📖 Read a specific reflection\n` +
    `/editreflection — ✏️ Update your most recent reflection\n` +
    `/cancel — ❌ Cancel whatever's in progress\n` +
    `/help — Show this message\n`;

  if (isAdmin(ctx)) {
    msg +=
      `\n${bold('Admin')}\n` +
      `/skipweek — 🗓 Excuse a user for a week\n` +
      `/testnudge — 🔔 Preview the Monday nudge message\n` +
      `  • /testnudge wilson — send nudge preview to a specific person\n` +
      `/broadcast — 📣 Send a message to all or one user\n` +
      `  • /broadcast me \\<msg\\> — test send to yourself\n` +
      `  • /broadcast all \\<msg\\> — send to everyone\n` +
      `  • /broadcast \\<Name\\> \\<msg\\> — send to one person\n` +
      `/dashboard — 📊 Live stats summary \\+ dashboard link\n`;
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
  console.log('[Cron] Running Monday nudge...');
  try {
    const users = await sheets.getAllUsersWithChatId();
    for (const { realName, chatId, nickname } of users) {
      try {
        const stats = await sheets.getStatsForUser(realName);
        if (stats && stats.submittedThisWeek === false) {
          const displayName = nickname ?? realName;
          await bot.api.sendMessage(
            chatId,
            `Hey ${e(displayName)}\\! /reflect on the past week yet\\? Take a break to water your plant\\! 🌱🌊`,
            { parse_mode: 'MarkdownV2' }
          );
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
// HTTP server — serves the leadership dashboard + JSON API
// Railway exposes PORT automatically.
// ---------------------------------------------------------------------------

const PORT           = process.env.PORT ?? 3000;
const DASHBOARD_FILE = path.join(__dirname, 'dashboard.html');

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

  // Serve dashboard HTML
  if (req.method === 'GET' && (route === '/' || route === '/dashboard')) {
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

  try {
    // GET /api/stats
    if (req.method === 'GET' && route === '/api/stats') {
      return jsonRes(res, await sheets.getFullDashboardStats());
    }

    // GET /api/good-news/pending
    if (req.method === 'GET' && route === '/api/good-news/pending') {
      return jsonRes(res, await sheets.getPendingGoodNews());
    }

    // GET /api/good-news/reviewed  — approved + rejected rows for the edit-after-approval flow
    if (req.method === 'GET' && route === '/api/good-news/reviewed') {
      return jsonRes(res, await sheets.getReviewedGoodNews());
    }

    // POST /api/good-news/:id/approve
    const approveM = route.match(/^\/api\/good-news\/(\d+)\/approve$/);
    if (req.method === 'POST' && approveM) {
      const body = await parseBody(req);
      await sheets.approveGoodNews(parseInt(approveM[1]), body.awards ?? []);
      return jsonRes(res, { ok: true });
    }

    // POST /api/good-news/:id/reject
    const rejectM = route.match(/^\/api\/good-news\/(\d+)\/reject$/);
    if (req.method === 'POST' && rejectM) {
      await sheets.rejectGoodNews(parseInt(rejectM[1]));
      return jsonRes(res, { ok: true });
    }

    // POST /api/good-news/:id/re-approve  — change awards on an already-approved row
    const reapproveM = route.match(/^\/api\/good-news\/(\d+)\/re-approve$/);
    if (req.method === 'POST' && reapproveM) {
      const body = await parseBody(req);
      await sheets.reapproveGoodNews(parseInt(reapproveM[1]), body.awards ?? []);
      return jsonRes(res, { ok: true });
    }

    // POST /api/good-news/:id/un-reject  — flip a rejected row back to pending
    const unRejectM = route.match(/^\/api\/good-news\/(\d+)\/un-reject$/);
    if (req.method === 'POST' && unRejectM) {
      await sheets.unRejectGoodNews(parseInt(unRejectM[1]));
      return jsonRes(res, { ok: true });
    }

    // GET /api/reflections?week=N
    if (req.method === 'GET' && route === '/api/reflections') {
      const weekNum = parseInt(url_.searchParams.get('week') ?? '1');
      const [subs, { statsMap }] = await Promise.all([
        sheets.getReflectionsForWeek(weekNum),
        sheets.getRawStatsCache(),
      ]);
      const enriched = subs.map(s => {
        const stat = statsMap[(s.real_name ?? '').toLowerCase().trim()] ?? {};
        return { ...s, plantStage: stat.plantStage ?? '🌱', totalPoints: stat.totalPoints ?? 0, goal: stat.goal ?? null };
      });
      return jsonRes(res, enriched);
    }

    // GET /api/person/:name
    const personM = route.match(/^\/api\/person\/(.+)$/);
    if (req.method === 'GET' && personM) {
      const subs = await sheets.getSubmissionsForUser(decodeURIComponent(personM[1]), 13);
      return jsonRes(res, subs);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
  } catch (err) {
    console.error('API error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
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
