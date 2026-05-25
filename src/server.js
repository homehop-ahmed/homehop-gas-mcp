/**
 * server.js — Remote MCP server for Google Apps Script.
 *
 * Single-user, refresh-token-based auth. Designed for Railway/Fly/Render.
 * Speaks Streamable HTTP (the modern MCP transport). claude.ai web supports
 * adding this as a custom connector.
 *
 * Env vars required:
 *   GOOGLE_CLIENT_ID       OAuth client ID from Google Cloud Console
 *   GOOGLE_CLIENT_SECRET   OAuth client secret
 *   GOOGLE_REFRESH_TOKEN   Refresh token from running `npm run setup`
 *   PORT                   (optional) HTTP port, defaults to 3000
 *   MCP_SHARED_SECRET      (optional) Bearer token required from claude.ai.
 *                          Leave unset for authless mode (URL is the secret).
 */

import express from 'express';
import { google } from 'googleapis';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

const PORT = parseInt(process.env.PORT || '3000', 10);
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const SHARED_SECRET = process.env.MCP_SHARED_SECRET || null;

for (const [k, v] of Object.entries({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET, GOOGLE_REFRESH_TOKEN: REFRESH_TOKEN })) {
  if (!v) {
    console.error(`Missing env var: ${k}`);
    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// Google auth (single user, refresh-token flow)
// -----------------------------------------------------------------------------
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

const script = google.script({ version: 'v1', auth: oauth2Client });
const drive = google.drive({ version: 'v3', auth: oauth2Client });
const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

// -----------------------------------------------------------------------------
// Tools
// -----------------------------------------------------------------------------
function makeServer() {
  const server = new McpServer({
    name: 'homehop-gas-mcp',
    version: '0.2.0',
  });

  // ----- gas_get_content -----------------------------------------------------
  server.registerTool(
    'gas_get_content',
    {
      title: 'Read Apps Script project contents',
      description: 'Fetch every file in an Apps Script project. Returns array of {name, type, source}. type is SERVER_JS, HTML, or JSON.',
      inputSchema: { scriptId: z.string().describe('Apps Script project ID (from the editor URL)') },
    },
    async ({ scriptId }) => {
      const res = await script.projects.getContent({ scriptId });
      const files = (res.data.files || []).map(f => ({ name: f.name, type: f.type, source: f.source || '' }));
      return {
        content: [{ type: 'text', text: JSON.stringify({ scriptId, fileCount: files.length, files }, null, 2) }],
      };
    }
  );

  // ----- gas_update_content --------------------------------------------------
  server.registerTool(
    'gas_update_content',
    {
      title: 'Write Apps Script project contents',
      description: 'Replace ALL files in an Apps Script project. Pass full file set — anything omitted will be deleted. To edit one file, call gas_get_content first, modify the file source, then pass the full set back.',
      inputSchema: {
        scriptId: z.string().describe('Apps Script project ID'),
        files: z.array(z.object({
          name: z.string().describe('File name without extension (e.g. "Code")'),
          type: z.enum(['SERVER_JS', 'HTML', 'JSON']).describe('File type'),
          source: z.string().describe('Full file source'),
        })).describe('Complete file set — replaces existing files'),
      },
    },
    async ({ scriptId, files }) => {
      const res = await script.projects.updateContent({
        scriptId,
        requestBody: { files },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({ scriptId, updated: (res.data.files || []).map(f => f.name) }, null, 2) }],
      };
    }
  );

  // ----- gas_patch_file ------------------------------------------------------
  server.registerTool(
    'gas_patch_file',
    {
      title: 'Replace one file in an Apps Script project',
      description: 'Convenience over gas_update_content. Reads existing files, replaces (or adds) the named file, writes them all back. Use this when editing a single .gs file without touching the rest.',
      inputSchema: {
        scriptId: z.string(),
        fileName: z.string().describe('File name without extension'),
        type: z.enum(['SERVER_JS', 'HTML', 'JSON']).default('SERVER_JS'),
        source: z.string().describe('Full new source for the named file'),
      },
    },
    async ({ scriptId, fileName, type, source }) => {
      const cur = await script.projects.getContent({ scriptId });
      const existing = cur.data.files || [];
      const idx = existing.findIndex(f => f.name === fileName);
      if (idx >= 0) existing[idx] = { name: fileName, type, source };
      else existing.push({ name: fileName, type, source });
      const res = await script.projects.updateContent({
        scriptId,
        requestBody: { files: existing.map(f => ({ name: f.name, type: f.type, source: f.source || '' })) },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({ scriptId, patched: fileName, fileCount: (res.data.files || []).length }, null, 2) }],
      };
    }
  );

  // ----- gas_get_project_metadata -------------------------------------------
  server.registerTool(
    'gas_get_project_metadata',
    {
      title: 'Get project metadata (title, parentId, etc.)',
      description: 'Returns the Apps Script project metadata. parentId is the container (spreadsheet/doc) ID for bound scripts.',
      inputSchema: { scriptId: z.string() },
    },
    async ({ scriptId }) => {
      const res = await script.projects.get({ scriptId });
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  // ----- gas_find_bound_script ----------------------------------------------
  server.registerTool(
    'gas_find_bound_script',
    {
      title: 'Find the bound Apps Script project for a spreadsheet',
      description: 'Given a Google Sheets file ID, find the bound Apps Script project ID (if one exists). Searches Drive for child scripts.',
      inputSchema: { spreadsheetId: z.string().describe('Google Sheets file ID') },
    },
    async ({ spreadsheetId }) => {
      // Bound scripts live as Drive files with mimeType=application/vnd.google-apps.script
      // and the container as one of their parents (in supportsAllDrives mode).
      const q = `mimeType='application/vnd.google-apps.script' and '${spreadsheetId}' in parents and trashed=false`;
      let res;
      try {
        res = await drive.files.list({
          q,
          fields: 'files(id,name,createdTime,modifiedTime)',
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        });
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: e.message, hint: 'Bound scripts may not be discoverable via Drive parents; pass scriptId directly from the script editor URL.' }, null, 2) }] };
      }
      const files = res.data.files || [];
      return {
        content: [{ type: 'text', text: JSON.stringify({ spreadsheetId, candidates: files, note: files.length === 0 ? 'No bound script found via Drive parents. Open Extensions → Apps Script in the spreadsheet; copy the scriptId from the URL.' : null }, null, 2) }],
      };
    }
  );

  // ----- gas_create_version --------------------------------------------------
  server.registerTool(
    'gas_create_version',
    {
      title: 'Create a new version of an Apps Script project',
      description: 'Snapshots current content as a versioned release. Required before creating a deployment.',
      inputSchema: {
        scriptId: z.string(),
        description: z.string().default('Version created via MCP'),
      },
    },
    async ({ scriptId, description }) => {
      const res = await script.projects.versions.create({
        scriptId,
        requestBody: { description },
      });
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  // ===========================================================================
  // Sheets tools (direct Google Sheets API — same OAuth, /auth/spreadsheets)
  // ===========================================================================

  // ----- sheets_get_metadata -------------------------------------------------
  server.registerTool(
    'sheets_get_metadata',
    {
      title: 'Get spreadsheet metadata',
      description: 'Returns title and list of all tabs with row/col counts and frozen-row info. Use this first to see what tabs exist before reading or writing.',
      inputSchema: { spreadsheetId: z.string().describe('Google Sheets file ID (from the URL)') },
    },
    async ({ spreadsheetId }) => {
      const res = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'properties.title,sheets.properties(title,sheetId,gridProperties(rowCount,columnCount,frozenRowCount))',
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({
          title: res.data.properties.title,
          tabs: res.data.sheets.map(s => ({
            name: s.properties.title,
            sheetId: s.properties.sheetId,
            rows: s.properties.gridProperties.rowCount,
            cols: s.properties.gridProperties.columnCount,
            frozenRows: s.properties.gridProperties.frozenRowCount || 0,
          })),
        }, null, 2) }],
      };
    }
  );

  // ----- sheets_list_tabs ----------------------------------------------------
  server.registerTool(
    'sheets_list_tabs',
    {
      title: 'List tab names',
      description: 'Lighter than get_metadata — returns just the array of tab names.',
      inputSchema: { spreadsheetId: z.string() },
    },
    async ({ spreadsheetId }) => {
      const res = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets.properties.title',
      });
      return { content: [{ type: 'text', text: JSON.stringify({ tabs: res.data.sheets.map(s => s.properties.title) }, null, 2) }] };
    }
  );

  // ----- sheets_read_range ---------------------------------------------------
  server.registerTool(
    'sheets_read_range',
    {
      title: 'Read cells from a sheet',
      description: 'Read a range in A1 notation. Use TabName for whole tab, TabName!A1:Z for a bounded range, TabName!A:A for a whole column. Returns rows as 2D array.',
      inputSchema: {
        spreadsheetId: z.string(),
        range: z.string().describe('A1 notation, e.g. "Reservations!A1:Z" or "Bank_Transactions"'),
      },
    },
    async ({ spreadsheetId, range }) => {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
      return {
        content: [{ type: 'text', text: JSON.stringify({
          range: res.data.range,
          rowCount: (res.data.values || []).length,
          values: res.data.values || [],
        }, null, 2) }],
      };
    }
  );

  // ----- sheets_append_rows --------------------------------------------------
  server.registerTool(
    'sheets_append_rows',
    {
      title: 'Append rows to a tab',
      description: 'Append rows to the bottom of a tab. Each row is an array of cell values. Strings, numbers, and formulas (start with =) all work. Returns count of rows/cells written.',
      inputSchema: {
        spreadsheetId: z.string(),
        tabName: z.string().describe('Tab name, e.g. "Bank_Transactions"'),
        rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe('Array of rows. Each row is an array of cell values.'),
      },
    },
    async ({ spreadsheetId, tabName, rows }) => {
      const res = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: tabName,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rows },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({
          updatedRange: res.data.updates.updatedRange,
          updatedRows: res.data.updates.updatedRows,
          updatedCells: res.data.updates.updatedCells,
        }, null, 2) }],
      };
    }
  );

  // ----- sheets_update_range -------------------------------------------------
  server.registerTool(
    'sheets_update_range',
    {
      title: 'Overwrite cells in a range',
      description: 'Write values into a specific A1 range. Values 2D array must match range dimensions. Use for in-place updates (e.g. updating a status column).',
      inputSchema: {
        spreadsheetId: z.string(),
        range: z.string().describe('A1 notation, e.g. "Property_Costs!K2:K500"'),
        values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
      },
    },
    async ({ spreadsheetId, range, values }) => {
      const res = await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({
          updatedRange: res.data.updatedRange,
          updatedCells: res.data.updatedCells,
        }, null, 2) }],
      };
    }
  );

  // ----- sheets_clear_range --------------------------------------------------
  server.registerTool(
    'sheets_clear_range',
    {
      title: 'Clear values in a range',
      description: 'Delete cell values in a range. Formatting is preserved. Use TabName to clear an entire tab.',
      inputSchema: {
        spreadsheetId: z.string(),
        range: z.string(),
      },
    },
    async ({ spreadsheetId, range }) => {
      await sheets.spreadsheets.values.clear({ spreadsheetId, range });
      return { content: [{ type: 'text', text: JSON.stringify({ cleared: range }, null, 2) }] };
    }
  );

  // ----- sheets_create_tab ---------------------------------------------------
  server.registerTool(
    'sheets_create_tab',
    {
      title: 'Create a new tab',
      description: 'Add a new tab to the spreadsheet. Fails if a tab with that name already exists.',
      inputSchema: {
        spreadsheetId: z.string(),
        tabName: z.string(),
        rows: z.number().int().positive().default(1000).describe('Initial row count'),
        cols: z.number().int().positive().default(26).describe('Initial column count'),
      },
    },
    async ({ spreadsheetId, tabName, rows, cols }) => {
      const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            addSheet: {
              properties: {
                title: tabName,
                gridProperties: { rowCount: rows, columnCount: cols },
              },
            },
          }],
        },
      });
      const newSheet = res.data.replies[0].addSheet.properties;
      return { content: [{ type: 'text', text: JSON.stringify({ created: newSheet.title, sheetId: newSheet.sheetId }, null, 2) }] };
    }
  );

  // ----- sheets_delete_tab ---------------------------------------------------
  server.registerTool(
    'sheets_delete_tab',
    {
      title: 'Delete a tab',
      description: 'Permanently delete a tab. Irreversible — use with caution. Looks up sheetId by name.',
      inputSchema: {
        spreadsheetId: z.string(),
        tabName: z.string(),
      },
    },
    async ({ spreadsheetId, tabName }) => {
      const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(title,sheetId)' });
      const tab = (meta.data.sheets || []).find(s => s.properties.title === tabName);
      if (!tab) throw new Error(`Tab not found: ${tabName}`);
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ deleteSheet: { sheetId: tab.properties.sheetId } }] },
      });
      return { content: [{ type: 'text', text: JSON.stringify({ deleted: tabName }, null, 2) }] };
    }
  );

  // ----- sheets_format_header ------------------------------------------------
  server.registerTool(
    'sheets_format_header',
    {
      title: 'Apply HomeHop header style to row 1',
      description: 'Applies the HomeHop standard header formatting: bold white text on dark blue (#1F3864), font size 11, left-aligned, and freezes row 1.',
      inputSchema: {
        spreadsheetId: z.string(),
        tabName: z.string(),
      },
    },
    async ({ spreadsheetId, tabName }) => {
      const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(title,sheetId)' });
      const tab = (meta.data.sheets || []).find(s => s.properties.title === tabName);
      if (!tab) throw new Error(`Tab not found: ${tabName}`);
      const sheetId = tab.properties.sheetId;
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              repeatCell: {
                range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: { red: 0.122, green: 0.220, blue: 0.392 },
                    textFormat: {
                      foregroundColor: { red: 1, green: 1, blue: 1 },
                      bold: true,
                      fontSize: 11,
                    },
                    horizontalAlignment: 'LEFT',
                  },
                },
                fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
              },
            },
            {
              updateSheetProperties: {
                properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
                fields: 'gridProperties.frozenRowCount',
              },
            },
          ],
        },
      });
      return { content: [{ type: 'text', text: JSON.stringify({ formatted: tabName }, null, 2) }] };
    }
  );

  return server;
}

