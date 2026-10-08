/** Real-phone tests: skipped automatically when no Android phone (File transfer mode) is attached. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmp, waitPhoneFree } = require('./helpers');
const mtp = require('../electron/mtp');
const remote = require('../electron/remote');
const transfer = require('../electron/transfer');

const ST = 'mtp://phone/Internal shared storage/';

test('phone over USB (MTP)', { timeout: 180000 }, async (t) => {
  const dev = await mtp.detect();
  if (!dev) return t.skip('no Android phone attached');
  await waitPhoneFree();
  t.after(() => mtp.stopHelper());

  await t.test('lists storages and reports free/used space', async () => {
    const root = await remote.list('mtp://phone/', true);
    assert.equal(root.ok, true, root.error);
    assert.ok(root.entries.some((e) => e.name === 'Internal shared storage'));
    const sp = await mtp.space('mtp://phone/');
    assert.ok(sp.total > sp.free && sp.free > 0 && sp.used === sp.total - sp.free);
  });

  await t.test('lists a folder with sizes and dates', async () => {
    const l = await remote.list(ST + 'Download', true);
    assert.equal(l.ok, true, l.error);
    assert.ok(Array.isArray(l.entries));
  });

  await t.test('upload -> download round trip with progress, conflicts, rename, delete', async () => {
    const work = tmp();
    const payload = Buffer.alloc(3 * 1024 * 1024, 42);
    fs.writeFileSync(path.join(work, 'fm-roundtrip.bin'), payload);
    const folder = await remote.newFolder(ST + 'Download');
    assert.equal(folder.ok, true, folder.error);
    try {
      const events = [];
      let r = await transfer.run({ id: 'm1', items: [path.join(work, 'fm-roundtrip.bin')], dest: folder.path, mode: 'copy' }, (m) => events.push(m));
      assert.equal(r.ok, true, r.errors.join());
      assert.ok(events.some((e) => e.state === 'running' && e.done > 0), 'progress reported');

      const l = await remote.list(folder.path, true);
      assert.deepEqual(l.entries.map((e) => [e.name, e.size]), [['fm-roundtrip.bin', payload.length]]);

      const back = tmp();
      r = await transfer.run({ id: 'm2', items: [folder.path + '/fm-roundtrip.bin'], dest: back, mode: 'copy' }, () => {});
      assert.equal(r.ok, true, r.errors.join());
      assert.ok(fs.readFileSync(path.join(back, 'fm-roundtrip.bin')).equals(payload), 'bytes identical');

      // conflict then keep both
      assert.deepEqual(await transfer.conflicts([path.join(work, 'fm-roundtrip.bin')], folder.path), ['fm-roundtrip.bin']);

      const ren = await remote.rename(folder.path + '/fm-roundtrip.bin', 'fm-renamed.bin');
      assert.equal(ren.ok, true, ren.error);
    } finally {
      const del = await remote.remove([folder.path]);
      assert.equal(del.ok, true, del.errors.join());
    }
    const after = await remote.list(ST + 'Download', true);
    assert.ok(!after.entries.some((e) => e.name === folder.name), 'test folder removed');
  });

  await t.test('cancelling a large upload stops it, and the phone connection recovers', async () => {
    const work = tmp();
    fs.writeFileSync(path.join(work, 'fm-cancel.bin'), Buffer.alloc(120 * 1024 * 1024, 1));
    const folder = await remote.newFolder(ST + 'Download');
    try {
      const r = await transfer.run({ id: 'mc', items: [path.join(work, 'fm-cancel.bin')], dest: folder.path, mode: 'copy' }, (m) => {
        if (m.state === 'running' && m.done > 1024 * 1024) transfer.cancel('mc');
      });
      assert.equal(r.cancelled, true);
      // the helper was restarted: listing works again
      const l = await remote.list(folder.path, true);
      assert.equal(l.ok, true, l.error);
    } finally {
      await remote.remove([folder.path]).catch(() => {});
    }
  });

  await t.test('compress and extract files that live on the phone', async () => {
    const work = tmp();
    fs.writeFileSync(path.join(work, 'one.txt'), 'first file');
    fs.writeFileSync(path.join(work, 'two.txt'), 'second file');
    const folder = await remote.newFolder(ST + 'Download');
    try {
      await transfer.run({ id: 'zc0', items: [path.join(work, 'one.txt'), path.join(work, 'two.txt')], dest: folder.path, mode: 'copy' }, () => {});
      const events = [];
      let r = await transfer.compressRemote({ id: 'zc1', paths: [folder.path + '/one.txt', folder.path + '/two.txt'] }, (m) => events.push(m));
      assert.equal(r.ok, true, r.error);
      assert.equal(path.basename(r.path), 'Archive.zip');
      assert.ok(events.some((e) => e.state === 'running' && e.done > 0), 'progress reported');
      let l = await remote.list(folder.path, true);
      assert.ok(l.entries.some((e) => e.name === 'Archive.zip' && e.size > 0), 'zip is on the phone');

      r = await transfer.extractRemote({ id: 'zc2', path: folder.path + '/Archive.zip' }, () => {});
      assert.equal(r.ok, true, r.error);
      l = await remote.list(folder.path + '/Archive', true);
      assert.deepEqual(l.entries.map((e) => e.name).sort(), ['one.txt', 'two.txt']);
      const back = tmp();
      await transfer.run({ id: 'zc3', items: [folder.path + '/Archive/two.txt'], dest: back, mode: 'copy' }, () => {});
      assert.equal(fs.readFileSync(path.join(back, 'two.txt'), 'utf8'), 'second file');
    } finally {
      await remote.remove([folder.path]).catch(() => {});
    }
  });

  await t.test('deleting a folder on the phone reports progress per file', async () => {
    const work = tmp();
    const names = [];
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(work, `f${i}.txt`), `file ${i}`);
      names.push(path.join(work, `f${i}.txt`));
    }
    const folder = await remote.newFolder(ST + 'Download');
    await transfer.run({ id: 'dp0', items: names, dest: folder.path, mode: 'copy' }, () => {});
    const events = [];
    const r = await transfer.deleteItems({ id: 'dp1', paths: [folder.path] }, (m) => events.push(m));
    assert.equal(r.ok, true, r.errors.join());
    assert.equal(Math.max(...events.filter((e) => e.state === 'running').map((e) => e.sub)), 7); // 6 files + the folder
    assert.equal(events.at(-1).state, 'done');
    const l = await remote.list(ST + 'Download', true);
    assert.ok(!l.entries.some((e) => e.name === folder.name));
  });

  await t.test('thumbnail for a camera photo is a JPEG data URL (if any photo exists)', async () => {
    const cam = await remote.list(ST + 'DCIM/Camera', true);
    const pic = cam.ok && cam.entries.find((e) => /\.jpe?g$/i.test(e.name));
    if (!pic) return t.skip('no photo in DCIM/Camera');
    const url = await mtp.thumbnail(pic.path);
    assert.match(url || '', /^data:image\/jpeg;base64,/);
  });
});
