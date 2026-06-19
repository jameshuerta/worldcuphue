/**
 * Force-sets the lamps to the current (or next upcoming) match's colors.
 *
 * Run any time the watcher missed a color change — e.g. if the lights
 * were offline when the match started or when the early-lamp timer fired.
 *
 * Usage:
 *   node set-now.js
 */

require('dotenv').config();
const { createHueController, hexToHueState } = require('./hue');
const { getMatches, getMatchKitColors, isLive, isFinal } = require('./worldcup');

async function lampColor(hex) {
  return hexToHueState(hex, 254);
}

async function main() {
  const hue = createHueController(process.env);
  const { HUE_LIGHT_LEFT, HUE_LIGHT_RIGHT } = process.env;

  const matches = await getMatches();
  if (matches.length === 0) {
    console.log('No World Cup matches today.');
    return;
  }

  // Prefer a live match; fall back to the next scheduled one.
  const match =
    matches.find((m) => isLive(m)) ||
    matches.find((m) => !isFinal(m));

  if (!match) {
    console.log('All matches today are finished.');
    return;
  }

  console.log(`Match: ${match.shortName} (${match.statusDetail})`);

  // Try to get actual kit colors; fall back to ESPN brand colors.
  const kits = await getMatchKitColors(match.id);
  const homeColor = kits?.home ?? match.home.color;
  const awayColor = kits?.away ?? match.away.color;

  console.log(`Setting left: ${match.home.team} (${homeColor ?? 'off'})`);
  console.log(`Setting right: ${match.away.team} (${awayColor ?? 'off'})`);

  await Promise.all([
    homeColor
      ? hue.setColorState([HUE_LIGHT_LEFT], hexToHueState(homeColor, 254))
      : hue.turnOff([HUE_LIGHT_LEFT]),
    awayColor
      ? hue.setColorState([HUE_LIGHT_RIGHT], hexToHueState(awayColor, 254))
      : hue.turnOff([HUE_LIGHT_RIGHT]),
  ]);

  console.log('Done.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
