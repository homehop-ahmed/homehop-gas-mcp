/**
 * rangeGuard.js — refuse a Sheets write whose range does not name its tab.
 *
 * WHY (2026-10-21 incident): a write sent with the range "I2424" (no tab name)
 * was accepted by the Sheets API, which resolves a bare cell reference against
 * the FIRST tab of the spreadsheet. It overwrote Bank_Transactions!I2424 instead
 * of _Tasks_Private!I2424. Every write tool now checks the tab first.
 *
 * Rule, for sheets_update_range / sheets_append_rows / sheets_clear_range:
 *   - "Tab!A1:B2" or "'Tab name'!A1"  -> allowed only if that tab exists;
 *   - "Tab" (a whole tab, no '!')     -> allowed only if it is exactly an existing tab;
 *   - anything else (e.g. "I2424", "A:E") -> refused with
 *     "range must start with the tab name".
 */

export const RANGE_GUARD_MESSAGE = 'range must start with the tab name';

/** Split an A1 range into { tab, a1 }. tab is '' when the range has no '!'. */
export function splitTabRange(range) {
  const s = String(range == null ? '' : range).trim();
  const quoted = s.match(/^'((?:[^']|'')+)'!(.*)$/);
  if (quoted) return { tab: quoted[1].replace(/''/g, "'"), a1: quoted[2] };
  const i = s.indexOf('!');
  if (i > 0) return { tab: s.slice(0, i), a1: s.slice(i + 1) };
  return { tab: '', a1: s };
}

/** A bare whole-tab name, with optional surrounding quotes removed. */
function bareTabName(range) {
  const s = String(range == null ? '' : range).trim();
  const q = s.match(/^'((?:[^']|'')+)'$/);
  return q ? q[1].replace(/''/g, "'") : s;
}

/**
 * Pure check against a list of tab titles. Returns the tab name the write will
 * land on, or throws an Error whose message starts with RANGE_GUARD_MESSAGE.
 */
export function checkRange(range, titles) {
  const list = Array.isArray(titles) ? titles : [];
  const { tab } = splitTabRange(range);
  if (tab) {
    if (!list.includes(tab)) {
      throw new Error(`${RANGE_GUARD_MESSAGE}: "${tab}" is not a tab in this spreadsheet (range "${range}") - write refused`);
    }
    return tab;
  }
  const whole = bareTabName(range);
  if (whole && list.includes(whole)) return whole;
  throw new Error(`${RANGE_GUARD_MESSAGE} and "!" (e.g. "_Tasks_Private!I2424"); got "${range}" - write refused`);
}

/**
 * Async wrapper used by the write tools: reads the spreadsheet's tab titles
 * with the given Sheets client, then runs checkRange. Throws before any write.
 */
export async function requireTabRange(sheetsClient, spreadsheetId, range) {
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  const titles = ((meta && meta.data && meta.data.sheets) || []).map(s => s.properties.title);
  return checkRange(range, titles);
}
