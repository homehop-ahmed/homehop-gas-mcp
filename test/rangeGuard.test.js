import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitTabRange, checkRange, requireTabRange, RANGE_GUARD_MESSAGE } from '../src/rangeGuard.js';

const TABS = ['Bank_Transactions', '_Tasks_Private', '_Ops_Log', "Owner's Ledger", 'Tab With Spaces'];

test('splitTabRange', () => {
  assert.deepEqual(splitTabRange('_Tasks_Private!I2424'), { tab: '_Tasks_Private', a1: 'I2424' });
  assert.deepEqual(splitTabRange("'Owner''s Ledger'!A1:B2"), { tab: "Owner's Ledger", a1: 'A1:B2' });
  assert.deepEqual(splitTabRange('I2424'), { tab: '', a1: 'I2424' });
});

test('the 2026-10-21 incident range is refused', () => {
  assert.throws(() => checkRange('I2424', TABS), e => e.message.startsWith(RANGE_GUARD_MESSAGE));
});

test('bare cell and column references are refused', () => {
  for (const r of ['A1', 'A:E', 'I2424:O2424', '', '   ', '!A1']) {
    assert.throws(() => checkRange(r, TABS), e => e.message.startsWith(RANGE_GUARD_MESSAGE), r);
  }
});

test('a tab that does not exist is refused', () => {
  assert.throws(() => checkRange('_Tasks_Privat!I2424', TABS), e => e.message.startsWith(RANGE_GUARD_MESSAGE));
  assert.throws(() => checkRange('Nope', TABS), e => e.message.startsWith(RANGE_GUARD_MESSAGE));
});

test('tab-prefixed ranges on real tabs pass', () => {
  assert.equal(checkRange('_Tasks_Private!I2424', TABS), '_Tasks_Private');
  assert.equal(checkRange('_Tasks_Private!I2424:O2424', TABS), '_Tasks_Private');
  assert.equal(checkRange("'Owner''s Ledger'!A1", TABS), "Owner's Ledger");
  assert.equal(checkRange("'Tab With Spaces'!B2:C9", TABS), 'Tab With Spaces');
});

test('a whole existing tab (append tabName / clear whole tab) passes', () => {
  assert.equal(checkRange('_Ops_Log', TABS), '_Ops_Log');
  assert.equal(checkRange("'Tab With Spaces'", TABS), 'Tab With Spaces');
  assert.equal(checkRange('_Ops_Log!A:E', TABS), '_Ops_Log');
});

test('requireTabRange reads the tab list and checks before any write', async () => {
  const calls = [];
  const fake = { spreadsheets: { get: async (args) => { calls.push(args); return { data: { sheets: TABS.map(t => ({ properties: { title: t } })) } }; } } };
  assert.equal(await requireTabRange(fake, 'SSID', '_Tasks_Private!I2424'), '_Tasks_Private');
  await assert.rejects(() => requireTabRange(fake, 'SSID', 'I2424'), e => e.message.startsWith(RANGE_GUARD_MESSAGE));
  assert.equal(calls[0].spreadsheetId, 'SSID');
});
