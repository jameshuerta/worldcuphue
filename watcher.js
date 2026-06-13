/**
 * World Cup 2026 — Hue lamp watcher.
 *
 * Run once per day (via cron, started before the earliest possible kickoff).
 * It walks through the day's matches in kickoff order:
 *
 *   - Waits for each match to kick off, then sets the left lamp to the
 *     home team's color and the right lamp to the away team's color.
 *   - Polls the live match for goals. When a team scores, flashes that
 *     team's lamp (left for home, right for away) in their color, then
 *     restores the steady team colors.
 *   - When the match ends, moves on to the next match of the day.
 *   - Won't start tracking a new match after CUTOFF_HOUR_CT (default 10 PM
 *     Central) — a match already in progress is allowed to finish normally.
 *   - Turns the lamps off once the day's matches are done (or the cutoff
 *     is reached with nothing live).
 *
 * Usage:
 *   node watcher.js
 */

require('dotenv').config();
const { createHueController, hexToHueState } = require('./hue');
const { getMatches, getMatch, isLive, isFinal, todayDateStr } = require('./worldcup');

const {
  HUE_LIGHT_LEFT,
  HUE_LIGHT_RIGHT,
  CUTOFF_HOUR_CT     = '22',
  GOAL_FLASH_PATTERN = 'strobe',
  GOAL_FLASH_COUNT   = '6',
} = process.env;

if (!HUE_LIGHT_LEFT || !HUE_LIGHT_RIGHT) {
  console.error('Missing HUE_LIGHT_LEFT / HUE_LIGHT_RIGHT in .env');
  process.exit(1);
}

const CUTOFF_HOUR = parseInt(CUTOFF_HOUR_CT, 10);
const FLASH_COUNT = parseInt(GOAL_FLASH_COUNT, 10);

const POLL_LIVE_MS = 10_000;        // poll cadence while a match is live
const POLL_WAIT_MS = 60_000;        // poll cadence while waiting for kickoff

function timestamp() {
  return new Date().toLocaleTimeString();
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Current hour (0-23) in Central Time, regardless of the machine's local timezone. */
function hourInCT() {
  const hourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    hour12: false,
  }).format(new Date());
  return parseInt(hourStr, 10) % 24;
}

/** Lamp color for a team's hex color, forced to full brightness. */
function lampColor(hex) {
  return hexToHueState(hex, 254);
}

async function setMatchColors(hue, match) {
  await hue.setColorState([HUE_LIGHT_LEFT], lampColor(match.home.color), { transitiontime: 10 });
  await hue.setColorState([HUE_LIGHT_RIGHT], lampColor(match.away.color), { transitiontime: 10 });
  console.log(
    `[${timestamp()}] Lamps set — left: ${match.home.team} (${match.home.color})  ` +
    `right: ${match.away.team} (${match.away.color})`
  );
}

/**
 * Waits for a match to kick off (or for the next poll to show it's live/final).
 * Returns false if the cutoff is reached before kickoff.
 */
async function waitForKickoff(match) {
  while (true) {
    if (hourInCT() >= CUTOFF_HOUR) return false;

    const fresh = await getMatch(match.id);
    if (!fresh || isLive(fresh) || isFinal(fresh)) return true;

    const minsUntil = Math.round((new Date(fresh.startTime) - Date.now()) / 60000);
    console.log(`[${timestamp()}] ${fresh.shortName} kicks off in ~${minsUntil} min. Waiting...`);

    await delay(POLL_WAIT_MS);
  }
}

/** Tracks a live match: sets initial colors, polls for goals, exits when final. */
async function trackMatch(hue, matchId) {
  let match = await getMatch(matchId);
  if (!match) return;

  console.log(`[${timestamp()}] Tracking: ${match.shortName} (${match.statusDetail})`);
  await setMatchColors(hue, match);

  let lastHomeScore = match.home.score;
  let lastAwayScore = match.away.score;

  while (true) {
    await delay(POLL_LIVE_MS);

    try {
      match = await getMatch(matchId);
    } catch (err) {
      console.error(`[${timestamp()}] Poll error: ${err.message}`);
      continue;
    }
    if (!match) break;

    if (match.home.score > lastHomeScore) {
      lastHomeScore = match.home.score;
      console.log(`\n*** GOAL! ${match.home.team} scores! (${match.home.score}-${match.away.score}) ***\n`);
      await hue.flashGoal([HUE_LIGHT_LEFT], lampColor(match.home.color), GOAL_FLASH_PATTERN, FLASH_COUNT);
      await setMatchColors(hue, match);
    }

    if (match.away.score > lastAwayScore) {
      lastAwayScore = match.away.score;
      console.log(`\n*** GOAL! ${match.away.team} scores! (${match.home.score}-${match.away.score}) ***\n`);
      await hue.flashGoal([HUE_LIGHT_RIGHT], lampColor(match.away.color), GOAL_FLASH_PATTERN, FLASH_COUNT);
      await setMatchColors(hue, match);
    }

    process.stdout.write(
      `\r[${timestamp()}] ${match.clock ?? '--'} | ${match.home.team} ${match.home.score}-${match.away.score} ${match.away.team}  `
    );

    if (isFinal(match)) {
      console.log(`\n[${timestamp()}] FINAL: ${match.home.team} ${match.home.score}-${match.away.score} ${match.away.team}`);
      break;
    }
  }
}

async function main() {
  const hue = createHueController(process.env);
  const dateStr = todayDateStr();

  console.log(`\nWorld Cup Hue Watcher — ${new Date().toLocaleString()}`);

  const matches = await getMatches(dateStr);
  if (matches.length === 0) {
    console.log('No World Cup matches today. Exiting.');
    return;
  }

  console.log(`Found ${matches.length} match(es) today:`);
  for (const m of matches) {
    console.log(`  ${m.shortName} — ${new Date(m.startTime).toLocaleTimeString()} (${m.statusDetail})`);
  }
  console.log('');

  for (const match of matches) {
    const fresh = await getMatch(match.id, dateStr);
    if (isFinal(fresh)) continue;

    if (!isLive(fresh)) {
      const started = await waitForKickoff(fresh);
      if (!started) {
        console.log(`[${timestamp()}] Reached ${CUTOFF_HOUR}:00 CT cutoff — not starting any more matches today.`);
        break;
      }
    }

    await trackMatch(hue, match.id);
  }

  console.log(`\n[${timestamp()}] Done for today. Turning lamps off.`);
  await hue.turnOff([HUE_LIGHT_LEFT, HUE_LIGHT_RIGHT]);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
