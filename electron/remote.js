/**
 * Remote locations (currently FTP). A remote path looks like `ftp://<connectionId>/dir/file`,
 * so the rest of the app can treat it like any other path string.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ftp = require('basic-ftp');
const mtp = require('./mtp');

const PREFIX = 'ftp://';
const isFtp = (p) => typeof p === 'string' && p.startsWith(PREFIX);
const isMtp = (p) => typeof p === 'string' && p.startsWith('mtp://');
const isRemote = (p) => isFtp(p) || isMtp(p);

/** `ftp://abc/a/b` -> { id: 'abc', remote: '/a/b' } */
function parse(vpath) {
  const rest = vpath.slice(PREFIX.length);
  const i = rest.indexOf('/');
  const id = i < 0 ? rest : rest.slice(0, i);
  let remote = i < 0 ? '/' : rest.slice(i);
  if (remote.length > 1 && remote.endsWith('/')) remote = remote.slice(0, -1);
  return { id, remote };
}
const vpathOf = (id, remote) => `${PREFIX}${id}${remote.startsWith('/') ? remote : '/' + remote}`;
const joinRemote = (dir, name) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`);
const baseRemote = (p) => p.slice(p.lastIndexOf('/') + 1);

/* ---------------------------- connection profiles ---------------------------- */

let profiles = []; // { id, name, host, port, user, secure, password? (in memory) }
let storeFile = null;
let safe = null;

function init({ userDataDir, safeStorage }) {
  storeFile = path.join(userDataDir, 'ftp-connections.json');
  safe = safeStorage;
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    profiles = raw.map((p) => {
      let password = '';
      if (p.enc && safe && safe.isEncryptionAvailable()) {
        try {
          password = safe.decryptString(Buffer.from(p.enc, 'base64'));
        } catch {
          /* unreadable; ask again */
        }
      }
      return { id: p.id, name: p.name, host: p.host, port: p.port, user: p.user, secure: !!p.secure, password };
    });
  } catch {
    profiles = [];
  }
}

function persist() {
  if (!storeFile) return;
  const out = profiles.map((p) => ({
    id: p.id,
    name: p.name,
    host: p.host,
    port: p.port,
    user: p.user,
    secure: p.secure,
    enc:
      p.password && safe && safe.isEncryptionAvailable()
        ? safe.encryptString(p.password).toString('base64')
        : undefined,
  }));
  try {
    fs.writeFileSync(storeFile, JSON.stringify(out, null, 2));
  } catch {
    /* non-fatal */
  }
}

const publicProfile = (p) => ({
  id: p.id,
  name: p.name,
  host: p.host,
  port: p.port,
  user: p.user,
  secure: p.secure,
  path: vpathOf(p.id, '/'),
});

const listConnections = () => profiles.map(publicProfile);

/* ------------------------------ client handling ------------------------------ */

const sessions = new Map(); // id -> { client, queue }

function sessionFor(id) {
  let s = sessions.get(id);
  if (!s) {
    s = { client: null, queue: Promise.resolve() };
    sessions.set(id, s);
  }
  return s;
}

async function connect(profile) {
  const client = new ftp.Client(20000);
  client.ftp.verbose = false;
  await client.access({
    host: profile.host,
    port: profile.port,
    user: profile.user || 'anonymous',
    password: profile.password || 'anonymous@',
    secure: profile.secure ? true : false,
    secureOptions: profile.secure ? { rejectUnauthorized: false } : undefined,
  });
  return client;
}

/** Runs `fn(client)` serially per connection (an FTP control channel handles one command at a time). */
function withClient(id, fn) {
  const profile = profiles.find((p) => p.id === id);
  if (!profile) return Promise.reject(Object.assign(new Error('This connection no longer exists.'), { code: 'EREMOTE' }));
  const s = sessionFor(id);
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        if (!s.client || s.client.closed) s.client = await connect(profile);
        return await fn(s.client);
      } catch (err) {
        const dropped = err && (err.code === 'ECONNRESET' || err.code === 'EPIPE' || /closed|timeout/i.test(err.message || ''));
        if (s.client) s.client.close();
        s.client = null;
        if (!(dropped && attempt === 0)) throw err;
      }
    }
  };
  const result = s.queue.then(run, run);
  s.queue = result.catch(() => {});
  return result;
}

function friendly(err) {
  const code = err && err.code;
  const msg = (err && err.message) || '';
  if (code === 'EREMOTE') return msg;
  if (code === 'ECONNREFUSED') return 'Connection refused. Is the FTP server running on the phone, and is the port correct?';
  if (code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ETIMEDOUT' || /timeout/i.test(msg))
    return 'Could not reach the device. Check that the phone and this computer are on the same Wi-Fi.';
  if (code === 530 || /530/.test(msg)) return 'Login failed. Check the username and password.';
  if (code === 550 || /550/.test(msg)) return 'The device refused this action (not found or no permission).';
  return msg || 'Something went wrong with the FTP connection.';
}

async function addConnection({ name, host, port, user, password, secure }) {
  if (!host || !String(host).trim()) return { ok: false, error: 'Enter the phone’s IP address.' };
  const profile = {
    id: crypto.randomBytes(6).toString('hex'),
    name: (name && String(name).trim()) || String(host).trim(),
    host: String(host).trim(),
    port: Number(port) || 21,
    user: user ? String(user) : '',
    secure: !!secure,
    password: password ? String(password) : '',
  };
  let client;
  try {
    client = await connect(profile); // verify before saving
    await client.pwd();
  } catch (err) {
    return { ok: false, error: friendly(err) };
  } finally {
    if (client) client.close();
  }
  profiles.push(profile);
  persist();
  return { ok: true, connection: publicProfile(profile) };
}

function removeConnection(id) {
  const s = sessions.get(id);
  if (s && s.client) s.client.close();
  sessions.delete(id);
  profiles = profiles.filter((p) => p.id !== id);
  persist();
}

/* ------------------------------- FTP driver ------------------------------- */

const ftpErr = (err) => new Error(friendly(err));

/** Reports bytes moved by the current FTP transfer(s) as deltas. */
function trackBytes(client, onBytes) {
  let last = 0;
  client.trackProgress((info) => {
    onBytes(info.bytesOverall - last);
    last = info.bytesOverall;
  });
}

async function ftpList(vpath) {
  const { id, remote } = parse(vpath);
  try {
    const items = await withClient(id, (c) => c.list(remote));
    const entries = items
      .filter((f) => f.name !== '.' && f.name !== '..')
      .map((f) => {
        const isDir = f.isDirectory || (f.isSymbolicLink && !f.size);
        const ext = !isDir && f.name.lastIndexOf('.') > 0 ? f.name.slice(f.name.lastIndexOf('.') + 1).toLowerCase() : '';
        const t = f.modifiedAt ? f.modifiedAt.getTime() : 0;
        return {
          name: f.name,
          path: vpathOf(id, joinRemote(remote, f.name)),
          isDir,
          size: isDir ? 0 : f.size || 0,
          mtime: t,
          birthtime: t,
          extension: ext,
          hidden: f.name.startsWith('.'),
          isSymlink: f.isSymbolicLink,
        };
      });
    return { ok: true, path: vpath, entries };
  } catch (err) {
    return { ok: false, error: friendly(err) };
  }
}

async function ftpIsDir(vpath) {
  const { id, remote } = parse(vpath);
  if (remote === '/') return true;
  const parent = remote.slice(0, remote.lastIndexOf('/')) || '/';
  const me = (await withClient(id, (c) => c.list(parent))).find((f) => f.name === baseRemote(remote));
  return !!(me && me.isDirectory);
}

const ftpDriver = {
  list: ftpList,
  isDir: ftpIsDir,
  baseName: (vpath) => baseRemote(parse(vpath).remote),
  async names(vdir) {
    const { id, remote } = parse(vdir);
    return new Set((await withClient(id, (c) => c.list(remote))).map((f) => f.name));
  },
  async mkdir(vdir, name) {
    const { id, remote } = parse(vdir);
    const target = joinRemote(remote, name);
    await withClient(id, (c) => c.send(`MKD ${target}`));
    return vpathOf(id, target);
  },
  async rename(vpath, newName) {
    const { id, remote } = parse(vpath);
    if (!newName || /[\\/]/.test(newName)) return { ok: false, error: 'A name cannot contain / or \\.' };
    const to = joinRemote(remote.slice(0, remote.lastIndexOf('/')) || '/', newName);
    try {
      await withClient(id, (c) => c.rename(remote, to));
      return { ok: true, path: vpathOf(id, to) };
    } catch (err) {
      return { ok: false, error: friendly(err) };
    }
  },
  async remove(vpath, onTick = () => {}) {
    const { id, remote } = parse(vpath);
    try {
      const dir = await ftpIsDir(vpath); // must not run inside withClient (it queues on the same connection)
      await withClient(id, (c) => (dir ? c.removeDir(remote) : c.remove(remote)));
      onTick();
    } catch (err) {
      throw ftpErr(err);
    }
  },
  async download(vpath, localDest, onBytes = () => {}) {
    const { id, remote } = parse(vpath);
    try {
      const dir = await ftpIsDir(vpath);
      await withClient(id, async (c) => {
        trackBytes(c, onBytes);
        try {
          if (dir) {
            await fsp.mkdir(localDest, { recursive: true });
            await c.downloadToDir(localDest, remote);
          } else {
            await c.downloadTo(localDest, remote);
          }
        } finally {
          c.trackProgress();
        }
      });
    } catch (err) {
      throw ftpErr(err);
    }
  },
  async upload(localSrc, vdir, name, onBytes = () => {}) {
    const { id, remote: dir } = parse(vdir);
    const remote = joinRemote(dir, name);
    try {
      const st = await fsp.stat(localSrc);
      await withClient(id, async (c) => {
        trackBytes(c, onBytes);
        try {
          if (st.isDirectory()) {
            await c.ensureDir(remote);
            await c.cd('/');
            await c.uploadFromDir(localSrc, remote);
          } else {
            await c.uploadFrom(localSrc, remote);
          }
        } finally {
          c.trackProgress();
        }
      });
    } catch (err) {
      throw ftpErr(err);
    }
    return vpathOf(id, remote);
  },
};

const driverFor = (vpath) => (isMtp(vpath) ? mtp.driver : ftpDriver);

/* ----------------------------- generic operations ----------------------------- */

// Phone folders are slow to list (about 13 ms per file over MTP), so keep recent listings and
// downloaded files around. Any change made through the app clears the listing cache.
const LIST_TTL = 5 * 60 * 1000;
const listCache = new Map(); // vpath -> { at, result }
const openCache = new Map(); // vpath -> { file, key }

async function list(vpath, fresh = false) {
  const hit = listCache.get(vpath);
  if (!fresh && hit && Date.now() - hit.at < LIST_TTL) return hit.result;
  if (fresh && isMtp(vpath)) {
    mtp.resetIfFailed(); // storage failed earlier (phone was locked)? reconnect now
    mtp.clearCache(); // folders may have been replaced on the phone itself
  }
  const result = await driverFor(vpath).list(vpath);
  if (result.ok) listCache.set(vpath, { at: Date.now(), result });
  else listCache.delete(vpath);
  return result;
}
const invalidate = () => listCache.clear();

/** Aborts any FTP transfer in flight (and the phone helper) — used by Cancel. */
function cancelAll() {
  for (const s of sessions.values()) if (s.client) s.client.close();
  mtp.stopHelper();
}
const msg = (err) => (err && err.message) || 'Something went wrong.';

async function newFolder(vdir) {
  const d = driverFor(vdir);
  try {
    const existing = await d.names(vdir);
    let name = 'New folder';
    for (let n = 2; existing.has(name); n++) name = `New folder (${n})`;
    invalidate();
    return { ok: true, path: await d.mkdir(vdir, name), name };
  } catch (err) {
    return { ok: false, error: msg(err) };
  }
}

const rename = async (vpath, newName) => {
  invalidate();
  openCache.delete(vpath);
  return driverFor(vpath).rename(vpath, newName);
};

/** Remote delete is permanent (no trash on a phone connection). */
async function remove(vpaths) {
  const errors = [];
  invalidate();
  for (const vp of vpaths) {
    openCache.delete(vp);
    try {
      await driverFor(vp).remove(vp);
    } catch (err) {
      errors.push(`${driverFor(vp).baseName(vp)}: ${msg(err)}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

