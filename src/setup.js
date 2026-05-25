/**
 * setup.js — one-time OAuth flow to grab a Google refresh_token.
 *
 * Usage:
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node src/setup.js
 *
 * Walks you through Google's OAuth consent screen, then prints the
 * refresh_token. Paste it as GOOGLE_REFRESH_TOKEN in your Railway env vars.
 *
 * Run this ONCE locally on your laptop, not on the deployed server.
 */

import { google } from 'googleapis';
import express from 'express';
import open from 'open';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT = 8765;
const REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('ERROR: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars.');
  console.error('Get these from Google Cloud Console — see GOOGLE_CLOUD_SETUP.md');
  process.exit(1);
}

const SCOPES = [
  'https://www.googleapis.com/auth/script.projects',
  'https://www.googleapis.com/auth/script.scriptapp',
  'https://www.googleapis.com/auth/script.external_request',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.scripts',
  'https://www.googleapis.com/auth/spreadsheets',
];

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // force refresh_token issuance
  scope: SCOPES,
});

const app = express();

app.get('/oauth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    res.status(400).send('Missing code');
    return;
  }
  try {
    const { tokens } = await oauth2Client.getToken(code);
    console.log('\n=== SUCCESS ===');
    console.log('Refresh token (save this as GOOGLE_REFRESH_TOKEN):\n');
    console.log(tokens.refresh_token);
    console.log('\nAccess token (just for verification, expires in 1hr):\n');
    console.log(tokens.access_token);
    console.log('\nDone. You can close this terminal.');
    res.send('<h1>Success</h1><p>Check your terminal for the refresh token. You can close this tab.</p>');
    setTimeout(() => process.exit(0), 500);
  } catch (err) {
    console.error('Token exchange failed:', err);
    res.status(500).send('Token exchange failed: ' + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`\nOAuth setup running at http://localhost:${PORT}`);
  console.log('Opening Google consent screen in your browser...\n');
  open(authUrl);
});
