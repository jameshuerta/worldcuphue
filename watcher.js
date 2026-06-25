/**
 * World Cup 2026 — Hue lamp watcher.
 *
 * Single game:      left lamp = home team color, right lamp = away team color.
 * Simultaneous:     left lamp = game 1 (cycles between its two teams every
 *                   60 sec), right lamp = game 2 (same). Goals flash that
 *                   game's lamp white, then restore the current cycle color.
 *
 * Run once per day via cron — starts at 7 AM, tracks all matches in order,
 * stops starting new ones after CUTOFF_HOUR_CT (default 10 PM Central).
 */

require('dotenv').config();
const { createHueController, hexToHueState } = require('./hue');
const { getMatches, getMatch, getMatchKitColors, isLive, isFinal, todayDateStr } = require('./worldcup');

const {
  HUE_LIGHT_LEFT,
  HUE_LIGHT_RIGHT,
  CUTOFF_HOUR_CT     = '22',
  EARLY_LAMP_MINS    = '60',
  GOAL_FLASH_PATTERN = 'strobe',
  GOAL_FLASH_COUNT   = '12',
} = process.env;

if (!HUE_LIGHT_LEFT || !HUE_LIGHT_RIGHT) {
  console.error('Missing HUE_LIGHT_LEFT / HUE_LIGHT_RIGHT in .env');
  process.exit(1);
}

const CUTOFF_HOUR         = parseInt(CUTOFF_HOUR_CT, 10);
const EARLY_LAMP_MINS_NUM = parseInt(EARLY_LAMP_MINS, 10);
const FLASH_COUNT         = parseInt(GOAL_FLASH_COUNT, 10);

const POLL_LIVE_MS            = 5_000;           // poll cadence while a match is live
const POLL_WAIT_MS            = 60_000;          // poll cadence while waiting for kickoff
const CYCLE_MS                = 60_000;          // simultaneous mode: color cycle interval
const CYCLE_TRANSITION        = 20;              // tenths of a second (2s smooth fade)
const SIMULTANEOUS_THRESHOLD_MS = 60 * 60_000;  // kickoffs within 60 min = simultaneous

function timestamp() {
  return new Date().toLocaleTimeString();
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function hourInCT() {
  const hourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    hour12: false,
  }).format(new Date());
  return parseInt(hourStr, 10) % 24;
}

function lampColor(hex) {
  return hexToHueState(hex, 254);
}

const GOAL_FLASH_COLOR = { hue: 0, sat: 0, bri: 254 };

async function safeHue(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`[${timestamp()}] Hue error (${label}): ${err.message}`);
  }
}

// ── Single-game lamp control ──────────────────────────────────────────────────

async function setMatchColors(hue, match, homeColor, awayColor) {
  await safeHue('set colors', async () => {
    if (homeColor) {
      await hue.setColorState([HUE_LIGHT_LEFT], lampColor(homeColor), { transitiontime: 10 });
    } else {
      await hue.turnOff([HUE_LIGHT_LEFT]);
    }
    if (awayColor) {
      await hue.setColorState([HUE_LIGHT_RIGHT], lampColor(awayColor), { transitiontime: 10 });
    } else {
      await hue.turnOff([HUE_LIGHT_RIGHT]);
    }
    console.log(
      `[${timestamp()}] Lamps set — left: ${match.home.team} (${homeColor ?? 'off'})  ` +
      `right: ${match.away.team} (${awayColor ?? 'off'})`
    );
  });
}

// ── Pre-kickoff waiting ───────────────────────────────────────────────────────

