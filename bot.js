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

const STAGES = ['🌱', '🌿', '🌳', '🌼', '🍎'];
const STAGE_NAMES = {
  '🌱': 'Seedling',
  '🌿': 'Sprouting',
  '🌳': 'Tree',
  '🌼': 'Flowering',
  '🍎': 'Harvest',
};

function getWeekNumber() {
  const start = new Date('2026-04-20T00:00:00+08:00');
  const daysSince = Math.floor((Date.now() - start.getTime()) / 86400000);
  return Math.min(Math.max(Math.ceil((daysSince + 1) / 7), 1), 13);
}

// Progress bar using filled ● and empty ○, wrapped in monospace
function buildProgressBar(pct) {
  const filled = Math.floor(Math.max(0, Math.min(100, pct)) / 10);
  return mono('●'.repeat(filled) + '○'.repeat(10 - filled));
}

// How many more scored weeks until the next stage
function getNextStageInfo(plantStage, progressPct) {
  const idx = STAGES.indexOf(plantStage);
  if (idx === -1 || idx === STAGES.length - 1) return { nextEmoji: null, reflectionsNeeded: 0 };

  // Reconstruct approximate overall % from stage + within-stage progress
  const overallPct = idx * 20 + (progressPct / 100) * 20;
  const scoredWeeks = Math.round((overallPct / 100) * 13);
  const weeksForNextStage = Math.ceil(((idx + 1) * 20 / 100) * 13);
  const reflectionsNeeded = Math.max(1, weeksForNextStage - scoredWeeks);

  return { nextEmoji: STAGES[idx + 1], reflectionsNeeded };
}