// -----------------------------------------------------------------------------
// HTTP / Streamable transport
// -----------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '5mb' }));

// Optional bearer-token gate — set MCP_SHARED_SECRET env var to enable.
app.use('/mcp', (req, res, next) => {
  if (!SHARED_SECRET) return next();
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (got !== SHARED_SECRET) return res.status(401).json({ error: 'unauthorized' });
  next();
});

// Per-session transports keyed by mcp-session-id header.
const transports = new Map();

app.all('/mcp', async (req, res) => {
  try {
    const sid = req.headers['mcp-session-id'];
    let transport;

    if (sid && transports.has(sid)) {
      transport = transports.get(sid);
    } else if (req.method === 'POST') {
      // New session — body should be initialize request.
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSid) => transports.set(newSid, transport),
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      const server = makeServer();
      await server.connect(transport);
    } else {
      return res.status(400).json({ error: 'invalid session' });
    }

    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('MCP error:', e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.get('/healthz', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get('/', (_, res) => res.send('homehop-gas-mcp is running. POST /mcp for MCP protocol.'));

app.listen(PORT, () => {
  console.log(`homehop-gas-mcp listening on :${PORT}`);
  console.log(`Auth mode: ${SHARED_SECRET ? 'bearer-token' : 'authless (URL is the secret)'}`);
});