async function waitForKickoff(hue, match, isFirstMatch, partnerMatch = null) {
  let earlyColorsSet = false;

  while (true) {
    if (hourInCT() >= CUTOFF_HOUR) return false;

    let fresh;
    try {
      fresh = await getMatch(match.id);
    } catch (err) {
      console.error(`[${timestamp()}] ESPN poll error: ${err.message}`);
      await delay(POLL_WAIT_MS);
      continue;
    }
    if (!fresh || isLive(fresh) || isFinal(fresh)) return true;

    const minsUntil = Math.round((new Date(fresh.startTime) - Date.now()) / 60000);

    if (isFirstMatch && !earlyColorsSet && minsUntil <= EARLY_LAMP_MINS_NUM) {
      console.log(`[${timestamp()}] First match of the day — setting lamps ${EARLY_LAMP_MINS_NUM} min early.`);
      if (partnerMatch) {
        // Two simultaneous games: one color from each game on each lamp
        await safeHue('early lamps', async () => {
          if (fresh.home.color) {
            await hue.setColorState([HUE_LIGHT_LEFT], lampColor(fresh.home.color), { transitiontime: 10 });
          } else {
            await hue.turnOff([HUE_LIGHT_LEFT]);
          }
          if (partnerMatch.home.color) {
            await hue.setColorState([HUE_LIGHT_RIGHT], lampColor(partnerMatch.home.color), { transitiontime: 10 });
          } else {
            await hue.turnOff([HUE_LIGHT_RIGHT]);
          }
          console.log(
            `[${timestamp()}] Early lamps — left: ${fresh.home.team} (${fresh.home.color ?? 'off'})  ` +
            `right: ${partnerMatch.home.team} (${partnerMatch.home.color ?? 'off'})`
          );
        });
      } else {
        await setMatchColors(hue, fresh, fresh.home.color, fresh.away.color);
      }
      earlyColorsSet = true;
    }

    console.log(`[${timestamp()}] ${fresh.shortName} kicks off in ~${minsUntil} min. Waiting...`);
    await delay(POLL_WAIT_MS);
  }
}

// ── Single-game tracking (both lamps, static colors) ─────────────────────────

