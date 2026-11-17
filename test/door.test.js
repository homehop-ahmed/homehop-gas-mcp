import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDoor, parseMode, cleanUrl, cleanBase, allow } from '../src/door.js';

const CONN = 'https://connector.example';
const BASE = 'https://bridge.example';

function stub(replies) {
  // replies: function(token) -> { status, body } | throws
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const token = String(opts.headers.Authorization).replace(/^Bearer /, '');
    calls.push({ url, token, opts });
    const r = replies(token, calls.length);
    return { status: r.status, json: async () => r.body };
  };
  return { fetchImpl, calls };
}
const admin = { kind: 'person', role: 'admin' };
const okReply = (identity) => ({ status: 200, body: { ok: true, result: identity } });

function make(envExtra = {}, replies = () => okReply(admin), clock = { t: 1_000_000 }) {
  const s = stub(replies);
  const door = createDoor({ env: { HH_CONNECTOR_URL: CONN, PUBLIC_URL: BASE, ...envExtra }, fetchImpl: s.fetchImpl, now: () => clock.t });
  return { door, calls: s.calls, clock };
}

test('mode parsing', () => {
  assert.equal(parseMode({}), 'open');
  assert.equal(parseMode({ AUTH_MODE: 'on' }), 'on');
  assert.equal(parseMode({ AUTH_MODE: ' ON ' }), 'on');
  assert.equal(parseMode({ AUTH_MODE: 'off' }), 'open');
});

test('connector and base cleaning', () => {
  assert.equal(cleanUrl(' https://connector.example/// '), CONN);
  assert.equal(cleanUrl('http://connector.example'), null);
  assert.equal(cleanUrl('http://127.0.0.1:4000/'), 'http://127.0.0.1:4000');
  assert.equal(cleanUrl(''), null);
  assert.equal(cleanUrl(undefined), null);
  assert.equal(cleanBase({ PUBLIC_URL: BASE + '/' }), BASE);
  assert.equal(cleanBase({ RAILWAY_PUBLIC_DOMAIN: 'bridge.example' }), BASE);
  assert.equal(cleanBase({ PUBLIC_URL: BASE, RAILWAY_PUBLIC_DOMAIN: 'other.example' }), BASE);
  assert.equal(cleanBase({}), null);
});

test('admin rule and scope rule', () => {
  assert.deepEqual(allow(admin), { ok: true, who: 'person:admin' });
  assert.equal(allow({ kind: 'person', role: 'ops' }).ok, false);
  assert.deepEqual(allow({ kind: 'job', jobId: 'J1', scopes: ['script_bridge:write'] }), { ok: true, who: 'job:J1' });
  assert.equal(allow({ kind: 'job', jobId: 'J2', scopes: ['other:read'] }).ok, false);
  assert.deepEqual(allow({ kind: 'job', jobId: 'J3', scopes: ['*:*'] }), { ok: true, who: 'job:J3' });
  assert.equal(allow(null).ok, false);
});

test('decision table: no connector', async () => {
  const d = createDoor({ env: {}, fetchImpl: async () => { throw new Error('no fetch'); } });
  assert.deepEqual(await d.decide({ token: 'x', secure: true }), { status: 503, who: null, error: 'door not configured' });
  const open = await d.decide({ token: 'x', secure: false });
  assert.equal(open.status, 200);
  assert.equal(open.who, 'anonymous');
  const on = createDoor({ env: { AUTH_MODE: 'on' } });
  assert.equal((await on.decide({ token: null, secure: false })).status, 503);
});

test('decision table: no token', async () => {
  const { door } = make();
  assert.deepEqual(await door.decide({ token: null, secure: true }), { status: 401, who: null, error: 'unauthorized' });
  assert.equal((await door.decide({ token: null, secure: false })).who, 'anonymous');
  const on = make({ AUTH_MODE: 'on' }).door;
  assert.equal((await on.decide({ token: null, secure: false })).status, 401);
});

test('decision table: valid and allowed', async () => {
  const { door } = make();
  for (const secure of [true, false]) {
    assert.deepEqual(await door.decide({ token: 't', secure }), { status: 200, who: 'person:admin', error: null });
  }
});

