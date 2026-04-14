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
      `❌ Reflection cancelled\\!\n\nSend ${bold(text)} again to run it\\.`,
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
      `Hey\\! 👋 Looks like you're not in our system yet\\.\n` +
      `Text @whalewhalewhalee to get added, then come back here to start reflecting\\! 🌱`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // --- Step 2: Check if already submitted this week ---
  const statsBefore = await conversation.external(() => sheets.getStatsForUser(user.realName));
  const alreadySubmitted = statsBefore?.submittedThisWeek === true;

  // --- Step 3: Opening message ---
  const weekNum = getWeekNumber();
  const stage = statsBefore?.plantStage ?? '🌱';
  const pct = statsBefore?.progressPct ?? 0;
  const streak = statsBefore?.streak ?? 0;

  let openingMsg = `${bold(`Week ${weekNum}`)}\n\nHey ${e(user.realName)} 👋\n\n`;

  if (alreadySubmitted) {
    openingMsg += buildPlantCard(stage, pct, streak, true);
    openingMsg += `\n\n${italic("You've already scored this week — but reflection is always welcome. This one won't move your progress, but it's still logged.")}`;
  } else if (statsBefore) {
    openingMsg += buildPlantCard(stage, pct, streak, false);
  } else {
    openingMsg += `🌱 ${bold('Your Plant')}\nGrowth ▸ ${mono('○○○○○○○○○○')} 0%\n${italic('Just getting started!')}\n\n🔥 Streak ▸ 0\n❌ Not submitted yet`;
  }

  openingMsg += `\n\n${bold("Q1: What's one thing you've grown in personally this week?")}`;
  await ctx.reply(openingMsg, { parse_mode: 'MarkdownV2' });

  // --- Step 4: Wait for Q1 (intercepts commands) ---
  const q1Ctx = await waitForText(conversation, ctx);
  if (!q1Ctx) return;
  const q1 = q1Ctx.message.text;

  await ctx.reply(
    `Nice\\. 🙌\n\n${bold('Q2: How have you improved professionally this week?')}`,
    { parse_mode: 'MarkdownV2' }
  );

  // --- Step 5: Wait for Q2 (intercepts commands) ---
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
      `📝 ${bold('Logged!')}\n\nYour progress is already locked in for this week — this one's just for you\\. 🌿\n\nSee you next week\\!`,
      { parse_mode: 'MarkdownV2' }
    );
  } else if (levelledUp) {
    const { nextEmoji } = getNextStageInfo(newStage, newPct);
    let msg = `💧 ${bold('Watered!')}\n\n${newStage} ${bold('Your plant just grew!')}\n${mono('●●●●●●●●●●')} → ${newStage}\n`;
    if (nextEmoji) {
      const { reflectionsNeeded } = getNextStageInfo(newStage, newPct);
      const noun = reflectionsNeeded === 1 ? 'reflection' : 'reflections';
      msg += `\n${italic(`${reflectionsNeeded} ${noun} to ${nextEmoji}`)}\n`;
    }
    msg += `\nLooking good out there\\. ${newStage}`;
    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  } else {
    let msg = `💧 ${bold('Watered!')}\n\n`;
    msg += buildPlantCard(newStage, newPct, newStreak, true);
    msg += `\n\nSee you next week\\. 🌿`;
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
    await ctx.reply(`You're not in the system yet\\. Text @whalewhalewhalee to get added\\! 🌱`, { parse_mode: 'MarkdownV2' });
    return;
  }

  const submissions = await conversation.external(() => sheets.getSubmissionsForUser(user.realName, 1));
  if (!submissions.length) {
    await ctx.reply(`No reflections found yet\\. Submit your first with /reflect 🌱`, { parse_mode: 'MarkdownV2' });
    return;
  }

  const latest = submissions[0];
  await ctx.reply(
    `${bold('Your most recent reflection:')}\n\n` +
    `📅 ${e(latest.date)}\n\n` +
    `${bold('Q1:')} ${e(latest.q1)}\n\n` +
    `${bold('Q2:')} ${e(latest.q2)}\n\n` +
    `What would you like to edit?\nReply ${bold('1')} for Q1, ${bold('2')} for Q2, or ${bold('3')} for both`,
    { parse_mode: 'MarkdownV2' }
  );

  const choiceCtx = await waitForText(conversation, ctx);
  if (!choiceCtx) return;
  const choice = choiceCtx.message.text.trim();

  if (!['1', '2', '3'].includes(choice)) {
    await ctx.reply(`Please reply with 1, 2, or 3\\. Use /editreflection to try again\\.`, { parse_mode: 'MarkdownV2' });
    return;
  }

  let newQ1 = latest.q1;
  let newQ2 = latest.q2;

  if (choice === '1' || choice === '3') {
    await ctx.reply(`${bold("Q1: What's one thing you've grown in personally this week?")}`, { parse_mode: 'MarkdownV2' });
    const q1Ctx = await waitForText(conversation, ctx);
    if (!q1Ctx) return;
    newQ1 = q1Ctx.message.text;
  }

  if (choice === '2' || choice === '3') {
    await ctx.reply(`${bold('Q2: How have you improved professionally this week?')}`, { parse_mode: 'MarkdownV2' });
    const q2Ctx = await waitForText(conversation, ctx);
    if (!q2Ctx) return;
    newQ2 = q2Ctx.message.text;
  }

  await conversation.external(() => sheets.updateSubmission(latest.rowIndex, newQ1, newQ2));
  await ctx.reply(`✅ ${bold('Updated!')} Your reflection has been saved\\.`, { parse_mode: 'MarkdownV2' });
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

    const [deptStats, allDepts] = await Promise.all([
      sheets.getDeptStats(user.department),
      sheets.getAllDeptStats(),
    ]);

    if (!deptStats) {
      await ctx.reply(
        `${bold(user.department)}\n${italic('Your garden is taking root — check back soon!')}\n\n🌲 ${bold('TC Forest')} ▸ growing\\.\\.\\.`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    const bar = buildProgressBar(deptStats.progressPct);
    const stageName = STAGE_NAMES[deptStats.gardenStage] ?? 'Growing';
    const inBloom = allDepts.filter(d => d.gardenStage !== '🌱').length;
    const totalGardens = allDepts.length;

    const msg =
      `${deptStats.gardenStage} ${bold(user.department)}\n` +
      `Garden ▸ ${bar} ${deptStats.totalSubmissions}/${deptStats.targetSubmissions}\n` +
      `Stage ▸ ${italic(`${stageName} (${Math.round(deptStats.progressPct)}%)`)}\n\n` +
      `🌲 ${bold('TC Forest')} ▸ ${inBloom} of ${totalGardens} gardens in bloom`;

    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error('/department error:', err);
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
        `${italic('Just getting started!')}\n\n` +
        `🔥 Streak ▸ 0\n` +
        `❌ Not submitted yet this week\n\n` +
        `Ready to start? /reflect 💧`;
    } else {
      msg += buildPlantCard(stats.plantStage, stats.progressPct, stats.streak, stats.submittedThisWeek);
      if (!stats.submittedThisWeek) {
        msg += `\n\nReady to water your plant? /reflect 💧`;
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
        `You're not in our system yet\\. Text @whalewhalewhalee to get added\\! 🌱`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    const submissions = await sheets.getSubmissionsForUser(user.realName, 5);

    if (!submissions.length) {
      await ctx.reply(
        `No reflections yet\\!\n\nStart with /reflect 🌱`,
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

    msg += `\n${italic('Showing last 5.')}`;
    msg += `\nTo edit your latest: /editreflection`;

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
    `🌱 ${bold('TC CultivAIte — Commands')}\n\n` +
    `/reflect — 💧 Submit your weekly reflection\n` +
    `/mystats — 🌿 Your plant stage, streak & this week's status\n` +
    `/department — 🌳 Your department garden & TC Forest\n` +
    `/myreflections — 📋 View your past reflections\n` +
    `/editreflection — ✏️ Edit your most recent reflection\n` +
    `/cancel — ❌ Cancel a reflection in progress\n` +
    `/help — Show this message`,
    { parse_mode: 'MarkdownV2' }
  );
});

// ---------------------------------------------------------------------------
// /cancel
// ---------------------------------------------------------------------------

bot.command('cancel', async (ctx) => {
  await ctx.conversation.exit();
  await ctx.reply(`Cancelled\\. 🌱 Come back whenever you're ready\\!\n/reflect to start again\\.`, { parse_mode: 'MarkdownV2' });
});

// ---------------------------------------------------------------------------
// /start
// ---------------------------------------------------------------------------

bot.command('start', async (ctx) => {
  await ctx.reply(
    `🌱 ${bold('Welcome to TC CultivAIte!')}\n\n` +
    `Every week you reflect, your plant grows\\. Every plant grows our forest\\.\n\n` +
    `Type /reflect to get started, or /help for all commands\\.`,
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
            `🍁 Hey ${e(realName)}, your plant is fading\\.\\.\\.\n` +
            `You haven't reflected this week yet\\. Last chance — submit before 6 PM today to keep your streak\\!\n` +
            `/reflect — it only takes 2 minutes\\.`,
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