async function trackMatch(hue, matchId, dateStr) {
  let match = await getMatch(matchId, dateStr);
  if (!match) return;

  console.log(`[${timestamp()}] Tracking: ${match.shortName} (${match.statusDetail})`);

  const kits = await getMatchKitColors(matchId);
  const homeColor = kits?.home ?? match.home.color;
  const awayColor = kits?.away ?? match.away.color;

  await setMatchColors(hue, match, homeColor, awayColor);

  let lastHomeScore = match.home.score;
  let lastAwayScore = match.away.score;

  while (true) {
    await delay(POLL_LIVE_MS);

    try {
      match = await getMatch(matchId, dateStr);
    } catch (err) {
      console.error(`[${timestamp()}] Poll error: ${err.message}`);
      continue;
    }
    if (!match) break;

    if (match.home.score > lastHomeScore) {
      lastHomeScore = match.home.score;
      console.log(`\n*** GOAL! ${match.home.team} scores! (${match.home.score}-${match.away.score}) ***\n`);
      await safeHue('goal flash', () => hue.flashGoal([HUE_LIGHT_LEFT], GOAL_FLASH_COLOR, GOAL_FLASH_PATTERN, FLASH_COUNT));
      await setMatchColors(hue, match, homeColor, awayColor);
    }

    if (match.away.score > lastAwayScore) {
      lastAwayScore = match.away.score;
      console.log(`\n*** GOAL! ${match.away.team} scores! (${match.home.score}-${match.away.score}) ***\n`);
      await safeHue('goal flash', () => hue.flashGoal([HUE_LIGHT_RIGHT], GOAL_FLASH_COLOR, GOAL_FLASH_PATTERN, FLASH_COUNT));
      await setMatchColors(hue, match, homeColor, awayColor);
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

// ── Simultaneous mode: one lamp per game, cycling between team colors ─────────

async function trackOneLamp(hue, matchId, lampId, homeColor, awayColor, dateStr) {
  let showingHome  = true;
  let currentColor = homeColor;
  let lastCycleTime  = Date.now();
  let lastHomeScore  = 0;
  let lastAwayScore  = 0;

  const setLamp = (color, transition = 10) =>
    safeHue(`set lamp ${lampId}`, async () => {
      if (color) {
        await hue.setColorState([lampId], lampColor(color), { transitiontime: transition });
      } else {
        await hue.turnOff([lampId]);
      }
    });

  await setLamp(currentColor);

  const initial = await getMatch(matchId, dateStr);
  if (initial) {
    lastHomeScore = initial.home.score;
    lastAwayScore = initial.away.score;
    console.log(`[${timestamp()}] [${lampId}] ${initial.shortName}: ${initial.home.team} / ${initial.away.team}`);
  }

  while (true) {
    await delay(POLL_LIVE_MS);

    // Cycle color every CYCLE_MS with a smooth fade
    if (Date.now() - lastCycleTime >= CYCLE_MS) {
      showingHome  = !showingHome;
      currentColor = showingHome ? homeColor : awayColor;
      lastCycleTime  = Date.now();
      await setLamp(currentColor, CYCLE_TRANSITION);
    }

    let match;
    try {
      match = await getMatch(matchId, dateStr);
    } catch (err) {
      console.error(`[${timestamp()}] Poll error (lamp ${lampId}): ${err.message}`);
      continue;
    }
    if (!match) break;

    if (match.home.score > lastHomeScore) {
      lastHomeScore = match.home.score;
      console.log(`\n*** GOAL! ${match.home.team} [lamp ${lampId}] (${match.home.score}-${match.away.score}) ***\n`);
      await safeHue('goal flash', () => hue.flashGoal([lampId], GOAL_FLASH_COLOR, GOAL_FLASH_PATTERN, FLASH_COUNT));
      await setLamp(currentColor);
    }

    if (match.away.score > lastAwayScore) {
      lastAwayScore = match.away.score;
      console.log(`\n*** GOAL! ${match.away.team} [lamp ${lampId}] (${match.home.score}-${match.away.score}) ***\n`);
      await safeHue('goal flash', () => hue.flashGoal([lampId], GOAL_FLASH_COLOR, GOAL_FLASH_PATTERN, FLASH_COUNT));
      await setLamp(currentColor);
    }

    if (isFinal(match)) {
      console.log(`\n[${timestamp()}] FINAL (lamp ${lampId}): ${match.home.team} ${match.home.score}-${match.away.score} ${match.away.team}`);
      break;
    }
  }
}

async function trackSimultaneous(hue, match1, match2, dateStr) {
  console.log(`\n[${timestamp()}] SIMULTANEOUS — left: ${match1.shortName}  right: ${match2.shortName}\n`);

  const [kits1, kits2] = await Promise.all([
    getMatchKitColors(match1.id),
    getMatchKitColors(match2.id),
  ]);

  const m1Home = kits1?.home ?? match1.home.color;
  const m1Away = kits1?.away ?? match1.away.color;
  const m2Home = kits2?.home ?? match2.home.color;
  const m2Away = kits2?.away ?? match2.away.color;

  await Promise.all([
    trackOneLamp(hue, match1.id, HUE_LIGHT_LEFT,  m1Home, m1Away, dateStr)
      .then(() => safeHue('left off',  () => hue.turnOff([HUE_LIGHT_LEFT]))),
    trackOneLamp(hue, match2.id, HUE_LIGHT_RIGHT, m2Home, m2Away, dateStr)
      .then(() => safeHue('right off', () => hue.turnOff([HUE_LIGHT_RIGHT]))),
  ]);
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  const hue     = createHueController(process.env);
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

  const processed  = new Set();
  let isFirstMatch = true;

  for (const match of matches) {
    if (processed.has(match.id)) continue;

    const fresh = await getMatch(match.id, dateStr);
    if (isFinal(fresh)) { processed.add(match.id); continue; }

    // Gather all non-final matches kicking off within the simultaneous threshold
    const simultaneous = matches.filter(
      (m) =>
        m.id !== match.id &&
        !processed.has(m.id) &&
        !isFinal(m) &&
        Math.abs(new Date(m.startTime) - new Date(match.startTime)) <= SIMULTANEOUS_THRESHOLD_MS
    );

    processed.add(match.id);

    if (simultaneous.length > 0) {
      const partner = simultaneous[0];
      processed.add(partner.id);

      // Mark any additional simultaneous matches as processed (can't show >2)
      if (simultaneous.length > 1) {
        simultaneous.slice(1).forEach((m) => processed.add(m.id));
        console.log(
          `[${timestamp()}] Note: ${simultaneous.length - 1} additional simultaneous match(es) can't be shown — only 2 lamps available.`
        );
      }

      const partnerFresh = await getMatch(partner.id, dateStr);

      if (!isLive(fresh) && !isLive(partnerFresh)) {
        const started = await waitForKickoff(hue, fresh, isFirstMatch, partnerFresh);
        if (!started) {
          console.log(`[${timestamp()}] Reached ${CUTOFF_HOUR}:00 CT cutoff.`);
          break;
        }
      }
      isFirstMatch = false;

      const m1 = (await getMatch(match.id,   dateStr)) ?? fresh;
      const m2 = (await getMatch(partner.id, dateStr)) ?? partnerFresh;
      await trackSimultaneous(hue, m1, m2, dateStr);

    } else {
      if (!isLive(fresh)) {
        const started = await waitForKickoff(hue, fresh, isFirstMatch);
        if (!started) {
          console.log(`[${timestamp()}] Reached ${CUTOFF_HOUR}:00 CT cutoff.`);
          break;
        }
      }
      isFirstMatch = false;
      await trackMatch(hue, match.id, dateStr);
    }
  }

  console.log(`\n[${timestamp()}] Done for today. Turning lamps off.`);
  await safeHue('turn off', () => hue.turnOff([HUE_LIGHT_LEFT, HUE_LIGHT_RIGHT]));
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