test('decision table: valid but not allowed', async () => {
  const { door } = make({}, () => okReply({ kind: 'person', role: 'ops' }));
  assert.deepEqual(await door.decide({ token: 't', secure: true }), { status: 403, who: null, error: 'forbidden' });
  assert.equal(door.snapshot().refused, 0);
  const open = await door.decide({ token: 't', secure: false });
  assert.equal(open.status, 200);
  assert.equal(open.who, 'anonymous');
  assert.equal(door.snapshot().refused, 1);
});

test('decision table: invalid token', async () => {
  const { door } = make({}, () => ({ status: 401, body: {} }));
  assert.deepEqual(await door.decide({ token: 't', secure: true }), { status: 401, who: null, error: 'unauthorized' });
  assert.equal(door.snapshot().bad_tokens, 0);
  const open = await door.decide({ token: 't', secure: false });
  assert.equal(open.who, 'anonymous');
  assert.equal(door.snapshot().bad_tokens, 1);
  const { door: d403 } = make({}, () => ({ status: 403, body: {} }));
  assert.equal((await d403.decide({ token: 't', secure: true })).status, 401);
});

test('decision table: connector unavailable, nothing cached', async () => {
  const { door } = make({}, () => ({ status: 500, body: {} }));
  assert.deepEqual(await door.decide({ token: 't', secure: true }), { status: 503, who: null, error: 'sign-in check unavailable' });
  assert.equal((await door.decide({ token: 't', secure: false })).who, 'anonymous');
  const thrower = createDoor({ env: { HH_CONNECTOR_URL: CONN }, fetchImpl: async () => { throw new Error('net'); } });
  assert.equal((await thrower.verify('t')).state, 'unavailable');
});

test('verify sends the request shape', async () => {
  const { door, calls } = make();
  await door.verify('tok');
  assert.equal(calls[0].url, CONN + '/api/whoami');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.body, '{}');
  assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].token, 'tok');
});

test('a valid answer is reused for 5 minutes', async () => {
  const { door, calls, clock } = make();
  await door.verify('t');
  clock.t += 4 * 60 * 1000;
  await door.verify('t');
  assert.equal(calls.length, 1);
  clock.t += 2 * 60 * 1000;
  await door.verify('t');
  assert.equal(calls.length, 2);
});

test('60 minute grace when the connector fails', async () => {
  let down = false;
  const { door, calls, clock } = make({}, () => (down ? { status: 503, body: {} } : okReply(admin)));
  await door.verify('t');
  down = true;
  clock.t += 10 * 60 * 1000;
  const v = await door.verify('t');
  assert.equal(v.state, 'valid');
  assert.equal(calls.length, 2);
  clock.t += 55 * 60 * 1000; // 65 minutes since the valid answer
  assert.equal((await door.verify('t')).state, 'unavailable');
});

test('an invalid answer clears the cache', async () => {
  let bad = false;
  const { door, clock } = make({}, () => (bad ? { status: 401, body: {} } : okReply(admin)));
  await door.verify('t');
  bad = true;
  clock.t += 6 * 60 * 1000;
  assert.equal((await door.verify('t')).state, 'invalid');
  bad = false;
  clock.t += 1000;
  // cache was cleared, so a connector outage now has no grace entry
  const down = make({}, () => ({ status: 503, body: {} }));
  assert.equal((await down.door.verify('t')).state, 'unavailable');
  bad = true;
  const again = await door.verify('t');
  assert.equal(again.state, 'invalid');
});

test('the cache key is not the token', async () => {
  // Observable: the token never appears in the snapshot, and changing one char refetches.
  const { door, calls } = make();
  await door.verify('secret-token-value');
  await door.verify('secret-token-value');
  await door.verify('secret-token-valuE');
  assert.equal(calls.length, 2);
  await door.decide({ token: 'secret-token-value', secure: true });
  door.record({ who: 'person:admin', client: 'x', path: 'secure', tool: 'gas_get_content' });
  assert.ok(!JSON.stringify(door.snapshot()).includes('secret-token-value'));
});

test('cache is capped at 500 entries, oldest dropped', async () => {
  const { door, calls } = make();
  for (let i = 0; i < 501; i++) await door.verify('t' + i);
  assert.equal(calls.length, 501);
  await door.verify('t500');
  assert.equal(calls.length, 501); // newest still cached
  await door.verify('t0');
  assert.equal(calls.length, 502); // oldest was dropped
});

