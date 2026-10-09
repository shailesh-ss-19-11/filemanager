/** Phone copy interrupted by a pulled cable: partial data is kept and Resume finishes the job. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmp } = require('./helpers');

const phone = tmp();
const out = tmp();
process.env.FM_MTP_HELPER = path.join(__dirname, 'fixtures', 'fake-phone-helper.js');
process.env.FAKE_PHONE_ROOT = phone;
process.env.DROP_FLAG = path.join(tmp(), 'dropped');
process.env.DROP_AFTER = '5000';
const mtp = require('../electron/mtp');
const transfer = require('../electron/transfer');

const big = Buffer.alloc(20000, 'abcdefghij');
const ST = 'mtp://phone/Internal shared storage/';

test('pulled cable keeps the partial file; resume finishes it byte-for-byte and skips completed files', async (t) => {
  t.after(() => mtp.stopHelper());
  fs.mkdirSync(path.join(phone, 'DCIM'));
  fs.writeFileSync(path.join(phone, 'DCIM', 'a.jpg'), 'small file');
  fs.writeFileSync(path.join(phone, 'DCIM', 'z-big.mov'), big);
  const msgs = [];

  const first = await transfer.run({ id: 't1', items: [ST + 'DCIM'], dest: out, mode: 'copy' }, (m) => msgs.push(m));
  assert.equal(first.interrupted, true, JSON.stringify(first));
  assert.ok(first.resume.items.length === 1);
  assert.ok(msgs.some((m) => m.state === 'interrupted'));
  const part = path.join(out, 'DCIM', 'z-big.mov.fmpart');
  assert.equal(fs.statSync(part).size, 5000, 'partial file kept');
  assert.equal(fs.readFileSync(path.join(out, 'DCIM', 'a.jpg'), 'utf8'), 'small file');

  const second = await transfer.run({ id: 't1', ...first.resume, resume: true }, () => {});
  assert.equal(second.ok, true, second.errors.join('; '));
  assert.deepEqual(fs.readFileSync(path.join(out, 'DCIM', 'z-big.mov')), big);
  assert.equal(fs.existsSync(part), false);
});

test('discard removes the half-copied files', async () => {
  const dir = path.join(out, 'half');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'x.fmpart'), 'abc');
  await transfer.discard({ x: dir });
  assert.equal(fs.existsSync(dir), false);
});
