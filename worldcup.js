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
 * Decide whether a hex color is usable as a lamp color, or whether it's
 * too close to white/black and we should fall back to the alternate color.
 */
function isUsableColor(hex) {
  if (!hex) return false;
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const sat = max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1));
  if (lightness > 0.85 && sat < 0.2) return false; // near-white
  if (lightness < 0.12) return false;              // near-black
  return true;
}

/** Picks the best lamp color (hex with #) for a team, preferring primary over alternate. */
function pickTeamColor(team) {
  const color = team?.color;
  const alt = team?.alternateColor;
  if (isUsableColor(color)) return `#${color}`;
  if (isUsableColor(alt)) return `#${alt}`;
  if (color) return `#${color}`;
  return '#888888';
}

/**
 * Returns the actual kit colors each team is wearing in a given match
 * (e.g. a team's away/alternate kit, picked to avoid clashing with the
 * opponent's home kit), as { home: '#rrggbb', away: '#rrggbb' }.
 *
 * Only available once the match's lineups/kits are confirmed (around
 * kickoff) — returns null before that. Falls back to the team's general
 * color if the uniform color itself is unusable (too close to white/black).
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
      const fallback = pickTeamColor(t.team);

      if (uniform && isUsableColor(uniform.color)) {
        colors[homeAway] = `#${uniform.color}`;
      } else if (uniform && isUsableColor(uniform.alternateColor)) {
        colors[homeAway] = `#${uniform.alternateColor}`;
      } else {
        colors[homeAway] = fallback;
      }
    }
    return colors.home && colors.away ? colors : null;
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
