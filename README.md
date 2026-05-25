# homehop-gas-mcp

Remote MCP server that gives Claude direct read/write access to **Google Apps Script projects** AND **Google Sheets** via the official Google APIs. Bypasses the `script.google.com` block in Claude in Chrome and the lack of Sheets-write in claude.ai's default connectors.

After this is deployed and connected to claude.ai, Claude can:

**Apps Script (6 tools):**
- Read the current content of any Apps Script project you own
- Replace one file or the whole project (push code from chat → live in the editor instantly)
- Create versioned snapshots
- Look up the bound script for a Sheets / Docs / Slides file

**Google Sheets (9 tools):**
- Get metadata (title, tabs, row/col counts)
- Read any range or whole tab
- Append rows to the bottom of a tab
- Update specific ranges (in-place edits)
- Clear ranges (preserve formatting)
- Create new tabs
- Delete tabs
- Apply HomeHop header formatting (bold white on `#1F3864`, freeze row 1)

## Architecture in 30 seconds

```
[claude.ai chat] ──HTTPS──► [this server on Railway] ──Google API──► [Apps Script + Sheets]
                                       │
                                       └─ uses YOUR Google refresh_token (single-user mode)
```

Single-user setup: you authorize once locally (with `npm run setup`), the server then uses your stored `refresh_token` for every API call. The URL of the deployed server is the secret — keep it private. Optionally set `MCP_SHARED_SECRET` for an extra bearer-token gate.

## What changed in v0.2.0

Added 9 Sheets tools alongside the existing 6 Apps Script tools. The OAuth scopes already included `auth/spreadsheets` so no GCP changes needed — same Client ID, same refresh token, same Railway deploy. If you've previously deployed v0.1.0, just push the updated `src/server.js` and Railway auto-redeploys.

## Deployment — the full walkthrough

There are four phases. Total wall time ≈ 45 min if it's your first time, ~15 min thereafter.

### Phase 1 — Google Cloud OAuth setup (~15 min)

See [GOOGLE_CLOUD_SETUP.md](GOOGLE_CLOUD_SETUP.md). At the end you'll have:
- A Google Cloud project with the Apps Script API + Drive API enabled
- An OAuth 2.0 Client ID (Desktop application type) — note the Client ID and Client Secret

### Phase 2 — Get a refresh token locally (~5 min)

On your laptop (one-time, not on the server):

```bash
git clone <your-fork-of-this-repo>
cd homehop-gas-mcp
npm install
GOOGLE_CLIENT_ID=...your-id... GOOGLE_CLIENT_SECRET=...your-secret... npm run setup
```

A browser tab opens to Google's consent screen. Approve. The terminal prints a long refresh token — copy it. This is the credential the deployed server will use to call Google APIs on your behalf.

### Phase 3 — Deploy to Railway (~10 min)

1. Push this folder to a private GitHub repo.
2. Go to [railway.app](https://railway.app), sign in with GitHub, click **New Project** → **Deploy from GitHub repo**.
3. Pick your fork. Railway auto-detects the Dockerfile and starts a build.
4. Once deployed, click into the service → **Variables** tab → add three env vars:
   ```
   GOOGLE_CLIENT_ID       = <from Google Cloud>
   GOOGLE_CLIENT_SECRET   = <from Google Cloud>
   GOOGLE_REFRESH_TOKEN   = <from npm run setup>
   ```
   Optional: add `MCP_SHARED_SECRET=<some-random-string>` for an extra bearer-token check.
5. **Settings** tab → **Networking** → **Generate Domain**. Copy the URL (something like `https://homehop-gas-mcp-production.up.railway.app`).
6. Test it: visit `<your-url>/healthz` in a browser. Should return `{"ok":true,...}`.

### Phase 4 — Add to claude.ai (~5 min)

1. In claude.ai → **Settings** → **Connectors** (or **Customize → Connectors** on some plans).
2. Scroll to bottom → **Add custom connector**.
3. **Name**: `Apps Script` (or whatever you want).
4. **MCP server URL**: `<your-railway-url>/mcp` (note the `/mcp` suffix).
5. Click **Add**. (No OAuth client ID/secret needed unless you set `MCP_SHARED_SECRET`.)
6. In a new claude.ai chat, click the **`+`** in the composer → **Connectors** → toggle on "Apps Script".

Test it: ask Claude "list my Apps Script projects" or "read the contents of script project `<scriptId>`". If you get JSON back with file contents, you're done.

## Tools exposed

| Tool | What it does |
|---|---|
| `gas_get_content` | Read all files in a project (returns `[{name,type,source},…]`) |
| `gas_update_content` | Replace the entire file set in a project — full-project overwrite |
| `gas_patch_file` | Read existing, replace one named file, write back — single-file edit |
| `gas_get_project_metadata` | Title, createTime, parentId, etc. |
| `gas_find_bound_script` | Given a Sheets file ID, find its bound script (may not always work — Drive parent linking isn't guaranteed) |
| `gas_create_version` | Snapshot a versioned release |

## Editing HomeHop OS from chat (the payoff)

Once connected, every future change to HomeHop OS goes through chat:

> "Read the current HomeHop OS code (scriptId `14w8UkFMvGW4vEGwKahTpD6hWgWK9xS2jbLCSPlN7MhF_nnLthQvHQnD9`). The `fillVendorInvoiceRefs` function is missing a pattern for 'GU' — add it and patch the file."

Claude calls `gas_patch_file` directly. Apps Script editor reflects the change instantly. No copy-paste, no OAuth re-consent (the bound script's consent persists), no Claude in Chrome.

## Security notes

- The `GOOGLE_REFRESH_TOKEN` env var IS the master key. Anyone with that token has the same Apps Script + Drive access as you. Keep Railway variables locked down.
- The deployed URL acts as a secret in authless mode. Don't post the `/mcp` URL publicly. For extra safety set `MCP_SHARED_SECRET`.
- This is single-user. Don't share the connector URL with anyone — they'd be acting as you.

## Updating the server

Push to the GitHub branch Railway is watching. It auto-rebuilds and redeploys. Bump the version in `package.json` if you want claude.ai to see the version change.

## Troubleshooting

- **`/healthz` returns 502** → check Railway logs. Usually an env var is missing.
- **Claude says "tool not available"** → toggle the connector off and on in the chat composer.
- **`invalid_grant` error from Google** → the refresh token was revoked. Re-run `npm run setup` and update `GOOGLE_REFRESH_TOKEN` in Railway.
- **`scriptId not found` on a real ID** → the OAuth refresh token might be authorized for a different Google account than the one that owns the script. Re-run setup signed into the right account.