const tempDir = () => fsp.mkdtemp(path.join(os.tmpdir(), 'filemanager-remote-'));

/** Download to a temp folder so the OS can open it with the default app. */
async function fetchForOpen(vpath, info = {}) {
  // Re-opening an unchanged file reuses the earlier download.
  const key = `${info.size ?? ''}|${info.mtime ?? ''}`;
  const cached = openCache.get(vpath);
  if (cached && cached.key === key && fs.existsSync(cached.file)) return cached.file;
  const tmp = await tempDir();
  const dest = path.join(tmp, driverFor(vpath).baseName(vpath));
  await driverFor(vpath).download(vpath, dest);
  openCache.set(vpath, { file: dest, key });
  return dest;
}

// The phone is slow the first time a big folder is opened (about 20 s for DCIM/Camera with 1,000+
// files) but fast afterwards, so read the usual suspects in the background as soon as it is plugged in.
let warming = false;
let warmed = false;
async function warmPhone() {
  if (warming || warmed) return;
  warming = true;
  try {
    const root = await list('mtp://phone/');
    if (!root.ok) return;
    for (const st of root.entries) {
      for (const sub of ['DCIM/Camera', 'Download', 'DCIM', 'Pictures', 'Movies', 'Documents']) {
        await list(`${st.path}/${sub}`);
      }
    }
    warmed = true;
  } catch {
    /* best effort */
  } finally {
    warming = false;
  }
}
const resetWarm = () => {
  warmed = false;
  listCache.clear();
};

function clearTemp() {
  for (const { file } of openCache.values()) fsp.rm(path.dirname(file), { recursive: true, force: true }).catch(() => {});
  openCache.clear();
}

async function folderSize(vpath) {
  const d = driverFor(vpath);
  const MAX = 20000;
  let size = 0;
  let count = 0;
  let truncated = false;
  const stack = [vpath];
  try {
    while (stack.length && !truncated) {
      const r = await d.list(stack.pop());
      if (!r.ok) throw new Error(r.error);
      for (const e of r.entries) {
        if (e.isDir) stack.push(e.path);
        else size += e.size || 0;
        if (++count > MAX) {
          truncated = true;
          break;
        }
      }
    }
    return { ok: true, size, count, truncated };
  } catch (err) {
    return { ok: false, error: msg(err) };
  }
}

module.exports = {
  isRemote,
  init,
  listConnections,
  addConnection,
  removeConnection,
  list,
  newFolder,
  rename,
  remove,
  driverFor,
  invalidate,
  tempDir,
  cancelAll,
  fetchForOpen,
  clearTemp,
  warmPhone,
  resetWarm,
  folderSize,
};
