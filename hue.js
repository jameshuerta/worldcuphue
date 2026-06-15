/**
 * Philips Hue API wrapper — supports both local and remote (cloud) modes.
 *
 * Local mode  — talks directly to the bridge on your home network.
 * Remote mode — routes through api.meethue.com using OAuth 2.0 tokens,
 *               so it works from anywhere (cloud, Pi, etc.).
 *
 * Use createHueController(process.env) to get the right controller
 * automatically based on HUE_MODE in your .env.
 *
 * Colors are represented as plain objects: { hue, sat, bri }
 *   hue: 0–65535  (color wheel position)
 *   sat: 0–254    (saturation)
 *   bri: 0–254    (brightness)
 *
 * Docs:
 *   Local API:  https://developers.meethue.com/develop/hue-api/lights-api/
 *   Remote API: https://developers.meethue.com/develop/hue-api/remote-api-quick-start-guide/
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '.env');

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Parse a color from .env — accepts either:
 *   "hue,sat,bri"  e.g. "7826,200,200"   (sampled from a real bulb — most accurate)
 *   "#RRGGBB"      e.g. "#C8A956"         (approximate — Hue gamut ≠ sRGB)
 * Returns { hue, sat, bri } or null.
 */
function parseColorEnv(value) {
  if (!value) return null;
  if (value.startsWith('#')) return hexToHueState(value);
  const parts = value.split(',').map(Number);
  if (parts.length === 3 && parts.every((n) => !isNaN(n))) {
    return { hue: parts[0], sat: parts[1], bri: parts[2] };
  }
  return null;
}

/**
 * Convert a CSS hex color (#RRGGBB) to Hue API state values.
 * Note: sRGB → Hue gamut conversion is approximate. Sampling a live bulb
 * with sampleLight() is more reliable for precise color matching.
 */
function hexToHueState(hex, overrideBri = null) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === r)      h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else                h = (r - g) / delta + 4;
    h /= 6;
    if (h < 0) h += 1;
  }

  return {
    hue: Math.round(h * 65535),
    sat: Math.round((max === 0 ? 0 : delta / max) * 254),
    bri: overrideBri ?? Math.round(max * 254),
  };
}

/**
 * Update specific keys in the .env file without overwriting other values.
 */
