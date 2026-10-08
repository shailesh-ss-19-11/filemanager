const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmp, startFtp } = require('./helpers');
const remote = require('../electron/remote');
const transfer = require('../electron/transfer');

const noop = () => {};
const write = (p, c = 'x') => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, c));

test('local copy: file, folder tree, progress events', async () => {
  const src = tmp(), dest = tmp();
  write(path.join(src, 'a.txt'), 'hello');
  write(path.join(src, 'dir/b.bin'), Buffer.alloc(3 * 1024 * 1024, 7));
  const events = [];
  const r = await transfer.run({ id: 't1', items: [path.join(src, 'a.txt'), path.join(src, 'dir')], dest, mode: 'copy' }, (m) => events.push(m));
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'hello');
  assert.equal(fs.statSync(path.join(dest, 'dir/b.bin')).size, 3 * 1024 * 1024);
  assert.ok(fs.existsSync(path.join(src, 'a.txt')), 'copy keeps the source');
  const last = events.filter((e) => e.state === 'running').pop();
  assert.equal(last.total, 5 + 3 * 1024 * 1024);
  assert.equal(events.at(-1).state, 'done');
});

test('local move removes the source', async () => {
  const src = tmp(), dest = tmp();
  write(path.join(src, 'm.txt'), 'move me');
  const r = await transfer.run({ id: 't2', items: [path.join(src, 'm.txt')], dest, mode: 'cut' }, noop);
  assert.equal(r.ok, true);
  assert.ok(!fs.existsSync(path.join(src, 'm.txt')));
  assert.equal(fs.readFileSync(path.join(dest, 'm.txt'), 'utf8'), 'move me');
});

test('conflicts: detected, then keep / replace / skip behave correctly', async () => {
  const src = tmp(), dest = tmp();
  write(path.join(src, 'f.txt'), 'new');
  write(path.join(dest, 'f.txt'), 'old');
  const item = path.join(src, 'f.txt');
  assert.deepEqual(await transfer.conflicts([item], dest), ['f.txt']);

  await transfer.run({ id: 'k', items: [item], dest, mode: 'copy', policy: 'skip' }, noop);
  assert.equal(fs.readFileSync(path.join(dest, 'f.txt'), 'utf8'), 'old');

  await transfer.run({ id: 'k2', items: [item], dest, mode: 'copy', policy: 'keep' }, noop);
  assert.deepEqual(fs.readdirSync(dest).sort(), ['f copy.txt', 'f.txt'].sort());
  assert.equal(fs.readFileSync(path.join(dest, 'f.txt'), 'utf8'), 'old');

  await transfer.run({ id: 'k3', items: [item], dest, mode: 'copy', policy: 'replace' }, noop);
  assert.equal(fs.readFileSync(path.join(dest, 'f.txt'), 'utf8'), 'new');
});

test('pasting a folder into itself is refused; same-folder copy makes "copy"', async () => {
  const d = tmp();
  write(path.join(d, 'sub/x.txt'));
  const r = await transfer.run({ id: 's', items: [path.join(d, 'sub')], dest: path.join(d, 'sub'), mode: 'copy' }, noop);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /into itself/);
  await transfer.run({ id: 's2', items: [path.join(d, 'sub')], dest: d, mode: 'copy' }, noop);
  assert.ok(fs.existsSync(path.join(d, 'sub copy/x.txt')));
});

test('cancel stops a running copy and removes the partial file', async () => {
  const src = tmp(), dest = tmp();
  write(path.join(src, 'big.bin'), Buffer.alloc(200 * 1024 * 1024, 1));
  const p = transfer.run({ id: 'c1', items: [path.join(src, 'big.bin')], dest, mode: 'copy' }, (m) => {
    if (m.state === 'running' && m.done > 0) transfer.cancel('c1');
  });
  const r = await p;
  assert.equal(r.cancelled, true);
  assert.ok(!fs.existsSync(path.join(dest, 'big.bin')), 'partial file removed');
});

