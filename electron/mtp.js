/**
 * Android phone over USB (MTP) through the bundled libmtp helper (electron/native/mtp-helper).
 * Paths look like `mtp://phone/<storage name>/DCIM/Camera/IMG.jpg`; MTP itself only knows numeric
 * object ids, so folders are resolved name-by-name and cached until the next change.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const PREFIX = 'mtp://phone';
const ROOT_PARENT = 0xffffffff;
const HELPER = process.env.FM_MTP_HELPER || path.join(__dirname, 'native', 'mtp-helper').replace('app.asar', 'app.asar.unpacked');

const helperExists = () => fs.existsSync(HELPER);

/* ------------------------------- detection ------------------------------- */

/** Cheap check (does not open the phone): is an MTP device attached? */
function detect() {
  return new Promise((resolve) => {
    if (!helperExists()) return resolve(null);
    execFile(HELPER, ['detect'], { timeout: 8000 }, (err, out) => {
      if (err || !out) return resolve(null);
      const line = out.split('\n').find((l) => l.startsWith('DEV\t'));
      if (!line) return resolve(null);
      const [, vendor, product] = line.split('\t');
      resolve({ vendor, product });
    });
  });
}

/* --------------------------- persistent helper process --------------------------- */

let proc = null;
let starting = null;
let label = '';
let nextId = 1;
const pending = new Map(); // reqid -> { rows, resolve, reject }

function stopHelper() {
  thumbCache.clear();
  if (proc) proc.kill();
  proc = null;
  starting = null;
  cache.clear();
}

function startHelper() {
  if (proc) return Promise.resolve();
  if (starting) return starting;
  if (!helperExists()) {
    return Promise.reject(
      new Error('The phone helper is not built. Install libmtp (brew install libmtp) and run: npm run build:mtp')
    );
  }
  starting = new Promise((resolve, reject) => {
    const child = spawn(HELPER, ['serve'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    let ready = false;
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!ready) {
          if (line.startsWith('READY\t')) {
            ready = true;
            label = line.split('\t')[1] || 'Android phone';
            proc = child;
            resolve();
          } else if (line.startsWith('FAIL\t')) {
            reject(new Error(line.split('\t')[1]));
          }
          continue;
        }
        const parts = line.split('\t');
        const req = pending.get(parts[0]);
        if (!req) continue;
        if (parts[1] === 'D') req.rows.push(parts.slice(2));
        else if (parts[1] === 'P') req.onProgress && req.onProgress(Number(parts[2]));
        else if (parts[1] === 'OK') {
          pending.delete(parts[0]);
          req.resolve({ rows: req.rows, value: parts[2] || '' });
        } else if (parts[1] === 'ERR') {
          pending.delete(parts[0]);
          req.reject(new Error(parts.slice(2).join('\t') || 'The phone reported an error.'));
        }
      }
    });
    child.on('error', (e) => reject(e));
    child.on('exit', () => {
      if (proc === child) proc = null;
      starting = null;
      cache.clear();
      for (const [id, req] of pending) {
        req.reject(new Error('The phone was disconnected.'));
        pending.delete(id);
      }
      if (!ready) reject(new Error('Could not open the phone.'));
    });
  });
  starting.catch(() => {
    starting = null;
  });
  return starting;
}

async function call(op, ...args) {
  let onProgress = null;
  if (args.length && typeof args[args.length - 1] === 'function') onProgress = args.pop();
  await startHelper();
  const id = String(nextId++);
  return new Promise((resolve, reject) => {
    pending.set(id, { rows: [], resolve, reject, onProgress });
    proc.stdin.write([id, op, ...args].join('\t') + '\n');
  });
}

/* ---------------------------- path <-> object ids ---------------------------- */

const cache = new Map(); // vpath -> { id, storage, isDir }
const segsOf = (vpath) => vpath.slice(PREFIX.length).split('/').filter(Boolean);
const vpathOf = (segs) => PREFIX + '/' + segs.join('/');
const clean = (n) => String(n).replace(/[\t\r\n]/g, ' ');

const STORAGE_HELP =
  'Could not read the phone’s storage. Unlock the phone screen, pull down the notification and choose “File transfer”, then press Refresh.';
let storagesFailed = false;

/**
 * Android only exposes storage once the screen is unlocked, and a session opened while it was locked can
 * stay empty after unlocking. So when reading storage fails, reconnect and try again a few times.
 */
