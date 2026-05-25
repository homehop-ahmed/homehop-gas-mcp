# Deployment Cheat Sheet

For the impatient. Full detail in [README.md](README.md) and [GOOGLE_CLOUD_SETUP.md](GOOGLE_CLOUD_SETUP.md).

## What you'll have at the end

Claude (in claude.ai chat) can read and write Google Apps Script projects directly. No more pasting `.gs` files. Every edit to HomeHop OS goes through chat.

## Phase 1 — Google Cloud (15 min)

1. console.cloud.google.com → New project `homehop-gas-mcp` (signed into `admin@gamanagement.co`)
2. APIs & Services → Library → enable **Apps Script API**, **Google Sheets API**, and **Google Drive API**
3. OAuth consent screen → External → fill basics → add scopes:
   - `auth/script.projects`, `auth/script.scriptapp`, `auth/script.external_request`
   - `auth/drive`, `auth/drive.scripts`, `auth/spreadsheets`
4. Test users → add yourself
5. Credentials → Create OAuth client ID → **Desktop app** type → save `CLIENT_ID` and `CLIENT_SECRET`

## Phase 2 — Local refresh token (5 min)

On your laptop:
```bash
git clone <your-repo>
cd homehop-gas-mcp
npm install
GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy npm run setup
```
Approve consent in the browser tab that opens. Copy the printed `refresh_token`.

## Phase 3 — Deploy to Railway (10 min)

1. Push to GitHub (private repo)
2. railway.app → New Project → Deploy from GitHub → pick the repo
3. Variables tab → add:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REFRESH_TOKEN`
4. Settings → Networking → Generate Domain → copy URL
5. Visit `<url>/healthz` → should return `{"ok":true,…}`

## Phase 4 — claude.ai connector (5 min)

1. claude.ai → Settings → Connectors → Add custom connector
2. URL: `<railway-url>/mcp`
3. Add → toggle on in chat composer
4. Test both surfaces:
   - **Apps Script:** "Using homehop-gas-mcp, get content for scriptId `14w8UkFMvGW4vEGwKahTpD6hWgWK9xS2jbLCSPlN7MhF_nnLthQvHQnD9`" — should return the HomeHop OS file list
   - **Sheets:** "Using homehop-gas-mcp, get metadata for spreadsheet `1qPtZcymg9dPvgcbXo3oaYgTDwphHZpy7-YZRy2thgKU`" — should return "HomeHop_Finance" + tab list

Done. Future edits to HomeHop OS and direct sheet writes happen by asking Claude.

## If something breaks

| Symptom | Fix |
|---|---|
| Railway build fails | Check `package.json` is at repo root, Node 22 |
| `/healthz` returns 502 | Railway logs → usually env var missing |
| `invalid_grant` errors | Refresh token revoked — re-run `npm run setup` |
| Tool calls return 401 | Connector toggle isn't on in this chat |
| `scriptId not found` | Wrong Google account — re-run setup signed into the right one |
