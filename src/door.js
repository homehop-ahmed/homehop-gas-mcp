/**
 * door.js - the sign-in door for the bridge.
 *
 * Asks the HomeHop connector who a caller is, decides whether to let them in,
 * and keeps a small, token-free record of who calls. Pure module: it does not
 * import server.js and reads no process.env at load.
 *
 * While AUTH_MODE is not "on", /mcp lets everyone through exactly as before
 * (a signed-in caller is just recognised). /secure/mcp always demands sign-in.
 */

import { createHash } from 'node:crypto';

const VERIFY_TIMEOUT_MS = 8000;
const FRESH_MS = 5 * 60 * 1000;
const GRACE_MS = 60 * 60 * 1000;
const MAX_CACHE = 500;
const MAX_ROWS = 60;
const MAX_TOOLS = 20;
const MAX_SESSIONS = 2000;

export function parseMode(env) {
  return String((env || {}).AUTH_MODE).trim().toLowerCase() === 'on' ? 'on' : 'open';
}

/** Trim, drop trailing slashes, require https:// (or the local http://127.0.0.1: for the smoke). */
export function cleanUrl(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/\/+$/, '');
  if (!s) return null;
  if (s.startsWith('https://') || s.startsWith('http://127.0.0.1:')) return s;
  return null;
}

export function cleanBase(env) {
  const e = env || {};
  const explicit = cleanUrl(e.PUBLIC_URL);
  if (explicit) return explicit;
  const dom = e.RAILWAY_PUBLIC_DOMAIN ? String(e.RAILWAY_PUBLIC_DOMAIN).trim() : '';
  return dom ? cleanUrl('https://' + dom) : null;
}

export function allow(identity) {
  if (!identity || typeof identity !== 'object') return { ok: false, who: null };
  if (identity.kind === 'person' && identity.role === 'admin') return { ok: true, who: 'person:admin' };
  if (identity.kind === 'job') {
    const scopes = Array.isArray(identity.scopes) ? identity.scopes : [];
    if (scopes.includes('script_bridge:write') || scopes.includes('*:*')) {
      return { ok: true, who: 'job:' + identity.jobId };
    }
  }
  return { ok: false, who: null };
}

export function cleanName(v, max) {
  return String(v == null ? '' : v).replace(/[^A-Za-z0-9 ._/-]/g, '').slice(0, max);
}

function uaWord(userAgent) {
  const first = String(userAgent || '').trim().split(/\s+/)[0] || '';
  return cleanName(first, 30);
}