test('FTP: upload, download, conflicts, move, delete (against a local FTP server)', async () => {
  const root = tmp();
  write(path.join(root, 'remote.txt'), 'from server');
  write(path.join(root, 'folder/inner.txt'), 'inner');
  const srv = await startFtp(root);
  try {
    remote.init({ userDataDir: tmp(), safeStorage: null });
    const add = await remote.addConnection({ name: 'T', host: '127.0.0.1', port: srv.port, user: 'u', password: 'pw' });
    assert.equal(add.ok, true, add.error);
    const base = add.connection.path;

    const l = await remote.list(base, true);
    assert.deepEqual(l.entries.map((e) => e.name).sort(), ['folder', 'remote.txt']);

    // remote -> local (file + folder)
    const local = tmp();
    let r = await transfer.run({ id: 'f1', items: [base + 'remote.txt', base + 'folder'], dest: local, mode: 'copy' }, noop);
    assert.equal(r.ok, true, r.errors.join());
    assert.equal(fs.readFileSync(path.join(local, 'remote.txt'), 'utf8'), 'from server');
    assert.equal(fs.readFileSync(path.join(local, 'folder/inner.txt'), 'utf8'), 'inner');

    // local -> remote, with a conflict
    write(path.join(local, 'up.txt'), 'uploaded');
    assert.deepEqual(await transfer.conflicts([path.join(local, 'remote.txt')], base), ['remote.txt']);
    r = await transfer.run({ id: 'f2', items: [path.join(local, 'up.txt'), path.join(local, 'remote.txt')], dest: base, mode: 'copy', policy: 'keep' }, noop);
    assert.equal(r.ok, true, r.errors.join());
    assert.equal(fs.readFileSync(path.join(root, 'up.txt'), 'utf8'), 'uploaded');
    assert.ok(fs.existsSync(path.join(root, 'remote copy.txt')));

    // remote -> remote move into a folder, then delete
    r = await transfer.run({ id: 'f3', items: [base + 'up.txt'], dest: base + 'folder', mode: 'cut' }, noop);
    assert.equal(r.ok, true, r.errors.join());
    assert.ok(fs.existsSync(path.join(root, 'folder/up.txt')) && !fs.existsSync(path.join(root, 'up.txt')));
    const del = await remote.remove([base + 'folder']);
    assert.equal(del.ok, true, del.errors.join());
    assert.ok(!fs.existsSync(path.join(root, 'folder')));
  } finally {
    remote.cancelAll(); // close the FTP control connections so the process can exit
    srv.close();
  }
});

test('FTP: compress files on the server to a zip, then extract it there', async () => {
  const root = tmp();
  write(path.join(root, 'docs/a.txt'), 'aaa');
  write(path.join(root, 'b.txt'), 'bbb');
  const srv = await startFtp(root);
  try {
    remote.init({ userDataDir: tmp(), safeStorage: null });
    const add = await remote.addConnection({ name: 'T', host: '127.0.0.1', port: srv.port, user: 'u', password: 'pw' });
    const base = add.connection.path;
    const events = [];
    let r = await transfer.compressRemote({ id: 'z1', paths: [base + 'docs', base + 'b.txt'] }, (m) => events.push(m));
    assert.equal(r.ok, true, r.error);
    assert.equal(path.basename(r.path), 'Archive.zip');
    assert.ok(fs.statSync(path.join(root, 'Archive.zip')).size > 0);
    assert.equal(events.at(-1).state, 'done');
    r = await transfer.extractRemote({ id: 'z2', path: base + 'Archive.zip' }, () => {});
    assert.equal(r.ok, true, r.error);
    assert.equal(fs.readFileSync(path.join(root, 'Archive/docs/a.txt'), 'utf8'), 'aaa');
    assert.equal(fs.readFileSync(path.join(root, 'Archive/b.txt'), 'utf8'), 'bbb');
    // a second compress never overwrites
    r = await transfer.compressRemote({ id: 'z3', paths: [base + 'b.txt'] }, () => {});
    assert.equal(path.basename(r.path), 'b.zip');
  } finally {
    remote.cancelAll();
    srv.close();
  }
});