function updateEnvFile(updates) {
  let content = '';
  try { content = fs.readFileSync(ENV_PATH, 'utf8'); } catch { /* file may not exist */ }

  const lines = content.split('\n').filter(Boolean);
  const updated = new Set();

  const newLines = lines.map((line) => {
    const m = line.match(/^([^#\s][^=]*)=(.*)$/);
    if (!m) return line;
    const key = m[1].trim();
    if (key in updates) {
      updated.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  // Append any keys that weren't already in the file
  for (const [key, val] of Object.entries(updates)) {
    if (!updated.has(key)) newLines.push(`${key}=${val}`);
  }

  fs.writeFileSync(ENV_PATH, newLines.join('\n') + '\n');
}

// ── Base controller (local network) ──────────────────────────────────────────

class HueController {
  constructor(bridgeIp, username) {
    this.base = `http://${bridgeIp}/api/${username}`;
  }

  /** Override in subclasses to swap base URL and auth headers. */
  async _request(method, path, body) {
    const url = `${this.base}${path}`;

    // Transient network errors (e.g. bridge briefly unreachable on the LAN)
    // are retried a few times before giving up, so a momentary blip doesn't
    // take down the whole watcher process.
    const RETRYABLE = new Set(['EHOSTUNREACH', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'ECONNRESET']);
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await axios({ method, url, data: body, timeout: 10000 });
      } catch (err) {
        const retryable = RETRYABLE.has(err.code) || err.code === 'ECONNABORTED';
        if (!retryable || attempt === MAX_ATTEMPTS) throw err;
        console.error(`[hue] ${err.code} on ${method.toUpperCase()} ${path} — retrying (${attempt}/${MAX_ATTEMPTS})...`);
        await delay(1000 * attempt);
      }
    }
  }

  async getLights() {
    const res = await this._request('get', '/lights');
    return res.data;
  }

  /**
   * Read the current hue/sat/bri off a single bulb.
   * Set the light to exactly the color you want in the Hue app first,
   * then call this to capture those values for config.
   */
  async sampleLight(lightId) {
    const res = await this._request('get', `/lights/${lightId}`);
    const { hue, sat, bri } = res.data.state;
    return { hue, sat, bri };
  }

  async setState(lightId, state) {
    await this._request('put', `/lights/${lightId}/state`, state);
  }

  /** Apply a { hue, sat, bri } color state to one or more lights. */
  async setColorState(lightIds, colorState, { transitiontime = 10 } = {}) {
    await Promise.all(
      lightIds.map((id) =>
        this.setState(id, { on: true, ...colorState, transitiontime })
      )
    );
  }

  /**
   * Flash one or more lights to mark a goal.
   *
   * Patterns:
   *   strobe      — rapid bright-on / off cycles. Dramatic, hard to miss.
   *   pulse       — slow breathe from dim to bright and back. Intense but smooth.
   *   colorshift  — rapidly alternate flash color and white. Party mode.
   */
  async flashGoal(lightIds, flashState, pattern = 'strobe', count = 6) {
    const bright = { ...flashState, bri: 254 };
    console.log(`GOAL! Pattern: ${pattern} ×${count}`);

    switch (pattern) {
      case 'pulse':      await this._pulse(lightIds, bright, count);      break;
      case 'colorshift': await this._colorshift(lightIds, bright, count); break;
      case 'strobe':
      default:           await this._strobe(lightIds, bright, count);     break;
    }
  }

  // ── Flash patterns ───────────────────────────────────────────────────────────

  async _strobe(lightIds, flashState, count) {
    for (let i = 0; i < count; i++) {
      await Promise.all(lightIds.map((id) =>
        this.setState(id, { on: true, ...flashState, transitiontime: 1 })
      ));
      await delay(300);
      await Promise.all(lightIds.map((id) => this.setState(id, { on: false, transitiontime: 1 })));
      await delay(250);
    }
  }

  async _pulse(lightIds, flashState, count) {
    for (let i = 0; i < count; i++) {
      await Promise.all(lightIds.map((id) =>
        this.setState(id, { on: true, ...flashState, bri: 254, transitiontime: 6 })
      ));
      await delay(700);
      await Promise.all(lightIds.map((id) =>
        this.setState(id, { on: true, ...flashState, bri: 20, transitiontime: 6 })
      ));
      await delay(700);
    }
  }

  async _colorshift(lightIds, flashState, count) {
    const white = { hue: 0, sat: 0, bri: 254 };
    for (let i = 0; i < count; i++) {
      await Promise.all(lightIds.map((id) =>
        this.setState(id, { on: true, ...flashState, transitiontime: 2 })
      ));
      await delay(300);
      await Promise.all(lightIds.map((id) =>
        this.setState(id, { on: true, ...white, transitiontime: 2 })
      ));
      await delay(300);
    }
  }

  // ── Utility ──────────────────────────────────────────────────────────────────

  async turnOff(lightIds) {
    await Promise.all(lightIds.map((id) => this.setState(id, { on: false, transitiontime: 20 })));
  }
}

// ── Remote controller (Hue cloud API) ────────────────────────────────────────

class RemoteHueController extends HueController {
  /**
   * @param {object} opts
   * @param {string} opts.username      - Hue bridge API username (from local setup)
   * @param {string} opts.accessToken   - OAuth access token
   * @param {string} opts.refreshToken  - OAuth refresh token (used to renew access token)
   * @param {string} opts.clientId      - Hue developer app client ID
   * @param {string} opts.clientSecret  - Hue developer app client secret
   */
  constructor({ username, accessToken, refreshToken, clientId, clientSecret }) {
    super('remote', username); // base is overwritten below
    this.base = `https://api.meethue.com/route/api/${username}`;
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this._refreshing = null; // deduplicates concurrent refresh calls
  }

  async _request(method, path, body) {
    const url = `${this.base}${path}`;
    try {
      const res = await axios({
        method,
        url,
        data: body,
        headers: { Authorization: `Bearer ${this.accessToken}` },
        timeout: 15000,
      });
      return res;
    } catch (err) {
      // If token expired, refresh and retry once
      if (err.response?.status === 401 && this.refreshToken) {
        console.log('[hue] Access token expired — refreshing...');
        if (!this._refreshing) this._refreshing = this._refreshTokens().finally(() => { this._refreshing = null; });
        await this._refreshing;
        return axios({
          method,
          url,
          data: body,
          headers: { Authorization: `Bearer ${this.accessToken}` },
          timeout: 15000,
        });
      }
      throw err;
    }
  }

  async _refreshTokens() {
    // Another process may have already refreshed the tokens and written new
    // values to .env. If so, adopt those and skip the network call to avoid
    // burning the refresh token a second time (which causes a 400).
    const envOnDisk = require('dotenv').parse(fs.readFileSync(ENV_PATH, 'utf8'));
    if (envOnDisk.HUE_REFRESH_TOKEN && envOnDisk.HUE_REFRESH_TOKEN !== this.refreshToken) {
      console.log('[hue] Picked up refreshed tokens from .env written by another process');
      this.accessToken  = envOnDisk.HUE_ACCESS_TOKEN;
      this.refreshToken = envOnDisk.HUE_REFRESH_TOKEN;
      return;
    }

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await axios.post(
      'https://api.meethue.com/v2/oauth2/token',
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.refreshToken }).toString(),
      {
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 15000,
      }
    );
    this.accessToken = res.data.access_token;
    if (res.data.refresh_token) this.refreshToken = res.data.refresh_token;

    updateEnvFile({
      HUE_ACCESS_TOKEN:  this.accessToken,
      HUE_REFRESH_TOKEN: this.refreshToken,
    });
    console.log('[hue] Tokens refreshed and saved to .env');
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Returns the right HueController for the current environment.
 *
 * Remote mode  — set HUE_MODE=remote in .env (requires OAuth tokens from hue-remote-setup.js)
 * Local mode   — default; uses HUE_BRIDGE_IP + HUE_USERNAME
 */
function createHueController(env) {
  const {
    HUE_MODE,
    HUE_BRIDGE_IP,
    HUE_USERNAME,
    HUE_ACCESS_TOKEN,
    HUE_REFRESH_TOKEN,
    HUE_CLIENT_ID,
    HUE_CLIENT_SECRET,
  } = env;

  if (HUE_MODE === 'remote') {
    if (!HUE_ACCESS_TOKEN || !HUE_REFRESH_TOKEN || !HUE_CLIENT_ID || !HUE_CLIENT_SECRET || !HUE_USERNAME) {
      throw new Error(
        'Remote mode requires HUE_USERNAME, HUE_CLIENT_ID, HUE_CLIENT_SECRET, HUE_ACCESS_TOKEN, ' +
        'and HUE_REFRESH_TOKEN in .env. Run: node hue-remote-setup.js'
      );
    }
    console.log('[hue] Using remote (cloud) API');
    return new RemoteHueController({
      username:      HUE_USERNAME,
      accessToken:   HUE_ACCESS_TOKEN,
      refreshToken:  HUE_REFRESH_TOKEN,
      clientId:      HUE_CLIENT_ID,
      clientSecret:  HUE_CLIENT_SECRET,
    });
  }

  if (!HUE_BRIDGE_IP || !HUE_USERNAME) {
    throw new Error('Missing HUE_BRIDGE_IP or HUE_USERNAME in .env. Run setup, or copy from nsc-hue/.env.');
  }
  return new HueController(HUE_BRIDGE_IP, HUE_USERNAME);
}

module.exports = { HueController, RemoteHueController, createHueController, hexToHueState, parseColorEnv, updateEnvFile };
