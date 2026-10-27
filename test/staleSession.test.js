import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Guards the /mcp session rule: an unknown mcp-session-id must get 404 (client re-initializes),
// a request without a session id may still open a new session. Checked on the source text so the
// test needs no Google credentials or network.
const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

test('unknown session id is answered with 404 before any transport is created', () => {
  const known = src.indexOf('if (sid && transports.has(sid))');
  const stale = src.indexOf('} else if (sid) {');
  const fresh = src.indexOf("} else if (req.method === 'POST') {");
  assert.ok(known > 0 && stale > known && fresh > stale, 'branch order: known session, stale session, new session');
  const staleBody = src.slice(stale, fresh);
  assert.match(staleBody, /res\.status\(404\)/);
  assert.doesNotMatch(staleBody, /new StreamableHTTPServerTransport/);
});