test('client label cleaning and session memory', () => {
  const { door } = make();
  const init = { method: 'initialize', params: { clientInfo: { name: 'Claude<script>ai!! v1.0/x' } } };
  assert.equal(door.clientLabel({ body: init, userAgent: 'claude-user/1.0 (extra stuff)', sessionId: undefined }), 'Claudescriptai v1.0/x|claude-user/1.0');
  const long = door.clientLabel({ body: { method: 'initialize', params: { clientInfo: { name: 'a'.repeat(80) } } }, userAgent: 'b'.repeat(60) });
  assert.equal(long, 'a'.repeat(40) + '|' + 'b'.repeat(30));
  assert.equal(door.clientLabel({ body: { method: 'tools/list' }, userAgent: 'curl/8.0', sessionId: 's1' }), '?|curl/8.0');
  door.rememberClient('s1', 'Claude|ua');
  assert.equal(door.clientLabel({ body: { method: 'tools/list' }, userAgent: 'curl/8.0', sessionId: 's1' }), 'Claude|ua');
  door.forgetClient('s1');
  assert.equal(door.clientLabel({ body: {}, userAgent: 'curl/8.0', sessionId: 's1' }), '?|curl/8.0');
});

test('record: rows, tools and caps', () => {
  const { door } = make();
  door.record({ who: 'anonymous', client: 'c', path: 'mcp', tool: 'zeta' });
  door.record({ who: 'anonymous', client: 'c', path: 'mcp', tool: 'alpha' });
  door.record({ who: 'anonymous', client: 'c', path: 'mcp', tool: 'alpha' });
  door.record({ who: 'anonymous', client: 'c', path: 'secure' });
  const snap = door.snapshot();
  assert.equal(snap.callers.length, 2);
  const row = snap.callers.find((r) => r.path === 'mcp');
  assert.equal(row.calls, 3);
  assert.deepEqual(row.tools, ['alpha', 'zeta']);
  assert.ok(row.first_at && row.last_at);

  const t = make().door;
  for (let i = 0; i < 30; i++) t.record({ who: 'anonymous', client: 'c', path: 'mcp', tool: 'tool_' + String(i).padStart(2, '0') });
  assert.equal(t.snapshot().callers[0].tools.length, 20);

  const r = make().door;
  for (let i = 0; i < 100; i++) r.record({ who: 'job:J' + i, client: 'c', path: 'mcp' });
  const rows = r.snapshot().callers;
  assert.ok(rows.length <= 60);
  const other = rows.find((x) => x.who === 'other');
  assert.ok(other && other.calls >= 41);
  assert.equal(rows.reduce((n, x) => n + x.calls, 0), 100);
});

test('record keeps the who and client separators', () => {
  const { door } = make();
  door.record({ who: 'person:admin', client: 'Claude|ua', path: 'secure' });
  const row = door.snapshot().callers[0];
  assert.equal(row.who, 'person:admin');
  assert.equal(row.client, 'Claude|ua');
});

test('snapshot shape', () => {
  const { door } = make();
  const s = door.snapshot();
  assert.deepEqual(Object.keys(s).sort(), ['bad_tokens', 'callers', 'door_ready', 'mode', 'refused', 'started_at']);
  assert.equal(s.door_ready, true);
  assert.equal(s.mode, 'open');
  assert.equal(createDoor({ env: {} }).snapshot().door_ready, false);
});

test('metadata and challenge', () => {
  const { door } = make();
  assert.deepEqual(door.metadata('/secure/mcp'), { resource: BASE + '/secure/mcp', authorization_servers: [CONN], bearer_methods_supported: ['header'] });
  assert.equal(door.challenge('/mcp'), `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
  const nobase = createDoor({ env: { HH_CONNECTOR_URL: CONN } });
  assert.equal(nobase.metadata('/mcp'), null);
  assert.equal(nobase.challenge('/mcp'), null);
  const noconn = createDoor({ env: { PUBLIC_URL: BASE } });
  assert.equal(noconn.metadata('/mcp'), null);
  assert.ok(noconn.challenge('/mcp'));
});

test('a refused call is listed once per caller with the status in who', () => {
  const { door } = make();
  door.record({ who: 'refused:401', client: 'x|y', path: 'mcp', tool: 'sheets_read_range' });
  door.record({ who: 'refused:401', client: 'x|y', path: 'mcp', tool: 'sheets_read_range' });
  const rows = door.snapshot().callers;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].who, 'refused:401');
  assert.equal(rows[0].calls, 2);
  assert.deepEqual(rows[0].tools, ['sheets_read_range']);
});