test('delete: progress by item, cancel stops after the current item, trash callback is used', async () => {
  const d = tmp();
  for (const n of ['a', 'b', 'c', 'd']) write(path.join(d, n + '.txt'));
  const events = [];
  const r = await transfer.deleteItems({ id: 'd1', paths: ['a', 'b'].map((n) => path.join(d, n + '.txt')), permanent: true }, (m) => events.push(m));
  assert.equal(r.ok, true);
  assert.equal(r.deleted, 2);
  assert.ok(!fs.existsSync(path.join(d, 'a.txt')) && !fs.existsSync(path.join(d, 'b.txt')));
  assert.deepEqual([events[0].done, events[0].total, events[0].label, events[0].unit], [0, 2, 'Deleting', 'items']);
  assert.deepEqual([events.at(-1).state, events.at(-1).done, events.at(-1).total], ['done', 2, 2]);

  // non-permanent goes through the supplied trash function
  const trashed = [];
  await transfer.deleteItems({ id: 'd2', paths: [path.join(d, 'c.txt')], permanent: false }, () => {}, async (p) => trashed.push(p));
  assert.deepEqual(trashed, [path.join(d, 'c.txt')]);

  // cancel early: workers stop picking up new items, so most of a long list is left alone
  const many = [];
  for (let i = 0; i < 400; i++) {
    write(path.join(d, `many/x${i}.txt`));
    many.push(path.join(d, `many/x${i}.txt`));
  }
  const cancelled = await transfer.deleteItems({ id: 'd3', paths: many, permanent: true }, (m) => {
    if (m.state === 'running') transfer.cancel('d3');
  });
  assert.equal(cancelled.cancelled, true);
  assert.ok(cancelled.deleted < 400, `stopped early (deleted ${cancelled.deleted})`);
  assert.ok(fs.readdirSync(path.join(d, 'many')).length > 0, 'the rest is left alone');
});

test('performance: copying 3000 small files into the same folder stays quick (no per-item directory re-reads)', async () => {
  const d = tmp();
  const items = [];
  for (let i = 0; i < 3000; i++) {
    write(path.join(d, `f${i}.txt`), 'x');
    items.push(path.join(d, `f${i}.txt`));
  }
  const events = [];
  const t = Date.now();
  const r = await transfer.run({ id: 'perf1', items, dest: d, mode: 'copy' }, (m) => events.push(m));
  const ms = Date.now() - t;
  assert.equal(r.ok, true, r.errors.join());
  assert.equal(fs.readdirSync(d).length, 6000);
  assert.equal(new Set(r.pasted).size, 3000, 'every copy got its own name');
  assert.ok(ms < 4000, `3000 same-folder copies took ${ms} ms`);
  assert.ok(events.length < 200, `progress events are throttled (${events.length})`);
});

test('performance: moving and deleting thousands of items is quick and throttled', async () => {
  const d = tmp(), dest = tmp();
  const items = [];
  for (let i = 0; i < 5000; i++) {
    write(path.join(d, `m${i}.txt`), 'x');
    items.push(path.join(d, `m${i}.txt`));
  }
  let ev = [];
  let t = Date.now();
  let r = await transfer.run({ id: 'perf2', items, dest, mode: 'cut' }, (m) => ev.push(m));
  assert.equal(r.ok, true);
  assert.ok(Date.now() - t < 4000, `move took ${Date.now() - t} ms`);
  assert.ok(ev.length < 200, `move events throttled (${ev.length})`);
  ev = [];
  t = Date.now();
  const moved = fs.readdirSync(dest).map((n) => path.join(dest, n));
  r = await transfer.deleteItems({ id: 'perf3', paths: moved, permanent: true }, (m) => ev.push(m));
  assert.equal(r.deleted, 5000);
  assert.ok(Date.now() - t < 4000, `delete took ${Date.now() - t} ms`);
  assert.ok(ev.length < 200, `delete events throttled (${ev.length})`);
  assert.equal(fs.readdirSync(dest).length, 0);
});