export function createDoor({ env = {}, fetchImpl = fetch, now = Date.now } = {}) {
  const mode = parseMode(env);
  const connector = cleanUrl(env.HH_CONNECTOR_URL);
  const base = cleanBase(env);
  const startedAt = new Date(now()).toISOString();

  const cache = new Map(); // sha256(token) -> { identity, at }
  const sessions = new Map(); // session id -> client label
  const rows = new Map(); // who|client|path -> row
  let badTokens = 0;
  let refused = 0;

  const keyOf = (token) => createHash('sha256').update(String(token)).digest('hex');

  async function verify(token) {
    const key = keyOf(token);
    const hit = cache.get(key);
    if (hit && now() - hit.at < FRESH_MS) return { state: 'valid', identity: hit.identity };
    let state = 'unavailable';
    let identity = null;
    try {
      const res = await fetchImpl(connector + '/api/whoami', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) {
        state = 'invalid';
      } else if (res.status === 200) {
        const j = await res.json();
        if (j && j.ok === true && j.result && typeof j.result === 'object') {
          state = 'valid';
          identity = j.result;
        }
      }
    } catch (_) {
      state = 'unavailable';
    }
    if (state === 'valid') {
      cache.delete(key);
      cache.set(key, { identity, at: now() });
      while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
      return { state: 'valid', identity };
    }
    if (state === 'invalid') {
      cache.delete(key);
      return { state: 'invalid' };
    }
    if (hit && now() - hit.at < GRACE_MS) return { state: 'valid', identity: hit.identity };
    return { state: 'unavailable' };
  }

  async function decide({ token, secure }) {
    const locked = !!secure || mode === 'on';
    if (!connector) {
      return locked
        ? { status: 503, who: null, error: 'door not configured' }
        : { status: 200, who: 'anonymous', error: null };
    }
    if (!token) {
      return locked
        ? { status: 401, who: null, error: 'unauthorized' }
        : { status: 200, who: 'anonymous', error: null };
    }
    const v = await verify(token);
    if (v.state === 'valid') {
      const a = allow(v.identity);
      if (a.ok) return { status: 200, who: a.who, error: null };
      if (locked) return { status: 403, who: null, error: 'forbidden' };
      refused++;
      return { status: 200, who: 'anonymous', error: null };
    }
    if (v.state === 'invalid') {
      if (locked) return { status: 401, who: null, error: 'unauthorized' };
      badTokens++;
      return { status: 200, who: 'anonymous', error: null };
    }
    return locked
      ? { status: 503, who: null, error: 'sign-in check unavailable' }
      : { status: 200, who: 'anonymous', error: null };
  }

  function rememberClient(sessionId, label) {
    if (!sessionId) return;
    sessions.delete(sessionId);
    sessions.set(sessionId, label);
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  }

  function forgetClient(sessionId) {
    sessions.delete(sessionId);
  }

  function clientLabel({ body, userAgent, sessionId } = {}) {
    const word = uaWord(userAgent);
    const msg = Array.isArray(body) ? body[0] : body;
    if (msg && msg.method === 'initialize') {
      const name = cleanName(msg.params && msg.params.clientInfo && msg.params.clientInfo.name, 40);
      return name + '|' + word;
    }
    if (sessionId && sessions.has(sessionId)) return sessions.get(sessionId);
    return '?|' + word;
  }

  function record({ who, client, path, tool }) {
    // who and client are already clean values built here; keep ':' and '|' and '?' (e.g. person:admin, name|agent, ?|agent).
    const keep = (v, max) => String(v == null ? '' : v).replace(/[^A-Za-z0-9 ._:|?/-]/g, '').slice(0, max);
    const w = keep(who, 60) || 'anonymous';
    const c = keep(client, 80);
    const p = path === 'secure' ? 'secure' : 'mcp';
    const t = tool ? cleanName(tool, 40) : '';
    const stamp = new Date(now()).toISOString();
    let key = w + '\u0000' + c + '\u0000' + p;
    let row = rows.get(key);
    if (!row) {
      // 59 ordinary rows + 1 overflow row = at most 60.
      if (rows.size < MAX_ROWS - 1) {
        row = { who: w, client: c, path: p, calls: 0, first_at: stamp, last_at: stamp, tools: new Set() };
      } else {
        key = '\u0000other';
        row = rows.get(key) || { who: 'other', client: 'other', path: 'other', calls: 0, first_at: stamp, last_at: stamp, tools: new Set() };
      }
      rows.set(key, row);
    }
    row.calls++;
    row.last_at = stamp;
    if (t && (row.tools.has(t) || row.tools.size < MAX_TOOLS)) row.tools.add(t);
  }

  function snapshot() {
    return {
      mode,
      door_ready: !!connector,
      started_at: startedAt,
      bad_tokens: badTokens,
      refused,
      callers: [...rows.values()].map((r) => ({
        who: r.who,
        client: r.client,
        path: r.path,
        calls: r.calls,
        first_at: r.first_at,
        last_at: r.last_at,
        tools: [...r.tools].sort(),
      })),
    };
  }

  function metadata(suffix) {
    if (!base || !connector) return null;
    return { resource: base + suffix, authorization_servers: [connector], bearer_methods_supported: ['header'] };
  }

  function challenge(suffix) {
    if (!base) return null;
    return 'Bearer resource_metadata="' + base + '/.well-known/oauth-protected-resource' + suffix + '"';
  }

  return { mode, verify, decide, clientLabel, rememberClient, forgetClient, record, snapshot, metadata, challenge };
}
