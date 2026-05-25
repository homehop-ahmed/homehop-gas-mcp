# Google Cloud OAuth setup

You need:
- A Google Cloud project
- Apps Script API + Drive API enabled
- An OAuth 2.0 Client ID + Secret (Desktop application type)

Total time: ~15 min, first time only.

## Step 1 — Create / pick a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com).
2. Sign in with the **same Google account that owns the Apps Script projects** you'll be editing (for you: `admin@gamanagement.co`).
3. Top-left dropdown next to "Google Cloud" → **New Project**.
4. Name it `homehop-gas-mcp` (or anything). Click **Create**.
5. Once created, make sure it's selected in the top-left dropdown.

## Step 2 — Enable the required APIs

1. Left sidebar → **APIs & Services** → **Library**.
2. Search **Apps Script API** → click it → **Enable**.
3. Back to Library, search **Google Drive API** → **Enable**.
4. Search **Google Sheets API** → **Enable**. (Required as of v0.2.0 for sheets_* tools.)

## Step 3 — Configure the OAuth consent screen

This is the screen users see when authorizing — for single-user use you'll only see it yourself, once.

1. Left sidebar → **APIs & Services** → **OAuth consent screen**.
2. User type: **External**. Click **Create**.
3. **App information**:
   - App name: `homehop-gas-mcp`
   - User support email: your email
   - Developer contact: your email
4. Click **Save and continue**.
5. **Scopes**: click **Add or remove scopes**, then add (search/paste each):
   - `.../auth/script.projects`
   - `.../auth/script.scriptapp`
   - `.../auth/script.external_request`
   - `.../auth/drive`
   - `.../auth/drive.scripts`
   - `.../auth/spreadsheets`
6. **Save and continue**.
7. **Test users**: click **Add users**, enter your own Gmail (`admin@gamanagement.co`). **Save and continue**.
8. **Summary**: review, **Back to dashboard**.

**Important:** the app stays in "Testing" mode. Test users (just you) can authorize. You don't need to publish — that triggers Google's verification review.

## Step 4 — Create the OAuth Client ID

1. Left sidebar → **APIs & Services** → **Credentials**.
2. **+ Create credentials** → **OAuth client ID**.
3. **Application type**: **Desktop app**.
   - Why Desktop, not Web? Because we use the loopback redirect (`http://localhost:8765/oauth/callback`) for the one-time setup. Desktop client type allows this. The setup script is the only thing that does OAuth — the deployed server only refreshes tokens.
4. Name: `homehop-gas-mcp-cli`.
5. Click **Create**.
6. A dialog shows the **Client ID** and **Client Secret**. Copy both into a temporary text file — you'll need them in two places (`npm run setup` and the Railway env vars). You can also download the JSON.

## Step 5 — Done

You now have:
- `GOOGLE_CLIENT_ID=...apps.googleusercontent.com`
- `GOOGLE_CLIENT_SECRET=GOCSPX-...`

Go back to [README.md → Phase 2](README.md#phase-2--get-a-refresh-token-locally-5-min) and run `npm run setup` with these credentials to get your refresh token.

## Troubleshooting

- **"Access blocked: This app's request is invalid"** during `npm run setup` → the redirect URI doesn't match. Make sure the OAuth client is **Desktop app** type. If you accidentally made a Web client, delete it and recreate as Desktop.
- **"Error 403: access_denied"** after consenting → your Google account isn't in the test user list. Go back to OAuth consent screen → Test users → Add users.
- **"Apps Script API has not been used in project..."** when calling tools → you skipped Step 2. Go enable the API.
