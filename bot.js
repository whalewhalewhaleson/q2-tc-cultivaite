import 'dotenv/config';
import { Bot, session } from 'grammy';
import { conversations, createConversation } from '@grammyjs/conversations';
import cron from 'node-cron';
import * as sheets from './sheets.js';

// ---------------------------------------------------------------------------
// Helpers
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
  const start = new Date('2026-04-13T00:00:00+08:00');
  const daysSince = Math.floor((Date.now() - start.getTime()) / 86400000);
  return Math.min(Math.max(Math.ceil((daysSince + 1) / 7), 1), 13);
}

function buildProgressBar(pct) {
  const filled = Math.floor(Math.max(0, Math.min(100, pct)) / 10);
  return '▓'.repeat(filled) + '░'.repeat(10 - filled);
}

function getNextStage(emoji, pct) {
  const idx = STAGES.indexOf(emoji);
  if (idx === -1 || idx === STAGES.length - 1) return { nextEmoji: null, moreBlocks: 0 };
  const filled = Math.floor(Math.max(0, Math.min(100, pct)) / 10);
  return { nextEmoji: STAGES[idx + 1], moreBlocks: 10 - filled };
}

function buildPlantMessage(stage, pct) {
  const bar = buildProgressBar(pct);
  const { nextEmoji, moreBlocks } = getNextStage(stage, pct);
  let msg = `${stage} Progress: ${bar}\n`;
  if (nextEmoji) msg += `${moreBlocks} more to reach ${nextEmoji}!`;
  else msg += `You've reached full bloom! 🍎`;
  return msg;
}

// ---------------------------------------------------------------------------
// /reflect conversation
// ---------------------------------------------------------------------------

async function reflectConversation(conversation, ctx) {
  // --- Guard: username required ---
  const username = ctx.from?.username?.toLowerCase();
  if (!username) {
    await ctx.reply(
      `Please set a Telegram username in your Telegram Settings, then come back and try again! 🌱`
    );
    return;
  }

  // --- Step 1: Look up user in Sheets ---
  const user = await conversation.external(() => sheets.getUserByUsername(username));

  if (!user || !user.realName) {
    await ctx.reply(
      `Hey! 👋 Looks like you're not in our system yet.\n` +
      `Text @whalewhalewhalee to get added, then come back here to start reflecting! 🌱`
    );
    return;
  }

  // --- Step 2: Store chat ID (silent, first-time only) ---
  await conversation.external(() => sheets.setChatId(username, String(ctx.from.id)));

  // --- Step 3: Check if already submitted this week ---
  const statsBefore = await conversation.external(() => sheets.getStatsForUser(user.realName));

  if (statsBefore?.submittedThisWeek === true) {
    await ctx.reply(
      `You've already watered your plant this week! 🌿\n` +
      `Come back after Monday 6 PM for a fresh week.\n\n` +
      `Want to see your garden? Try /department`
    );
    return;
  }

  // --- Step 4: Opening message ---
  const weekNum = getWeekNumber();
  const stage = statsBefore?.plantStage ?? '🌱';
  const pct = statsBefore?.progressPct ?? 0;

  let openingMsg = `Hey ${user.realName}! 👋 Week ${weekNum} — let's water your plant!\n\n`;

  if (statsBefore) {
    openingMsg += buildPlantMessage(stage, pct);
  } else {
    openingMsg += `🌱 Your plant is just getting started!\n░░░░░░░░░░`;
  }

  openingMsg += `\n\nQ1: What's one thing you've grown in personally this week?`;
  await ctx.reply(openingMsg);

  // --- Step 5: Wait for Q1 ---
  const q1Ctx = await conversation.waitFor('message:text');
  const q1 = q1Ctx.message.text;

  await ctx.reply(`Nice. 🙌\n\nQ2: How have you improved professionally this week?`);

  // --- Step 6: Wait for Q2 ---
  const q2Ctx = await conversation.waitFor('message:text');
  const q2 = q2Ctx.message.text;

  // --- Step 7: Log submission ---
  await conversation.external(() =>
    sheets.logSubmission(user.realName, user.department, q1, q2)
  );

  // --- Step 8: Re-read stats (best-effort level-up detection) ---
  const statsAfter = await conversation.external(() => sheets.getStatsForUser(user.realName));

  const newStage = statsAfter?.plantStage ?? stage;
  const newPct = statsAfter?.progressPct ?? pct;
  const levelledUp = statsAfter && newStage !== stage;

  // --- Step 9: Confirmation message ---
  if (levelledUp) {
    const { nextEmoji, moreBlocks } = getNextStage(newStage, newPct);
    let msg = `💧 Watered!\n\n${newStage} Your plant just grew!\n▓▓▓▓▓▓▓▓▓▓ → ${newStage}\n`;
    if (nextEmoji) msg += `\n${moreBlocks} more to reach ${nextEmoji}!\n`;
    msg += `\nLooking good out there. ${newStage}`;
    await ctx.reply(msg);
  } else {
    let msg = `💧 Watered!\n\n`;
    msg += buildPlantMessage(newStage, newPct);
    msg += `\n\nSee you next week. 🌿`;
    await ctx.reply(msg);
  }
}