// Full plant card block (used in /reflect, /mystats)
function buildPlantCard(stage, pct, streak, submittedThisWeek) {
  const bar = buildProgressBar(pct);
  const { nextEmoji, reflectionsNeeded } = getNextStageInfo(stage, pct);
  const submittedLine = submittedThisWeek
    ? `✅ Submitted this week`
    : `❌ Not submitted yet this week`;
  const streakLabel = streak === 1 ? '1 week' : `${streak} weeks`;

  let card = `${stage} ${bold('Your Plant')}\n`;
  card += `Growth ▸ ${bar} ${pct}%\n`;
  if (nextEmoji) {
    const noun = reflectionsNeeded === 1 ? 'reflection' : 'reflections';
    card += `Next ▸ ${italic(`${reflectionsNeeded} ${noun} to ${nextEmoji}`)}\n`;
  } else {
    card += `${italic('Full bloom reached! 🍎')}\n`;
  }
  card += `\n🔥 Streak ▸ ${streakLabel}\n`;
  card += submittedLine;
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
// Command interceptor — use inside conversations instead of waitFor directly
// Returns the message context, or null if a command was typed (exits flow)
// ---------------------------------------------------------------------------

async function waitForText(conversation, ctx) {
  const msgCtx = await conversation.waitFor('message:text');
  const text = msgCtx.message.text?.trim() ?? '';

  if (text.startsWith('/')) {
    await ctx.reply(
      `Reflection paused\\. 🌱\n\nNo worries — come back anytime with /reflect when you're ready\\.`,
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
    await ctx.reply('Something went wrong identifying you\\. Please try again\\.', { parse_mode: 'MarkdownV2' });
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
  const stage = statsBefore?.plantStage ?? '🌱';
  const pct = statsBefore?.progressPct ?? 0;
  const streak = statsBefore?.streak ?? 0;

  let cardMsg = `${bold(`Week ${weekNum}`)}\n\nHey ${e(user.realName)} 👋\n\n`;

  if (alreadySubmitted) {
    cardMsg += buildPlantCard(stage, pct, streak, true);
    cardMsg += `\n\n${italic("You've already reflected this week — this one won't move your progress, but it's still stored. Keep going!")}`;
  } else if (statsBefore) {
    cardMsg += buildPlantCard(stage, pct, streak, false);
  } else {
    cardMsg += `🌱 ${bold('Your Plant')}\nGrowth ▸ ${mono('○○○○○○○○○○')} 0%\n${italic('Your journey starts here!')}\n\n🔥 Streak ▸ 0\n❌ Not submitted yet`;
  }

  await ctx.reply(cardMsg, { parse_mode: 'MarkdownV2' });

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

  // --- Step 6: Log + trigger Apps Script ---
  await conversation.external(async () => {
    await sheets.logSubmission(user.realName, user.department, q1, q2);
    await triggerAppsScript();
  });

  // --- Step 7: Wait for stats recalc, then re-read ---
  await conversation.external(() => new Promise(r => setTimeout(r, 3000)));
  const statsAfter = await conversation.external(() => sheets.getStatsForUser(user.realName));

  const newStage = statsAfter?.plantStage ?? stage;
  const newPct = statsAfter?.progressPct ?? pct;
  const newStreak = statsAfter?.streak ?? streak;
  const levelledUp = statsAfter && newStage !== stage;

  // --- Step 8: Confirmation ---
  if (alreadySubmitted) {
    await ctx.reply(
      `📝 ${bold('Reflection stored!')}\n\nYour streak is already locked in for this week — this one's just for you\\. Keep that momentum going\\! 🌿\n\nSee you next week\\.`,
      { parse_mode: 'MarkdownV2' }
    );
  } else if (levelledUp) {
    const { nextEmoji } = getNextStageInfo(newStage, newPct);
    let msg = `💧 ${bold('Plant watered!')}\n\n${newStage} ${bold('Your plant just levelled up!')}\n${mono('●●●●●●●●●●')} → ${newStage}\n`;
    if (nextEmoji) {
      const { reflectionsNeeded } = getNextStageInfo(newStage, newPct);
      const noun = reflectionsNeeded === 1 ? 'reflection' : 'reflections';
      msg += `\n${italic(`${reflectionsNeeded} more ${noun} to reach ${nextEmoji}`)}\n`;
    }
    msg += `\nYou're growing\\. Keep it up\\! ${newStage}`;
    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  } else {
    let msg = `💧 ${bold('Plant watered!')}\n\n`;
    msg += buildPlantCard(newStage, newPct, newStreak, true);
    msg += `\n\nGreat work this week\\. See you next Monday\\! 🌿`;
    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  }
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
bot.use(createConversation(editReflectionConversation));

// ---------------------------------------------------------------------------
// /reflect
// ---------------------------------------------------------------------------

bot.command('reflect', async (ctx) => {
  try {
    await ctx.conversation.enter('reflectConversation');
  } catch (err) {
    console.error('/reflect error:', err);
    await ctx.reply('Something went wrong. Please try again!');
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

    const deptStats = await sheets.getDeptStats(user.department);

    if (!deptStats) {
      await ctx.reply(
        `${bold(user.department)}\n${italic('Your garden is just taking root — check back after your first reflections come in!')}`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    const bar = buildProgressBar(deptStats.progressPct);
    const stageName = STAGE_NAMES[deptStats.gardenStage] ?? 'Growing';

    const msg =
      `${deptStats.gardenStage} ${bold(user.department)}\n` +
      `Garden ▸ ${bar} ${deptStats.totalSubmissions}/${deptStats.targetSubmissions}\n` +
      `Stage ▸ ${italic(`${stageName} (${Math.round(deptStats.progressPct)}%)`)}`;

    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error('/department error:', err);
    await ctx.reply('Something went wrong. Please try again!');
  }
});

// ---------------------------------------------------------------------------
// /leaderboard
// ---------------------------------------------------------------------------

bot.command('leaderboard', async (ctx) => {
  try {
    const allDepts = await sheets.getAllDeptStats();

    if (!allDepts.length) {
      await ctx.reply(
        `${bold('TC Forest Leaderboard')}\n\n${italic('No department data yet — check back once reflections start coming in! 🌱')}`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    // Sort by overall progress descending
    const sorted = [...allDepts].sort((a, b) => b.progressPct - a.progressPct);

    const medals = ['🥇', '🥈', '🥉'];
    let msg = `🏆 ${bold('TC Forest Leaderboard')}\n\n`;

    sorted.forEach((dept, i) => {
      const rank = medals[i] ?? `${i + 1}\\.`;
      const bar = buildProgressBar(dept.progressPct);
      const stageName = STAGE_NAMES[dept.gardenStage] ?? 'Growing';
      msg +=
        `${rank} ${dept.gardenStage} ${bold(dept.department)}\n` +
        `${bar} ${Math.round(dept.progressPct)}% — ${italic(stageName)}\n\n`;
    });

    msg += italic('Keep reflecting to climb the ranks! 🌿');

    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error('/leaderboard error:', err);
    await ctx.reply('Something went wrong. Please try again!');
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

    const stats = await sheets.getStatsForUser(user.realName);
    const weekNum = getWeekNumber();

    let msg = `${bold(`Week ${weekNum}`)}\n\nHey ${e(user.realName)} 👋\n\n`;

    if (!stats) {
      msg +=
        `🌱 ${bold('Your Plant')}\n` +
        `Growth ▸ ${mono('○○○○○○○○○○')} 0%\n` +
        `${italic('Your journey starts here!')}\n\n` +
        `🔥 Streak ▸ 0\n` +
        `❌ Not submitted yet this week\n\n` +
        `Ready to plant your first seed? /reflect 💧`;
    } else {
      msg += buildPlantCard(stats.plantStage, stats.progressPct, stats.streak, stats.submittedThisWeek);
      if (!stats.submittedThisWeek) {
        msg += `\n\nYour plant is waiting\\. /reflect to water it 💧`;
      }
    }

    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error('/mystats error:', err);
    await ctx.reply('Something went wrong. Please try again!');
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

    const submissions = await sheets.getSubmissionsForUser(user.realName, 5);

    if (!submissions.length) {
      await ctx.reply(
        `Nothing here yet\\! Your reflections will be stored here once you start\\.\n\nBegin your journey with /reflect 🌱`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    let msg = `📋 ${bold('Your Reflections')}\n`;

    for (const sub of submissions.reverse()) {
      msg += `\n${bold(sub.date)}\n`;
      msg += `Q1: ${italic(sub.q1)}\n`;
      msg += `Q2: ${italic(sub.q2)}\n`;
    }

    msg += `\n${italic('Showing your last 5 entries.')}`;
    msg += `\nWant to make a change? /editreflection`;

    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error('/myreflections error:', err);
    await ctx.reply('Something went wrong. Please try again!');
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
    await ctx.reply('Something went wrong. Please try again!');
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
    `/mystats — 🌿 Check your plant, streak & progress\n` +
    `/department — 🌳 See your department garden\n` +
    `/leaderboard — 🏆 See all departments ranked\n` +
    `/myreflections — 📋 Browse your past reflections\n` +
    `/editreflection — ✏️ Update your most recent reflection\n` +
    `/cancel — ❌ Cancel a reflection in progress\n` +
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
  await ctx.reply(`No worries\\! 🌱 Come back whenever you're ready\\.\nYour plant will be here waiting — /reflect to continue\\.`, { parse_mode: 'MarkdownV2' });
});

// ---------------------------------------------------------------------------
// /start
// ---------------------------------------------------------------------------

bot.command('start', async (ctx) => {
  await ctx.reply(
    `🌱 ${bold('Welcome to TC CultivAIte!')}\n\n` +
    `This is your personal reflection companion for Q2\\.\n\n` +
    `Every week you reflect, your plant grows\\. Your department's garden blooms\\. Together, we build the TC Forest\\.\n\n` +
    `It only takes a few minutes — and every reflection counts\\.\n\n` +
    `Ready? Type /reflect to begin, or /help to see all commands\\.`,
    { parse_mode: 'MarkdownV2' }
  );
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

bot.catch((err) => {
  console.error('Unhandled bot error:', err);
  err.ctx?.reply('Something went wrong. Please try again!').catch(() => {});
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
