import 'dotenv/config';
import { Bot, session } from 'grammy';
import { conversations, createConversation } from '@grammyjs/conversations';
import cron from 'node-cron';
import * as sheets from './sheets.js';

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
  const start = new Date('2026-04-01T00:00:00+08:00');
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
    card += `Next ▸ ${bar} ${italic('Full bloom\\! 🍎')}\n`;
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

// Ping Apps Script Web App to trigger instant stats recalculation
async function triggerAppsScript() {
  const url = process.env.APPS_SCRIPT_URL;
  if (!url) return;
  try {
    await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10000) });
  } catch (err) {
    console.warn('[AppsScript] Trigger failed (non-fatal):', err.message);
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

// ---------------------------------------------------------------------------
// Command interceptor — use inside conversations instead of waitFor directly
// Returns the message context, or null if a command was typed (exits flow)
// ---------------------------------------------------------------------------

async function waitForText(conversation, ctx) {
  const msgCtx = await conversation.waitFor('message:text');
  const text = msgCtx.message.text?.trim() ?? '';

  if (text.startsWith('/')) {
    await ctx.reply(
      `No worries\\! 🌱 Come back and /reflect whenever you're ready\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    return null;
  }

  return msgCtx;
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
  const statsBefore = await conversation.external(() => sheets.getStatsForUser(user.realName));
  const alreadySubmitted = statsBefore?.submittedThisWeek === true;

  // --- Step 3: Plant card (message 1) ---
  const weekNum = getWeekNumber();
  const stage              = statsBefore?.plantStage        ?? '🌱';
  const pct                = statsBefore?.progressPct       ?? 0;
  const streak             = statsBefore?.streak            ?? 0;
  const totalPoints        = statsBefore?.totalPoints       ?? 0;
  const consecutiveMisses  = statsBefore?.consecutiveMisses ?? 0;

  let cardMsg = `${bold(`Week ${weekNum} / 13`)}\n\nHey ${e(user.realName)} 👋\n\n`;

  if (alreadySubmitted) {
    cardMsg += buildPlantCard(stage, pct, streak, true, totalPoints, consecutiveMisses, null, null);
    cardMsg += `\n\n${italic("You've already reflected this week — this one won't move your pts, but it's still stored. Keep going!")}`;
  } else if (statsBefore) {
    cardMsg += buildPlantCard(stage, pct, streak, false, totalPoints, consecutiveMisses, null, null);
  } else {
    cardMsg += `Plant ▸ 🌱 Seedling · 0 pts\nNext ▸ ${mono('○○○○○○○○○○')} 21 pts to 🌿\n\n🔥 Streak ▸ None \\(0 weeks\\)\n❌ Not submitted yet`;
  }

  await ctx.reply(cardMsg, { parse_mode: 'MarkdownV2' });

  // --- Step 3b: Goal reminder / first-time prompt ---
  const existingGoal = await conversation.external(() => sheets.getGoal(user.realName));

  if (!existingGoal) {
    await ctx.reply(
      `🎯 ${bold('Quick one before we start — what\'s your Q2 goal?')}\n\n` +
      `${italic("I'll remind you of it every time you reflect. You can change it anytime with /setgoal.")}`,
      { parse_mode: 'MarkdownV2' }
    );
    const goalCtx = await waitForText(conversation, ctx);
    if (!goalCtx) return;
    const newGoal = goalCtx.message.text.trim();
    await conversation.external(() => sheets.setGoal(user.realName, newGoal));
    await ctx.reply(`✅ Goal saved\\! Let's reflect\\. 🌿`, { parse_mode: 'MarkdownV2' });
  } else {
    await ctx.reply(
      `🎯 ${bold('Your Q2 Goal')}\n${italic(existingGoal)}`,
      { parse_mode: 'MarkdownV2' }
    );
  }

  // --- Step 4: Q1 prompt (message 2) ---
  await ctx.reply(
    `${bold("Q1: What's one thing you've grown in personally this week?")}\n\n${italic('Take your time — there are no wrong answers here.')}`,
    { parse_mode: 'MarkdownV2' }
  );

  const q1Ctx = await waitForText(conversation, ctx);
  if (!q1Ctx) return;
  const q1 = q1Ctx.message.text;

  // --- Step 5: Q2 prompt (message 3) ---
  await ctx.reply(
    `${bold('Q2: How have you improved professionally this week?')}\n\n${italic('Even small steps count.')}`,
    { parse_mode: 'MarkdownV2' }
  );

  // --- Step 6: Wait for Q2 (intercepts commands) ---
  const q2Ctx = await waitForText(conversation, ctx);
  if (!q2Ctx) return;
  const q2 = q2Ctx.message.text;

  // --- Step 6b: Optional Q3 — Good News ---
  await ctx.reply(
    `${bold('Q3 (Optional): Got any good news to share about someone this week?')}\n\n` +
    `${italic('Name them and what they did \u2014 both your dept and theirs earn bonus pts! Or type')} ${bold('skip')} ${italic('to finish.')}`,
    { parse_mode: 'MarkdownV2' }
  );

  const q3Ctx = await waitForText(conversation, ctx);
  if (!q3Ctx) return;
  const q3Raw = q3Ctx.message.text.trim();
  const hasGoodNews = q3Raw.toLowerCase() !== 'skip' && q3Raw.length > 0;

  let nomineeName = null;
  let nomineeDept = null;
  if (hasGoodNews) {
    await ctx.reply(
      `Who are you nominating? ${italic('Type their full name as it appears in the system.')}`,
      { parse_mode: 'MarkdownV2' }
    );
    const nomineeCtx = await waitForText(conversation, ctx);
    if (!nomineeCtx) return;
    nomineeName = nomineeCtx.message.text.trim();
    const nomineeUser = await conversation.external(() => sheets.getUserByRealName(nomineeName));
    nomineeDept = nomineeUser?.department ?? 'Unknown';
  }

  // --- Step 7: Log submission + good news + trigger Apps Script ---
  const q3Stored = (hasGoodNews && nomineeName) ? `Nominated ${nomineeName} — ${q3Raw}` : '';
  await conversation.external(async () => {
    await sheets.logSubmission(user.realName, user.department, q1, q2, q3Stored);
    if (hasGoodNews && nomineeName) {
      await sheets.logGoodNews(user.realName, user.department, nomineeName, nomineeDept, q3Raw, getWeekNumber());
    }
    await triggerAppsScript();
  });

  // --- Step 8: Wait for stats recalc, then re-read ---
  await conversation.external(() => new Promise(r => setTimeout(r, 3000)));
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
    let msg = `📝 ${bold('Reflection stored!')}\n\nYour pts are already locked in for this week — but I kept this one for you too\\. 🌿 See you next Monday\\!`;
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
    msg += `⭐ ${bold(`${newPoints} pts`)} total\\. You're growing — keep it up\\! ${newStage}`;
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
    msg += `\n\nGreat work this week 🌿 See you Monday\\!`;
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
      `🎯 ${bold('Your Q2 goal right now:')}\n${italic(existing)}\n\n` +
      `What do you want to change it to?`,
      { parse_mode: 'MarkdownV2' }
    );
  } else {
    await ctx.reply(
      `🎯 ${bold("What's one thing you want to achieve this Q2?")}\n\n` +
      `${italic("It'll pop up as a reminder every time you reflect — so make it count!")}`,
      { parse_mode: 'MarkdownV2' }
    );
  }

  const goalCtx = await waitForText(conversation, ctx);
  if (!goalCtx) return;
  const newGoal = goalCtx.message.text.trim();

  await conversation.external(() => sheets.setGoal(user.realName, newGoal));
  await ctx.reply(
    `✅ ${bold('Saved!')} 🎯 ${italic(newGoal)}\n\n${italic("I'll remind you of this every time you /reflect.")}`,
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
    await ctx.reply(`${bold("Q1: What's one thing you've grown in personally this week?")}\n\n${italic('Take your time — there are no wrong answers here.')}`, { parse_mode: 'MarkdownV2' });
    const q1Ctx = await waitForText(conversation, ctx);
    if (!q1Ctx) return;
    newQ1 = q1Ctx.message.text;
  }

  if (choice === '2' || choice === '3') {
    await ctx.reply(`${bold('Q2: How have you improved professionally this week?')}\n\n${italic('Even small steps count.')}`, { parse_mode: 'MarkdownV2' });
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

    const [deptStats, memberData] = await Promise.all([
      sheets.getDeptStats(user.department),
      sheets.getMemberStagesForDept(user.department),
    ]);

    if (!deptStats) {
      await ctx.reply(
        `${bold(user.department)}\n${italic('Your garden is just taking root — check back after your first reflections come in!')}`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    const bar = buildProgressBar(deptStats.progressPct);
    const stageName = STAGE_NAMES[deptStats.gardenStage] ?? 'Growing';
    const avgPts = deptStats.avgPoints ?? 0;
    const deptStreak = deptStats.deptStreak ?? 0;
    const { nextEmoji, ptsNeeded } = getNextStageInfo(deptStats.gardenStage, Math.floor(avgPts));
    const gardenRow = memberData.stages.length
      ? memberData.stages.join('')
      : '🌱 Still taking root\\.\\.\\.';

    let msg =
      `${deptStats.gardenStage} ${bold(user.department)}\n` +
      `${e(String(memberData.count))} members · ${e(String(avgPts))} pts avg\n\n` +
      `Plant ▸ ${deptStats.gardenStage} ${e(stageName)} · ${e(String(avgPts))} pts\n`;

    if (nextEmoji) {
      msg += `Growth ▸ ${bar} ${e(String(ptsNeeded))} pts to ${nextEmoji}\n`;
    } else {
      msg += `Growth ▸ ${bar} ${italic('Full bloom\\! 🍎')}\n`;
    }

    msg +=
      `Streaks ▸ ${e(String(deptStreak))} consecutive 100% week${deptStreak !== 1 ? 's' : ''}\n\n` +
      `${bold('Department Garden')}\n` +
      gardenRow;

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
        `⭐ ${e(String(avgPts))} avg pts — ${italic(stageName)}\n\n`;
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

    const medals = ['🥇', '🥈', '🥉'];
    const top5 = allStats.slice(0, 5);
    const companyGarden = allStats.map(u => u.plantStage).join('');

    let msg = `🏆 ${bold('TC Q2 Leaderboard')}\n\n`;

    top5.forEach((user, i) => {
      const rank = medals[i] ?? `${i + 1}\\.`;
      msg += `${rank} ${e(user.name)} ${user.plantStage} — ${e(String(user.totalPoints))} pts\n`;
    });

    msg += `\n${bold('The TC Garden')}\n${companyGarden}`;

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
        `${bold(e(nameArg))} not found in the Users tab\\.\n\nCheck the spelling matches column B exactly\\.`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    await sheets.logSkip(user.realName, user.department, weekNum);
    await triggerAppsScript();

    await ctx.reply(
      `✅ ${bold('Week skipped!')}\n\n` +
      `${bold(e(user.realName))} \\(${e(user.department)}\\) has been marked as excused for ${bold(`Week ${weekNum}`)}\\.\n\n` +
      `Their streak will be preserved once Apps Script recalculates\\.`,
      { parse_mode: 'MarkdownV2' }
    );
  } catch (err) {
    console.error('/skipweek error:', err);
    await ctx.reply('Hmm, something went wrong on my end 😅 Text @whalewhalewhalee if this keeps happening!');
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

    const [stats, allUsers] = await Promise.all([
      sheets.getStatsForUser(user.realName),
      sheets.getAllUsersWithChatId(),
    ]);
    const weekNum = getWeekNumber();
    const totalUsers = allUsers.length;

    let msg = `${bold(`Week ${weekNum} / 13`)}\n\nHey ${e(user.realName)} 👋\n\n`;

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

    `${bold('⭐ Earning Points')}\n` +
    `• Reflect each week ▸ ${bold('10 pts')}\n` +
    `• Streak bonus ▸ ${bold('+1 pt')} for each consecutive week\n` +
    `  ${italic('(week 3 of a streak = 12 pts)')}\n` +
    `• Share good news ▸ ${bold('+5 pts')} ${italic('(admin-reviewed — both you and the person you shout out earn pts!)')}\n` +
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

    `${bold('🏆 Department Garden')}\n` +
    `• Dept score \\= average of all members' pts\n\n` +

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
// /help
// ---------------------------------------------------------------------------

bot.command('help', async (ctx) => {
  await ctx.reply(
    `🌱 ${bold('TC CultivAIte')}\n` +
    `${italic('Your Q2 reflection companion')}\n\n` +
    `/reflect — 💧 Submit your weekly reflection\n` +
    `/mystats — 🌿 Check your plant, pts & streak\n` +
    `/setgoal — 🎯 Set or update your Q2 goal\n` +
    `/department — 🌳 See your department garden\n` +
    `/leaderboard — 🏆 Top 5 individuals \\+ company garden\n` +
    `/deptleaderboard — 🌳 See all departments ranked by pts\n` +
    `/tutorial — 📖 How points and stages work\n` +
    `/myreflections — 📋 List your past reflections\n` +
    `/1, /2\\.\\.\\. — 📖 Read a specific reflection\n` +
    `/editreflection — ✏️ Update your most recent reflection\n` +
    `/cancel — ❌ Cancel whatever's in progress\n` +
    `/skipweek — 🗓 \\(Admin\\) Excuse a user for a week\n` +
    `/help — Show this message\n\n` +
    `${italic('Reflect weekly. Grow together.')}`,
    { parse_mode: 'MarkdownV2' }
  );
});

// ---------------------------------------------------------------------------
// /cancel
// ---------------------------------------------------------------------------

bot.command('cancel', async (ctx) => {
  await ctx.conversation.exit();
  await ctx.reply(`Cancelled\\! 👍 Let me know if you need anything else\\.`, { parse_mode: 'MarkdownV2' });
});

// ---------------------------------------------------------------------------
// /start
// ---------------------------------------------------------------------------

bot.command('start', async (ctx) => {
  await ctx.reply(
    `Hey\\! 👋 I'm ${bold('CultivAIte')}, your Q2 reflection buddy\\.\n\n` +
    `Every week you reflect, your plant grows 🌱 — and together we'll build the TC Forest\\.\n\n` +
    `Ready? Start with /setgoal to set your Q2 goal, then /reflect whenever you're ready\\.\n\n` +
    `${italic('(Type /help anytime if you get lost!)')}`,
    { parse_mode: 'MarkdownV2' }
  );
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
    for (const { realName, chatId } of users) {
      try {
        const stats = await sheets.getStatsForUser(realName);
        if (stats && stats.submittedThisWeek === false) {
          await bot.api.sendMessage(
            chatId,
            `🌱 Hey ${e(realName)}\\! Just a gentle nudge from your reflection companion\\.\n\n` +
            `You haven't reflected this week yet — and your plant is waiting to be watered\\! 💧\n\n` +
            `Submit before ${bold('6 PM today')} to keep your streak alive\\.\n` +
            `/reflect — it only takes a couple of minutes\\.`,
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
// Start polling (must be last)
// ---------------------------------------------------------------------------

console.log('🌱 TC CultivAIte bot starting...');
bot.start({
  onStart: () => console.log('✅ Bot is running! Press Ctrl+C to stop.'),
});
