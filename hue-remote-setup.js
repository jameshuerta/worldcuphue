/**
 * One-time setup for the Philips Hue Remote API (OAuth 2.0).
 *
 * Only needed if you want to run watcher.js from outside your home network
 * (e.g. a cloud server). On your home Mac, local mode (the default) is simpler.
 *
 * You need HUE_USERNAME already in .env (copy it from your nsc-hue/.env,
 * or run the local setup steps in that project first).
 *
 * What you need first:
 *   1. Create a free account at https://developers.meethue.com
 *   2. Go to "My Apps" → create a new app
 *   3. Set the redirect URI to: http://localhost:45678/callback
 *   4. Note your Client ID and Client Secret
 *
 * Then run:
 *   node hue-remote-setup.js
 *
 * This script will:
 *   - Ask for your Client ID and Client Secret
 *   - Open the Hue authorization page in your browser
 *   - Catch the OAuth callback automatically
 *   - Exchange the auth code for tokens
 *   - Write HUE_MODE=remote + tokens to .env
 */

require('dotenv').config();
const http = require('http');
const axios = require('axios');
const readline = require('readline');
const { execSync } = require('child_process');
const { updateEnvFile } = require('./hue');

const CALLBACK_PORT = 45678;
const REDIRECT_URI  = `http://localhost:${CALLBACK_PORT}/callback`;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

function openBrowser(url) {
  try {
    execSync(`open "${url}"`);
  } catch {
    // Non-macOS or open failed — user will paste manually
  }
}

/**
 * Starts a temporary local HTTP server, waits for the OAuth callback,
 * and resolves with the authorization code from the query string.
 */
function waitForCallback() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      const code  = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h2>Authorization denied.</h2><p>You can close this tab and check the terminal.</p>');
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>Authorization successful!</h2><p>You can close this tab and return to the terminal.</p>');
        server.close();
        resolve(code);
      }
    });

    server.listen(CALLBACK_PORT, () => {
      // Server is ready
    });

    server.on('error', (err) => {
      reject(new Error(`Could not start callback server on port ${CALLBACK_PORT}: ${err.message}`));
    });
  });
}

async function exchangeCodeForTokens(code, clientId, clientSecret) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await axios.post(
    'https://api.meethue.com/v2/oauth2/token',
    new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }).toString(),
    {
      headers: {
        Authorization:  `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 15000,
    }
  );
  return {
    accessToken:  res.data.access_token,
    refreshToken: res.data.refresh_token,
  };
}

async function main() {
  console.log('\n=== World Cup Hue — Remote API Setup ===\n');

  if (!process.env.HUE_USERNAME) {
    console.error('HUE_USERNAME not found in .env. Copy it from your nsc-hue/.env first.');
    process.exit(1);
  }

  console.log('Before continuing, make sure you have:');
  console.log('  1. A free developer account at https://developers.meethue.com');
  console.log('  2. Created an app in "My Apps"');
  console.log(`  3. Set the redirect URI to: ${REDIRECT_URI}\n`);

  let clientId     = process.env.HUE_CLIENT_ID     || '';
  let clientSecret = process.env.HUE_CLIENT_SECRET || '';

  if (clientId && clientSecret) {
    console.log(`Using existing credentials from .env (Client ID: ${clientId})\n`);
  } else {
    clientId     = (await ask('Enter your Client ID:     ')).trim();
    clientSecret = (await ask('Enter your Client Secret: ')).trim();

    if (!clientId || !clientSecret) {
      console.error('Client ID and Client Secret are required.');
      process.exit(1);
    }
  }

  // Build the authorization URL
  const state    = Math.random().toString(36).slice(2);
  const authUrl  = `https://api.meethue.com/v2/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&response_type=code&state=${state}`;

  console.log('\nOpening authorization page in your browser...');
  console.log(`If it doesn't open, paste this URL manually:\n\n  ${authUrl}\n`);
  openBrowser(authUrl);

  console.log('Waiting for you to approve access in the browser...');

  let code;
  try {
    code = await waitForCallback();
  } catch (err) {
    console.error('\nAuthorization failed:', err.message);
    rl.close();
    process.exit(1);
  }

  console.log('\nAuthorization code received. Exchanging for tokens...');

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(code, clientId, clientSecret);
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('Token exchange failed:', detail);
    rl.close();
    process.exit(1);
  }

  // Write everything to .env
  updateEnvFile({
    HUE_MODE:          'remote',
    HUE_CLIENT_ID:     clientId,
    HUE_CLIENT_SECRET: clientSecret,
    HUE_ACCESS_TOKEN:  tokens.accessToken,
    HUE_REFRESH_TOKEN: tokens.refreshToken,
  });

  console.log('\n.env updated with remote API credentials.');
  console.log('\nYou can now run from anywhere:');
  console.log('  node watcher.js\n');
  console.log('To switch back to local mode, set HUE_MODE=local in .env.\n');

  rl.close();
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