async function storages() {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { rows } = await call('storages');
      storagesFailed = false;
      return rows.map(([id, name, max, free]) => ({
        id: Number(id),
        name: name.replace(/\//g, '-'),
        max: Number(max),
        free: Number(free),
      }));
    } catch (err) {
      lastErr = err;
      if (!/storage|session|PTP|device/i.test(err.message || '')) throw err;
      stopHelper(); // fresh session on the next call
      await new Promise((r) => setTimeout(r, attempt === 0 ? 400 : 1500));
    }
  }
  storagesFailed = true;
  const e = new Error(STORAGE_HELP);
  e.cause = lastErr;
  throw e;
}

/** Called on Refresh: if the last read of the phone's storage failed, start over with a new session. */
function resetIfFailed() {
  if (storagesFailed) stopHelper();
}

async function listChildren(storage, parent) {
  const { rows } = await call('list', storage, parent);
  return rows.map(([id, kind, size, mtime, ...name]) => ({
    id: Number(id),
    isDir: kind === 'd',
    size: Number(size),
    mtime: Number(mtime) * 1000,
    name: name.join('\t'),
  }));
}

/** vpath -> { id, storage, isDir, root } (root: the virtual list of storages). */
async function resolve(vpath) {
  const segs = segsOf(vpath);
  if (!segs.length) return { root: true, isDir: true };
  if (cache.has(vpath)) return cache.get(vpath);
  const store = (await storages()).find((s) => s.name === segs[0]);
  if (!store) throw new Error('This storage is no longer available on the phone.');
  let node = { id: ROOT_PARENT, storage: store.id, isDir: true };
  for (let i = 1; i < segs.length; i++) {
    const kids = await listChildren(node.storage, node.id);
    const hit = kids.find((k) => k.name === segs[i]);
    if (!hit) throw new Error(`“${segs[i]}” was not found on the phone.`);
    node = { id: hit.id, storage: node.storage, isDir: hit.isDir, size: hit.size };
  }
  cache.set(vpath, node);
  return node;
}

const baseName = (vpath) => {
  const s = segsOf(vpath);
  return s[s.length - 1] || 'Phone';
};
const parentOf = (vpath) => vpathOf(segsOf(vpath).slice(0, -1));

const thumbCache = new Map();
/** JPEG thumbnail the phone already has for an image/video (fast: no full download). */
async function thumbnail(vpath) {
  if (thumbCache.has(vpath)) return thumbCache.get(vpath);
  let url = null;
  try {
    const node = await resolve(vpath);
    if (!node.root && !node.isDir) {
      const { rows } = await call('thumb', node.id);
      if (rows[0] && rows[0][0]) url = 'data:image/jpeg;base64,' + rows[0][0];
    }
  } catch {
    /* no thumbnail for this file */
  }
  thumbCache.set(vpath, url);
  if (thumbCache.size > 1500) thumbCache.delete(thumbCache.keys().next().value);
  return url;
}

/** Free/total bytes for the storage a path is on (all storages for the phone root). */
async function space(vpath) {
  const all = await storages();
  const first = segsOf(vpath)[0];
  const list = first ? all.filter((s) => s.name === first) : all;
  if (!list.length) throw new Error('No storage.');
  const total = list.reduce((n, s) => n + s.max, 0);
  const free = list.reduce((n, s) => n + s.free, 0);
  return { total, free, used: Math.max(0, total - free) };
}

function friendly(err) {
  return (err && err.message) || 'Something went wrong talking to the phone.';
}

/* --------------------------------- driver --------------------------------- */

async function list(vpath) {
  try {
    const node = await resolve(vpath);
    let entries;
    if (node.root) {
      entries = (await storages()).map((s) => ({
        name: s.name,
        path: vpathOf([s.name]),
        isDir: true,
        size: 0,
        mtime: 0,
        birthtime: 0,
        extension: '',
        hidden: false,
        isSymlink: false,
      }));
    } else {
      if (!node.isDir) return { ok: false, error: 'This path is not a folder.' };
      const segs = segsOf(vpath);
      entries = (await listChildren(node.storage, node.id)).map((k) => {
        const p = vpathOf([...segs, k.name]);
        cache.set(p, { id: k.id, storage: node.storage, isDir: k.isDir });
        const dot = k.name.lastIndexOf('.');
        return {
          name: k.name,
          path: p,
          isDir: k.isDir,
          size: k.isDir ? 0 : k.size,
          mtime: k.mtime,
          birthtime: k.mtime,
          extension: !k.isDir && dot > 0 ? k.name.slice(dot + 1).toLowerCase() : '',
          hidden: k.name.startsWith('.'),
          isSymlink: false,
        };
      });
    }
    return { ok: true, path: vpath, entries };
  } catch (err) {
    return { ok: false, error: friendly(err) };
  }
}

async function isDir(vpath) {
  return !!(await resolve(vpath)).isDir;
}

async function names(vdir) {
  const r = await list(vdir);
  if (!r.ok) throw new Error(r.error);
  return new Set(r.entries.map((e) => e.name));
}

