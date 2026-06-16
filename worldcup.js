/**
 * Fetches World Cup 2026 schedule and live scores from the ESPN public API.
 *
 * ESPN scoreboard endpoint (no API key required):
 *   https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard
 *
 * Each competitor in the response already includes the team's primary
 * "color" and "alternateColor" (hex, no #), which we use directly for
 * the lamp colors.
 */
const axios = require('axios');

const ESPN_BASE    = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';
const ESPN_SUMMARY = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary';

/** Returns a YYYYMMDD string for today in local time. */
function todayDateStr() {
  return new Date().toLocaleDateString('en-CA').replace(/-/g, '');
}

/**
 * Returns all of today's matches, sorted by kickoff time.
 * @param {string} [dateStr] - YYYYMMDD, defaults to today
 */
async function getMatches(dateStr = todayDateStr()) {
  const res = await axios.get(`${ESPN_BASE}?dates=${dateStr}`, { timeout: 10000 });
  const events = res.data.events || [];
  return events.map(parseMatch).sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
}

/** Re-fetches a single match by ID (for polling during a live game). */
async function getMatch(matchId, dateStr = todayDateStr()) {
  const matches = await getMatches(dateStr);
  return matches.find((m) => m.id === matchId) || null;
}

/**
 * Returns true if a hex color is too close to black to show meaningfully
 * on a lamp (average channel below ~12% brightness).
 * White and near-white are intentionally allowed — white is a common kit
 * color and renders fine as a desaturated/cool-white lamp state.
 * Black lamps should be turned off rather than showing a muddy dark color.
 */
function isNearBlack(hex) {
  if (!hex) return true;
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  return (r + g + b) / 3 < 0.12;
}

/**
 * Picks the lamp color for a team from their ESPN brand color fields.
 * Returns a '#rrggbb' string, or null if the color is near-black
 * (which tells the watcher to turn that lamp off instead).
 * White is allowed and will render as a bright white lamp.
 */
function pickTeamColor(team) {
  const color = team?.color;
  const alt = team?.alternateColor;
  if (!color) return null;
  if (!isNearBlack(color)) return `#${color}`;
  if (alt && !isNearBlack(alt)) return `#${alt}`; // primary black → try alt for brand fallback
  return null; // both near-black → lamp off
}

/**
 * Returns the actual kit colors each team is wearing in a given match
 * as { home: '#rrggbb' | null, away: '#rrggbb' | null }.
 *
 * null means the kit is black — the watcher will turn that lamp off.
 * Only available once lineups/kits are confirmed (around kickoff).
 */
async function getMatchKitColors(matchId) {
  try {
    const res = await axios.get(`${ESPN_SUMMARY}?event=${matchId}`, { timeout: 10000 });
    const teams = res.data?.boxscore?.teams || [];
    if (teams.length === 0) return null;

    const colors = {};
    for (const t of teams) {
      const homeAway = t.homeAway;
      const uniform = t.team?.uniform;

      if (uniform) {
        // Use the actual kit color. null = black kit → lamp off.
        colors[homeAway] = isNearBlack(uniform.color) ? null : `#${uniform.color}`;
      } else {
        // Kits not published yet — fall back to ESPN brand color.
        colors[homeAway] = pickTeamColor(t.team);
      }
    }
    return (colors.home !== undefined && colors.away !== undefined) ? colors : null;
  } catch {
    return null;
  }
}

function parseMatch(event) {
  const competition = event.competitions[0];
  const competitors = competition.competitors;
  const home = competitors.find((c) => c.homeAway === 'home');
  const away = competitors.find((c) => c.homeAway === 'away');

  return {
    id: event.id,
    name: event.name,
    shortName: event.shortName,
    status: competition.status?.type?.name,        // e.g. STATUS_SCHEDULED, STATUS_FIRST_HALF, STATUS_FINAL
    state: competition.status?.type?.state,        // 'pre' | 'in' | 'post' — use this for live/final checks
    completed: competition.status?.type?.completed,
    statusDetail: competition.status?.type?.detail,
    startTime: event.date,
    clock: competition.status?.displayClock,
    home: {
      team: home?.team?.displayName,
      score: parseInt(home?.score ?? '0', 10),
      color: pickTeamColor(home?.team),
    },
    away: {
      team: away?.team?.displayName,
      score: parseInt(away?.score ?? '0', 10),
      color: pickTeamColor(away?.team),
    },
  };
}

function isLive(match) {
  return match?.state === 'in';
}

function isFinal(match) {
  return match?.state === 'post' || match?.completed === true;
}

function isScheduled(match) {
  return match?.state === 'pre';
}

module.exports = { getMatches, getMatch, getMatchKitColors, isLive, isFinal, isScheduled, todayDateStr };
