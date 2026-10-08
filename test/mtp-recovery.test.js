/** A phone that is locked at first and unlocked later: the app must reconnect instead of staying broken. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tmp } = require('./helpers');

process.env.FM_MTP_HELPER = path.join(__dirname, 'fixtures', 'fake-mtp-helper.js');
const state = path.join(tmp(), 'state');
process.env.FAKE_STATE = state;
const mtp = require('../electron/mtp');
const remote = require('../electron/remote');

test('storage unreadable twice (locked phone), then readable: the app reconnects and recovers by itself', async (t) => {
  process.env.FAIL_TIMES = '2';
  t.after(() => mtp.stopHelper());
  const r = await remote.list('mtp://phone/', true);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.entries.map((e) => e.name), ['Internal shared storage']);
});

test('storage stays unreadable: a clear instruction, and Refresh starts over with a new connection', async (t) => {
  t.after(() => mtp.stopHelper());
  require('node:fs').writeFileSync(state, '0');
  process.env.FAIL_TIMES = '99';
  const bad = await remote.list('mtp://phone/', true);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Unlock the phone screen[\s\S]*File transfer[\s\S]*Refresh/);
  // the user unlocks the phone and presses Refresh
  process.env.FAIL_TIMES = '0';
  mtp.stopHelper(); // (new helper processes read FAIL_TIMES from the environment at start)
  const good = await remote.list('mtp://phone/', true);
  assert.equal(good.ok, true, good.error);
});
