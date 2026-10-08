const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmp } = require('./helpers');
const ops = require('../electron/fileops');

const write = (p, c = 'x') => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, c));

test('compress a folder + file into Archive.zip, then extract it', async () => {
  const d = tmp();
  write(path.join(d, 'docs/a.txt'), 'aaa');
  write(path.join(d, 'b.txt'), 'bbb');
  const zip = await ops.compress([path.join(d, 'docs'), path.join(d, 'b.txt')]);
  assert.equal(path.basename(zip), 'Archive.zip');
  assert.ok(fs.statSync(zip).size > 0);
  const out = await ops.extract(zip);
  assert.equal(path.basename(out), 'Archive');
  assert.equal(fs.readFileSync(path.join(out, 'docs/a.txt'), 'utf8'), 'aaa');
  assert.equal(fs.readFileSync(path.join(out, 'b.txt'), 'utf8'), 'bbb');
  // second compress never overwrites
  const zip2 = await ops.compress([path.join(d, 'b.txt')]);
  assert.equal(path.basename(zip2), 'b.zip');
  const again = await ops.compress([path.join(d, 'b.txt')]);
  assert.equal(path.basename(again), 'b 2.zip');
});

test('hide / unhide sets and clears the OS hidden attribute', async () => {
  const d = tmp();
  write(path.join(d, 'secret.txt'));
  write(path.join(d, 'plain.txt'));
  assert.equal((await ops.hiddenNames(d)).has('secret.txt'), false);
  await ops.setHidden([path.join(d, 'secret.txt')], true);
  const hidden = await ops.hiddenNames(d);
  if (process.platform !== 'linux') {
    assert.equal(hidden.has('secret.txt'), true);
    assert.equal(hidden.has('plain.txt'), false);
    await ops.setHidden([path.join(d, 'secret.txt')], false);
    assert.equal((await ops.hiddenNames(d)).has('secret.txt'), false);
  }
});

test('read-only toggles and properties reflect it', async () => {
  const d = tmp();
  const f = path.join(d, 'ro.txt');
  write(f, 'hello');
  await ops.setReadOnly([f], true);
  let p = await ops.properties(f);
  assert.equal(p.readOnly, true);
  assert.equal(p.size, 5);
  assert.equal(p.isDir, false);
  await ops.setReadOnly([f], false);
  p = await ops.properties(f);
  assert.equal(p.readOnly, false);
  assert.match(p.modeText, /^[r-][w-][x-]/);
});

test('new file picks a free name', async () => {
  const d = tmp();
  const a = await ops.newFile(d);
  const b = await ops.newFile(d);
  assert.notEqual(a, b);
  assert.ok(fs.existsSync(a) && fs.existsSync(b));
});

test('extract refuses nothing silently: bad archive cleans up its folder', async () => {
  const d = tmp();
  write(path.join(d, 'broken.zip'), 'not a zip');
  await assert.rejects(ops.extract(path.join(d, 'broken.zip')));
  assert.deepEqual(fs.readdirSync(d), ['broken.zip']);
});