async function mkdir(vdir, name) {
  const node = await resolve(vdir);
  if (node.root) throw new Error('Open a storage first, then create the folder inside it.');
  await call('mkdir', node.storage, node.id, clean(name));
  cache.clear();
  return vpathOf([...segsOf(vdir), name]);
}

async function rename(vpath, newName) {
  try {
    const node = await resolve(vpath);
    if (node.root) throw new Error('This item can’t be renamed.');
    await call('rename', node.id, clean(newName));
    cache.clear();
    return { ok: true, path: vpathOf([...segsOf(parentOf(vpath)), newName]) };
  } catch (err) {
    return { ok: false, error: friendly(err) };
  }
}

async function removeNode(node, onTick) {
  if (node.isDir) {
    for (const k of await listChildren(node.storage, node.id)) {
      await removeNode({ id: k.id, storage: node.storage, isDir: k.isDir }, onTick);
    }
  }
  await call('del', node.id);
  onTick();
}

async function remove(vpath, onTick = () => {}) {
  const node = await resolve(vpath);
  if (node.root) throw new Error('This item can’t be deleted.');
  await removeNode(node, onTick);
  cache.clear();
}

/** Did this failure come from the phone/cable going away (so a later resume could carry on)? */
const isInterruption = (err) =>
  !!err && (err.interrupted || /disconnected|open the phone|storage|copy the file from the phone|unlock/i.test(err.message || ''));

const sizeOrNull = (p) => fsp.stat(p).then((s) => s.size, () => null);

/**
 * Copy a file or folder from the phone. Files arrive as `<name>.fmpart` and are renamed when complete, so a
 * pulled cable leaves a partial file behind. With `resume`, finished files are skipped and a partial file
 * continues from where it stopped.
 */
async function download(vpath, localDest, onBytes = () => {}, { resume = false } = {}) {
  const node = await resolve(vpath);
  const walk = async (n, dest) => {
    if (n.isDir) {
      await fsp.mkdir(dest, { recursive: true });
      for (const k of await listChildren(n.storage, n.id)) {
        await walk({ id: k.id, storage: n.storage, isDir: k.isDir, size: k.size }, path.join(dest, k.name));
      }
      return;
    }
    const part = dest + '.fmpart';
    let have = 0;
    if (resume) {
      if ((await sizeOrNull(dest)) === n.size) return onBytes(n.size); // finished before the interruption
      const p = await sizeOrNull(part);
      if (p && p < n.size) have = p;
    }
    if (!have) await fsp.rm(part, { force: true });
    let last = have;
    if (have) onBytes(have);
    const progress = (sent) => {
      onBytes(sent - last);
      last = sent;
    };
    try {
      if (have) {
        try {
          await call('getrange', n.id, part, have, n.size, progress);
        } catch (err) {
          if (isInterruption(err) && /disconnected|open the phone/i.test(err.message)) throw err;
          // the phone can't send part of a file: start this one over
          onBytes(-last);
          last = 0;
          await call('get', n.id, part, progress);
        }
      } else await call('get', n.id, part, progress);
    } catch (err) {
      if (err && typeof err === 'object') err.interrupted = true;
      throw err;
    }
    const got = await sizeOrNull(part);
    if (n.size != null && got !== n.size) {
      const e = new Error('The file from the phone is incomplete.');
      e.interrupted = true;
      throw e;
    }
    if (last === 0) onBytes(got ?? 0);
    await fsp.rename(part, dest);
  };
  await walk(node, localDest);
}

async function upload(localSrc, vdir, name, onBytes = () => {}) {
  const dir = await resolve(vdir);
  if (dir.root) throw new Error('Open a storage first (for example Internal shared storage), then paste into a folder.');
  const push = async (src, parent, fileName) => {
    const st = await fsp.stat(src);
    if (st.isDirectory()) {
      const { value } = await call('mkdir', dir.storage, parent, clean(fileName));
      for (const child of await fsp.readdir(src)) await push(path.join(src, child), Number(value), child);
    } else {
      let last = 0;
      await call('send', dir.storage, parent, src, clean(fileName), (sent) => {
        onBytes(sent - last);
        last = sent;
      });
      if (last === 0) onBytes(st.size);
    }
  };
  await push(localSrc, dir.id, name);
  cache.clear();
  return vpathOf([...segsOf(vdir), name]);
}

module.exports = {
  PREFIX,
  detect,
  clearCache: () => cache.clear(),
  resetIfFailed,
  stopHelper,
  getLabel: () => label,
  helperExists,
  space,
  thumbnail,
  driver: { list, isDir, names, mkdir, rename, remove, download, upload, baseName, isInterruption, reset: stopHelper },
};