// ---------------------------------------------------------------------------
// Bot setup
// ---------------------------------------------------------------------------

const bot = new Bot(process.env.BOT_TOKEN);

// Session is required by the conversations plugin
bot.use(session({ initial: () => ({}) }));
// Conversations middleware must come before command handlers
bot.use(conversations());
bot.use(createConversation(reflectConversation));

// ---------------------------------------------------------------------------
// /reflect
// ---------------------------------------------------------------------------

bot.command('reflect', async (ctx) => {
  try {
    await ctx.conversation.enter('reflectConversation');
  } catch (err) {
    console.error('/reflect error:', err);
    await ctx.reply(`Something went wrong. Please try again!`);
  }
});

// ---------------------------------------------------------------------------
// /department
// ---------------------------------------------------------------------------

bot.command('department', async (ctx) => {
  try {
    const username = ctx.from?.username?.toLowerCase();
    if (!username) {
      await ctx.reply(`Please set a Telegram username in your Telegram Settings first! 🌱`);
      return;
    }

    const user = await sheets.getUserByUsername(username);
    if (!user || !user.realName) {
      await ctx.reply(
        `Hey! 👋 Looks like you're not in our system yet.\n` +
        `Text @whalewhalewhalee to get added! 🌱`
      );
      return;
    }

    const [deptStats, allDepts] = await Promise.all([
      sheets.getDeptStats(user.department),
      sheets.getAllDeptStats(),
    ]);

    if (!deptStats) {
      await ctx.reply(
        `🌿 ${user.department}\nYour garden is taking root — check back soon!\n\n` +
        `🌲 TC Forest: growing...`
      );
      return;
    }

    const bar = buildProgressBar(deptStats.progressPct);
    const stageName = STAGE_NAMES[deptStats.gardenStage] ?? 'Growing';
    const inBloom = allDepts.filter(d => d.gardenStage !== '🌱').length;
    const totalGardens = allDepts.length;

    const msg =
      `${deptStats.gardenStage} ${user.department}\n` +
      `${bar} ${deptStats.totalSubmissions}/${deptStats.targetSubmissions} — ${stageName} (${Math.round(deptStats.progressPct)}%)\n\n` +
      `🌲 TC Forest: ${inBloom} of ${totalGardens} gardens in bloom`;

    await ctx.reply(msg);
  } catch (err) {
    console.error('/department error:', err);
    await ctx.reply(`Something went wrong. Please try again!`);
  }
});

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------

bot.command('help', async (ctx) => {
  await ctx.reply(
    `🌱 TC CultivAIte — Commands\n\n` +
    `/reflect — Submit your weekly reflection and water your plant\n` +
    `/department — View your department garden and TC Forest\n` +
    `/cancel — Cancel a reflection in progress\n` +
    `/help — Show this message`
  );
});

// ---------------------------------------------------------------------------
// /cancel — exit any active conversation
// ---------------------------------------------------------------------------

bot.command('cancel', async (ctx) => {
  await ctx.conversation.exit();
  await ctx.reply(`No worries — cancelled. 🌱 Come back whenever you're ready!\n/reflect to start again.`);
});

// ---------------------------------------------------------------------------
// /start — friendly greeting for new users
// ---------------------------------------------------------------------------

bot.command('start', async (ctx) => {
  await ctx.reply(
    `🌱 Welcome to TC CultivAIte!\n\n` +
    `Every week you reflect, your plant grows. Every plant grows our forest.\n\n` +
    `Type /reflect to get started, or /help for all commands.`
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
// Sunday nudge cron — 10:00 AM SGT = 02:00 UTC, every Sunday
// ---------------------------------------------------------------------------

cron.schedule('0 2 * * 0', async () => {
  console.log('[Cron] Running Sunday nudge...');
  try {
    const users = await sheets.getAllUsersWithChatId();
    for (const { realName, chatId } of users) {
      try {
        const stats = await sheets.getStatsForUser(realName);
        if (stats && stats.submittedThisWeek === false) {
          await bot.api.sendMessage(
            chatId,
            `🍁 Hey ${realName}, your plant is fading...\n` +
            `You haven't reflected this week yet. Submit before Monday 6 PM to keep your streak!\n` +
            `/reflect — it only takes 2 minutes.`
          );
          // Small delay to stay within Telegram rate limits
          await new Promise(r => setTimeout(r, 200));
        }
      } catch (userErr) {
        // Don't abort the whole job if one user fails (e.g., they blocked the bot)
        console.error(`[Cron] Failed to nudge ${realName}:`, userErr.message);
      }
    }
    console.log('[Cron] Sunday nudge complete.');
  } catch (err) {
    console.error('[Cron] Sunday nudge error:', err);
  }
}, { timezone: 'UTC' });

// ---------------------------------------------------------------------------
// Start polling (must be last)
// ---------------------------------------------------------------------------

console.log('🌱 TC CultivAIte bot starting...');
bot.start({
  onStart: () => console.log('✅ Bot is running! Press Ctrl+C to stop.'),
});
