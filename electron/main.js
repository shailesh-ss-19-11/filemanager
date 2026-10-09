const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  shell,
  clipboard,
  nativeImage,
  safeStorage,
  dialog,
  protocol,
  net,
} = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const remote = require('./remote');
const mtp = require('./mtp');
const transfer = require('./transfer');
const fileops = require('./fileops');
const preview = require('./preview');
const editors = require('./editors');

protocol.registerSchemesAsPrivileged([
  { scheme: 'fmfile', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

const isMac = process.platform === 'darwin';
const ICON = path.join(__dirname, 'icon.png');
app.setName('File Manager');
const isWin = process.platform === 'win32';
const DEV_URL = process.env.VITE_DEV_SERVER_URL;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function friendlyError(err, what = 'folder') {
  switch (err && err.code) {
    case 'EACCES':
    case 'EPERM':
      return `You don't have permission to access this ${what}.`;
    case 'ENOENT':
      return `This ${what} no longer exists.`;
    case 'ENOTDIR':
      return `This path is not a folder.`;
    case 'EEXIST':
      return `An item with that name already exists.`;
    case 'EBUSY':
      return `This ${what} is in use by another program.`;
    case 'ENOSPC':
      return `There is not enough space on the disk.`;
    default:
      return (err && err.message) || 'Something went wrong.';
  }
}

const WIN_HIDDEN_NAMES = new Set([
  '$recycle.bin',
  'system volume information',
  'desktop.ini',
  'thumbs.db',
  'ntuser.dat',
  'pagefile.sys',
  'hiberfil.sys',
  'swapfile.sys',
  'recovery',
  'config.msi',
]);

function isHiddenName(name) {
  if (name.startsWith('.')) return true;
  if (isWin) {
    const l = name.toLowerCase();
    return name.startsWith('$') || WIN_HIDDEN_NAMES.has(l);
  }
  return false;
}

function extOf(name, isDir) {
  if (isDir) return '';
  const i = name.lastIndexOf('.');
  if (i <= 0) return '';
  return name.slice(i + 1).toLowerCase();
}

async function buildEntry(dir, dirent) {
  const full = path.join(dir, dirent.name);
  const entry = {
    name: dirent.name,
    path: full,
    isDir: false,
    size: 0,
    mtime: 0,
    birthtime: 0,
    extension: '',
    hidden: isHiddenName(dirent.name),
    isSymlink: dirent.isSymbolicLink(),
  };
  try {
    const st = await fsp.stat(full); // follows symlinks
    let isDir = st.isDirectory();
    // macOS .app bundles behave like files
    if (isMac && isDir && dirent.name.toLowerCase().endsWith('.app')) isDir = false;
    entry.isDir = isDir;
    entry.size = isDir ? 0 : st.size;
    entry.mtime = st.mtimeMs;
    entry.birthtime = st.birthtimeMs || st.ctimeMs;
    entry.extension = extOf(dirent.name, isDir);
    if (!isDir && dirent.name.toLowerCase().endsWith('.app') && isMac) entry.extension = 'app';
  } catch {
    // Broken symlink or unreadable entry: try lstat, otherwise return the bare entry.
    try {
      const st = await fsp.lstat(full);
      entry.size = st.size;
      entry.mtime = st.mtimeMs;
      entry.birthtime = st.birthtimeMs || st.ctimeMs;
      entry.extension = extOf(dirent.name, false);
    } catch {
      /* ignore */
    }
  }
  return entry;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

function samePath(a, b) {
  if (isWin) return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  return path.resolve(a) === path.resolve(b);
}

function isInside(child, parent) {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  const cc = isWin ? c.toLowerCase() : c;
  const pp = isWin ? p.toLowerCase() : p;
  if (cc === pp) return true;
  const withSep = pp.endsWith(path.sep) ? pp : pp + path.sep;
  return cc.startsWith(withSep);
}

async function exists(p) {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function uniqueName(dir, base, ext, style) {
  // style: 'folder' | 'copy'
  let n = 1;
  while (true) {
    let name;
    if (style === 'folder') {
      const stem = isWin ? 'New folder' : 'untitled folder';
      name = n === 1 ? stem : `${stem} ${n}`;
      if (isWin && n > 1) name = `${stem} (${n})`;
    } else if (isWin) {
      name = n === 1 ? `${base} - Copy${ext}` : `${base} - Copy (${n})${ext}`;
    } else {
      name = n === 1 ? `${base} copy${ext}` : `${base} copy ${n}${ext}`;
    }
    if (!(await exists(path.join(dir, name)))) return name;
    n++;
  }
}

function validateName(name) {
  if (typeof name !== 'string') return 'Invalid name.';
  const trimmed = name.trim();
  if (!trimmed) return 'The name cannot be empty.';
  if (trimmed === '.' || trimmed === '..') return 'That name is not allowed.';
  if (/[\\/]/.test(trimmed)) return 'A name cannot contain / or \\.';
  if (isWin) {
    if (/[<>:"|?*]/.test(trimmed)) return 'A name cannot contain any of the following: < > : " | ? *';
    if (/[. ]$/.test(name)) return 'A name cannot end with a period or space.';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(trimmed)) return 'That name is reserved by Windows.';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Windows & watchers                                                  */
/* ------------------------------------------------------------------ */

const watchers = new Map(); // webContents.id -> { watcher, timer, dir }

function stopWatching(id) {
  const w = watchers.get(id);
  if (!w) return;
  clearTimeout(w.timer);
  try {
    w.watcher.close();
  } catch {
    /* ignore */
  }
  watchers.delete(id);
}

function createWindow(startPath) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 480,
    show: false,
    backgroundColor: '#1b1d1f',
    title: 'File Manager',
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const contents = win.webContents;
  const id = contents.id;
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => stopWatching(id));

  // Never let the renderer navigate away or spawn windows by itself.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (e, url) => {
    if (url === 'mailto:gokhaleshail@gmail.com') {
      e.preventDefault();
      shell.openExternal(url);
      return;
    }
    if (!DEV_URL || !url.startsWith(DEV_URL)) e.preventDefault();
  });

  if (DEV_URL) {
    const url = new URL(DEV_URL);
    if (startPath) url.searchParams.set('path', startPath);
    win.loadURL(url.toString());
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), {
      query: startPath ? { path: startPath } : {},
    });
  }
  return win;
}

function sendCommand(cmd, arg) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send('menu:command', { cmd, arg });
}

/* ------------------------------------------------------------------ */
/* Drives (polled)                                                     */
/* ------------------------------------------------------------------ */

let lastDrivesKey = '';
let lastDrives = [];

// Mounted .dmg installers show up in /Volumes but aren't drives; hide them (cached per mount point).
const diskImageCache = new Map();
function isDiskImage(volPath) {
  if (diskImageCache.has(volPath)) return Promise.resolve(diskImageCache.get(volPath));
  return new Promise((resolve) => {
    execFile('/usr/sbin/diskutil', ['info', volPath], { timeout: 5000 }, (err, out) => {
      if (err) return resolve(false); // unknown: keep it listed
      const v = /Protocol:\s+Disk Image/.test(out);
      diskImageCache.set(volPath, v);
      resolve(v);
    });
  });
}

async function scanDrives() {
  const drives = [];
  if (isWin) {
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const res = await Promise.all(
      letters.map(async (l) => {
        const root = `${l}:\\`;
        try {
          await fsp.access(root);
          return { name: `Local Disk (${l}:)`, path: root, letter: l };
        } catch {
          return null;
        }
      })
    );
    drives.push(...res.filter(Boolean));
  } else if (isMac) {
    try {
      const names = await fsp.readdir('/Volumes');
      const found = await Promise.all(
        names
          .filter((n) => !n.startsWith('.'))
          .map(async (n) => {
            const p = path.join('/Volumes', n);
            return (await isDiskImage(p)) ? null : { name: n, path: p };
          })
      );
      drives.push(...found.filter(Boolean));
      // forget unmounted volumes so a re-mounted name is re-checked
      for (const k of diskImageCache.keys()) if (!names.some((n) => path.join('/Volumes', n) === k)) diskImageCache.delete(k);
    } catch {
      /* ignore */
    }
  } else {
    drives.push({ name: 'Root', path: '/' });
  }
  return drives;
}

let lastMtpKey = '';
let lastMtp = null;

async function pollMtp() {
  const d = await mtp.detect();
  lastMtp = d ? { name: mtp.getLabel() || 'Android phone', path: 'mtp://phone/' } : null;
  const key = lastMtp ? lastMtp.name : '';
  if (!d) {
    mtp.stopHelper();
    remote.resetWarm();
  } else {
    remote.warmPhone();
  }
  if (key !== lastMtpKey) {
    lastMtpKey = key;
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('mtp:changed', lastMtp);
    }
  }
}

async function pollDrives() {
  const drives = await scanDrives();
  const key = drives.map((d) => d.path).join('|');
  lastDrives = drives;
  if (key !== lastDrivesKey) {
    lastDrivesKey = key;
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('drives:changed', drives);
    }
  }
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

const str = (v) => typeof v === 'string' && v.length > 0;

function registerIpc() {
  ipcMain.handle('fs:list', async (_e, dir, fresh) => {
    if (!str(dir)) return { ok: false, error: 'Invalid path.' };
    if (remote.isRemote(dir)) return remote.list(dir, !!fresh);
    try {
      const t0 = Date.now();
      const [dirents, hiddenSet] = await Promise.all([fsp.readdir(dir, { withFileTypes: true }), fileops.hiddenNames(dir)]);
      const t1 = Date.now();
      const entries = await mapLimit(dirents, 64, (d) => buildEntry(dir, d));
      for (const e of entries) if (hiddenSet.has(e.name)) e.hidden = true;
      if (process.env.FM_PROFILE) console.log(`[list] ${dirents.length} entries: readdir+hidden ${t1 - t0} ms, stat ${Date.now() - t1} ms`);
      return { ok: true, path: dir, entries };
    } catch (err) {
      return { ok: false, error: friendlyError(err) };
    }
  });

  ipcMain.handle('fs:quickAccess', () => {
    const items = [
      ['Home', 'home'],
      ['Desktop', 'desktop'],
      ['Documents', 'documents'],
      ['Downloads', 'downloads'],
      ['Pictures', 'pictures'],
      ['Music', 'music'],
      ['Videos', 'videos'],
    ];
    const out = [];
    for (const [label, key] of items) {
      try {
        // app.getPath uses 'videos' on Windows/Linux and 'videos' on mac too (maps to Movies)
        out.push({ key, label: key === 'videos' && isMac ? 'Movies' : label, path: app.getPath(key) });
      } catch {
        /* folder not available */
      }
    }
    return out;
  });

  ipcMain.handle('fs:drives', async (_e, fresh) => {
    if (fresh || !lastDrives.length) await pollDrives();
    return lastDrives;
  });

  // Recursive breadth-first name search
  const searches = new Map(); // id -> { cancelled }
  ipcMain.handle('fs:search', async (_e, { id, root, query, showHidden }) => {
    if (!str(root) || !str(query)) return { ok: true, entries: [], truncated: false };
    const state = { cancelled: false };
    searches.set(id, state);
    const matcher = makeMatcher(query);
    const CAP = 3000;
    const results = [];
    if (remote.isRemote(root)) {
      // Phone / FTP: breadth-first over cached listings (first visit of a big folder can take a while)
      const queue = [root];
      let visited = 0;
      let truncated = false;
      try {
        while (queue.length && !state.cancelled && !truncated && visited++ < 2000) {
          const dir = queue.shift();
          const r = await remote.list(dir);
          if (!r.ok) continue;
          for (const e of r.entries) {
            if (!showHidden && e.hidden) continue;
            if (matcher(e.name)) {
              results.push({ ...e, parent: dir });
              if (results.length >= CAP) {
                truncated = true;
                break;
              }
            }
            if (e.isDir) queue.push(e.path);
          }
        }
      } finally {
        searches.delete(id);
      }
      return { ok: true, entries: results, truncated, cancelled: state.cancelled };
    }
    const queue = [root];
    let truncated = false;
    try {
      while (queue.length && !state.cancelled && !truncated) {
        const dir = queue.shift();
        let dirents;
        try {
          dirents = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          continue; // skip unreadable folders
        }
        for (const d of dirents) {
          if (state.cancelled) break;
          if (!showHidden && isHiddenName(d.name)) continue;
          const isBundle = isMac && d.name.toLowerCase().endsWith('.app');
          const full = path.join(dir, d.name);
          if (matcher(d.name)) {
            const entry = await buildEntry(dir, d);
            entry.parent = dir;
            results.push(entry);
            if (results.length >= CAP) {
              truncated = true;
              break;
            }
          }
          // Don't follow symlinks (avoids cycles) or into app bundles.
          if (d.isDirectory() && !d.isSymbolicLink() && !isBundle) queue.push(full);
        }
        // yield to the event loop between directories
        await new Promise((r) => setImmediate(r));
      }
    } finally {
      searches.delete(id);
    }
    return { ok: true, entries: results, truncated, cancelled: state.cancelled };
  });

  ipcMain.on('fs:cancelSearch', (_e, id) => {
    const s = searches.get(id);
    if (s) s.cancelled = true;
  });

  // Watching
  ipcMain.on('fs:watch', (e, dir) => {
    const contents = e.sender;
    const id = contents.id;
    stopWatching(id);
    if (!str(dir) || remote.isRemote(dir)) return;
    try {
      const record = { dir, timer: null, watcher: null };
      record.watcher = fs.watch(dir, { persistent: false }, () => {
        clearTimeout(record.timer);
        record.timer = setTimeout(() => {
          if (!contents.isDestroyed()) contents.send('fs:changed', { dir });
        }, 250);
      });
      record.watcher.on('error', () => stopWatching(id));
      watchers.set(id, record);
    } catch {
      /* directory may be unwatchable; ignore */
    }
  });
  ipcMain.on('fs:unwatch', (e) => stopWatching(e.sender.id));

  // Shell
  ipcMain.handle('shell:open', async (_e, paths, meta) => {
    const list = (Array.isArray(paths) ? paths : [paths]).filter(str);
    const errors = [];
    for (let p of list) {
      if (remote.isRemote(p)) {
        try {
          p = await remote.fetchForOpen(p, (meta && meta[p]) || {});
        } catch (err) {
          errors.push((err && err.message) || 'Could not download the file.');
          continue;
        }
      }
      const msg = await shell.openPath(p);
      if (msg) errors.push(msg);
    }
    return { ok: errors.length === 0, error: errors[0] };
  });
  ipcMain.handle('shell:editors', () => editors.list());
  ipcMain.handle('shell:openInEditor', (_e, id, paths) => {
    const list = (Array.isArray(paths) ? paths : [paths]).filter((p) => str(p) && !remote.isRemote(p));
    if (!str(id) || !list.length) return { ok: false, error: 'Nothing to open.' };
    return editors.open(id, list);
  });
  ipcMain.on('shell:showInFolder', (_e, p) => {
    if (str(p) && !remote.isRemote(p)) shell.showItemInFolder(p);
  });
  ipcMain.handle('shell:openFolder', async (_e, p) => {
    if (!str(p) || remote.isRemote(p)) return { ok: false };
    const msg = await shell.openPath(p);
    return { ok: !msg, error: msg || undefined };
  });
  ipcMain.on('window:new', (_e, p) => createWindow(str(p) ? p : undefined));
  ipcMain.on('clipboard:writeText', (_e, text) => {
    if (typeof text === 'string') clipboard.writeText(text);
  });
  ipcMain.on('edit:text', (e, action) => {
    const c = e.sender;
    if (action === 'undo') c.undo();
    else if (action === 'cut') c.cut();
    else if (action === 'copy') c.copy();
    else if (action === 'paste') c.paste();
    else if (action === 'selectAll') c.selectAll();
  });

  ipcMain.handle('mtp:device', async () => {
    await pollMtp();
    return lastMtp;
  });

  // Explorer-style operations (local files only)
  const guard = (fn) => async (_e, ...args) => {
    try {
      return { ok: true, ...(await fn(...args)) };
    } catch (err) {
      return { ok: false, error: friendlyError(err, 'item') };
    }
  };
  const sendTo = (e) => (msg) => {
    if (!e.sender.isDestroyed()) e.sender.send('transfer:progress', msg);
  };
  ipcMain.handle('fs:compress', async (e, paths, id) => {
    try {
      if (remote.isRemote(paths[0])) {
        const r = await transfer.compressRemote({ id: id || `z${Date.now()}`, paths }, sendTo(e));
        return r.ok ? { ok: true, path: r.path } : r;
      }
      return { ok: true, path: await fileops.compress(paths) };
    } catch (err) {
      return { ok: false, error: friendlyError(err, 'item') };
    }
  });
  ipcMain.handle('fs:extract', async (e, p, id) => {
    try {
      if (remote.isRemote(p)) {
        const r = await transfer.extractRemote({ id: id || `x${Date.now()}`, path: p }, sendTo(e));
        return r.ok ? { ok: true, path: r.path } : r;
      }
      return { ok: true, path: await fileops.extract(p) };
    } catch (err) {
      return { ok: false, error: friendlyError(err, 'item') };
    }
  });
  ipcMain.handle('fs:setHidden', guard(async (paths, hidden) => ({ paths: await fileops.setHidden(paths, !!hidden) })));
  ipcMain.handle('fs:setReadOnly', guard(async (paths, ro) => (await fileops.setReadOnly(paths, !!ro), {})));
  ipcMain.handle('fs:properties', guard((p) => fileops.properties(p)));
  ipcMain.handle('fs:newFile', guard(async (dir) => ({ path: await fileops.newFile(dir) })));
  ipcMain.handle('fs:deletePermanent', (e, paths, id) =>
    transfer.deleteItems(
      { id: id || `d${Date.now()}`, paths: paths || [], permanent: true },
      (msg) => !e.sender.isDestroyed() && e.sender.send('transfer:progress', msg)
    )
  );
  ipcMain.handle('dialog:chooseFolder', async (e, title) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, { title: title || 'Choose a folder', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('shell:openWith', async (e, paths) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose an app to open with',
      defaultPath: isMac ? '/Applications' : undefined,
      properties: ['openFile'],
      filters: isMac ? [{ name: 'Applications', extensions: ['app'] }] : isWin ? [{ name: 'Programs', extensions: ['exe', 'bat', 'cmd'] }] : [],
    });
    if (r.canceled) return { ok: true, canceled: true };
    const appPath = r.filePaths[0];
    const files = (paths || []).filter((p) => !remote.isRemote(p));
    try {
      if (isMac) await new Promise((res, rej) => execFile('/usr/bin/open', ['-a', appPath, ...files], (err) => (err ? rej(err) : res())));
      else require('node:child_process').spawn(appPath, files, { detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: friendlyError(err, 'item') };
    }
  });

  ipcMain.handle('preview:source', (_e, p, meta) => preview.source(p, meta || {}));

  // FTP connections
  ipcMain.handle('ftp:list', () => remote.listConnections());
  ipcMain.handle('ftp:add', (_e, cfg) => remote.addConnection(cfg || {}));
  ipcMain.handle('ftp:remove', (_e, id) => {
    remote.removeConnection(id);
    return remote.listConnections();
  });

  // Mutations
  ipcMain.handle('fs:newFolder', async (_e, dir) => {
    if (remote.isRemote(dir)) return remote.newFolder(dir);
    try {
      const name = await uniqueName(dir, '', '', 'folder');
      const full = path.join(dir, name);
      await fsp.mkdir(full);
      return { ok: true, path: full, name };
    } catch (err) {
      return { ok: false, error: friendlyError(err) };
    }
  });

  ipcMain.handle('fs:rename', async (_e, { path: from, newName }) => {
    if (remote.isRemote(from)) return remote.rename(from, newName);
    const bad = validateName(newName);
    if (bad) return { ok: false, error: bad };
    const name = isWin ? newName.trim() : newName;
    const to = path.join(path.dirname(from), name);
    if (to === from) return { ok: true, path: from };
    const caseOnly = samePath(to, from);
    if (!caseOnly && (await exists(to))) {
      return { ok: false, error: `An item named "${name}" already exists here.` };
    }
    try {
      await fsp.rename(from, to);
      return { ok: true, path: to };
    } catch (err) {
      return { ok: false, error: friendlyError(err, 'item') };
    }
  });

  ipcMain.handle('fs:trash', (e, paths, id) =>
    transfer.deleteItems(
      { id: id || `d${Date.now()}`, paths: paths || [], permanent: false },
      (msg) => !e.sender.isDestroyed() && e.sender.send('transfer:progress', msg),
      (p) => shell.trashItem(p)
    )
  );

  ipcMain.handle('fs:pasteConflicts', async (_e, { items, dest }) => {
    try {
      return { ok: true, names: await transfer.conflicts(items || [], dest) };
    } catch (err) {
      return { ok: false, error: friendlyError(err, 'item'), names: [] };
    }
  });
  ipcMain.handle('fs:paste', async (e, args) => {
    const { items, dest, mode, id, policy, sizes, resume, targets } = args || {};
    return transfer.run(
      { id: id || `t${Date.now()}`, items, dest, mode, policy, sizes, resume: !!resume, targets: targets || {} },
      (msg) => {
        if (!e.sender.isDestroyed()) e.sender.send('transfer:progress', msg);
      }
    );
  });
  ipcMain.handle('transfer:discard', (_e, targets) => transfer.discard(targets));
  ipcMain.on('transfer:cancel', (_e, id) => transfer.cancel(id));

  // macOS Finder reports "available" including purgeable space (caches, snapshots, iCloud);
  // statfs only sees truly free blocks, so ask Foundation for the same figure Finder shows.
  const MAC_CAPACITY_JS = `ObjC.import('Foundation');
function run(a){var r=$.NSURL.fileURLWithPath(a[0]).resourceValuesForKeysError($(['NSURLVolumeTotalCapacityKey','NSURLVolumeAvailableCapacityForImportantUsageKey']),null);
return JSON.stringify({total:ObjC.unwrap(r.objectForKey('NSURLVolumeTotalCapacityKey')),free:ObjC.unwrap(r.objectForKey('NSURLVolumeAvailableCapacityForImportantUsageKey'))});}`;
  const macCapacity = (p) =>
    new Promise((resolve) => {
      execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_CAPACITY_JS, p], { timeout: 5000 }, (err, out) => {
        if (err) return resolve(null);
        try {
          const v = JSON.parse(out);
          resolve(v.total > 0 && v.free >= 0 ? v : null);
        } catch {
          resolve(null);
        }
      });
    });

  ipcMain.handle('fs:diskSpace', async (_e, p) => {
    if (!str(p)) return { ok: false };
    if (p.startsWith('mtp://')) {
      try {
        return { ok: true, ...(await mtp.space(p)) };
      } catch {
        return { ok: false };
      }
    }
    if (remote.isRemote(p)) return { ok: false };
    if (isMac) {
      const v = await macCapacity(p);
      if (v) return { ok: true, total: v.total, free: v.free, used: Math.max(0, v.total - v.free) };
    }
    try {
      const st = await fsp.statfs(p);
      const total = st.blocks * st.bsize;
      const free = st.bavail * st.bsize;
      return { ok: true, total, free, used: Math.max(0, total - st.bfree * st.bsize) };
    } catch (err) {
      return { ok: false, error: friendlyError(err) };
    }
  });

  // Storage cleanup scan: large files, duplicates, installers/disk images
  const hashFile = (file) =>
    new Promise((resolve, reject) => {
      const h = crypto.createHash('sha1');
      fs.createReadStream(file)
        .on('data', (c) => h.update(c))
        .on('error', reject)
        .on('end', () => resolve(h.digest('hex')));
    });

  ipcMain.handle('fs:cleanScan', async (_e, root) => {
    if (!str(root)) return { ok: false, error: 'Invalid path.' };
    if (remote.isRemote(root)) return { ok: false, error: 'Clean up works on folders on this computer, not on a phone connection.' };
    const LARGE = 100 * 1024 * 1024;
    const DUP_MIN = 1024 * 1024;
    const MAX_FILES = 400000;
    const INSTALLER_EXT = new Set(['dmg', 'pkg', 'exe', 'msi', 'apk', 'iso']);
    const OLD_AGE = 365 * 24 * 3600 * 1000;
    const OLD_MIN = 10 * 1024 * 1024;
    const large = [];
    const old = [];
    const installers = [];
    const bySize = new Map();
    let scanned = 0;
    let truncated = false;
    const stack = [root];
    const mk = (full, name, st) => ({ path: full, name, size: st.size, mtime: st.mtimeMs });
    while (stack.length && !truncated) {
      const dir = stack.pop();
      let dirents;
      try {
        dirents = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of dirents) {
        if (isHiddenName(d.name) || d.isSymbolicLink()) continue;
        const full = path.join(dir, d.name);
        if (d.isDirectory()) {
          if (!(isMac && d.name.toLowerCase().endsWith('.app'))) stack.push(full);
          continue;
        }
        if (!d.isFile()) continue;
        let st;
        try {
          st = await fsp.stat(full);
        } catch {
          continue;
        }
        if (++scanned > MAX_FILES) {
          truncated = true;
          break;
        }
        const ext = extOf(d.name, false);
        if (st.size >= LARGE) large.push(mk(full, d.name, st));
        if (st.size >= OLD_MIN && Date.now() - st.mtimeMs > OLD_AGE && Date.now() - st.atimeMs > OLD_AGE) old.push(mk(full, d.name, st));
        if (INSTALLER_EXT.has(ext)) installers.push(mk(full, d.name, st));
        if (st.size >= DUP_MIN) {
          const list = bySize.get(st.size) || [];
          list.push(mk(full, d.name, st));
          bySize.set(st.size, list);
        }
      }
      await new Promise((r) => setImmediate(r));
    }
    const duplicates = [];
    for (const list of bySize.values()) {
      if (list.length < 2) continue;
      const byHash = new Map();
      for (const f of list) {
        try {
          const h = await hashFile(f.path);
          byHash.set(h, [...(byHash.get(h) || []), f]);
        } catch {
          /* unreadable; skip */
        }
      }
      for (const files of byHash.values()) {
        if (files.length > 1) duplicates.push({ size: files[0].size, files });
      }
    }
    const bySizeDesc = (a, b) => b.size - a.size;
    duplicates.sort((a, b) => b.size * (b.files.length - 1) - a.size * (a.files.length - 1));
    return {
      ok: true,
      scanned,
      truncated,
      large: large.sort(bySizeDesc).slice(0, 100),
      installers: installers.sort(bySizeDesc).slice(0, 100),
      old: old.sort(bySizeDesc).slice(0, 100),
      duplicates: duplicates.slice(0, 100),
    };
  });

  // Cache / temp folders (top level only), biggest first — safe to remove, apps rebuild them.
  ipcMain.handle('fs:cacheScan', async () => {
    const roots = isMac
      ? [path.join(app.getPath('home'), 'Library', 'Caches')]
      : isWin
        ? [app.getPath('temp'), path.join(process.env.LOCALAPPDATA || '', 'Temp')]
        : [path.join(app.getPath('home'), '.cache')];
    const duKb = (p) =>
      new Promise((resolve) => {
        execFile('du', ['-sk', p], { timeout: 60000 }, (err, out) => resolve(err && !out ? 0 : (parseInt(out, 10) || 0) * 1024));
      });
    const walk = async (p) => {
      let n = 0;
      let dirents = [];
      try {
        dirents = await fsp.readdir(p, { withFileTypes: true });
      } catch {
        return 0;
      }
      for (const d of dirents) {
        const full = path.join(p, d.name);
        if (d.isDirectory() && !d.isSymbolicLink()) n += await walk(full);
        else {
          try {
            n += (await fsp.lstat(full)).size;
          } catch {
            /* ignore */
          }
        }
      }
      return n;
    };
    const out = [];
    for (const root of new Set(roots)) {
      let names = [];
      try {
        names = await fsp.readdir(root);
      } catch {
        continue;
      }
      const sized = await mapLimit(names, 6, async (n) => {
        const full = path.join(root, n);
        return { path: full, name: n, size: isWin ? await walk(full) : await duKb(full), mtime: 0 };
      });
      out.push(...sized);
    }
    return { ok: true, caches: out.filter((c) => c.size > 0).sort((a, b) => b.size - a.size).slice(0, 100) };
  });

  ipcMain.handle('fs:folderSize', async (_e, dir) => {
    if (remote.isRemote(dir)) return remote.folderSize(dir);
    const MAX = 200000;
    let size = 0;
    let count = 0;
    let truncated = false;
    const stack = [dir];
    try {
      while (stack.length && !truncated) {
        const cur = stack.pop();
        let dirents;
        try {
          dirents = await fsp.readdir(cur, { withFileTypes: true });
        } catch {
          continue;
        }
        await Promise.all(
          dirents.map(async (d) => {
            if (truncated) return;
            const full = path.join(cur, d.name);
            if (d.isSymbolicLink()) return;
            if (d.isDirectory()) {
              stack.push(full);
            } else {
              try {
                const st = await fsp.stat(full);
                size += st.size;
              } catch {
                /* ignore */
              }
            }
            if (++count > MAX) truncated = true;
          })
        );
      }
      return { ok: true, size, count, truncated };
    } catch (err) {
      return { ok: false, error: friendlyError(err) };
    }
  });

  // Thumbnails
  const thumbCache = new Map();
  const THUMB_MAX = 600;
  let thumbActive = 0;
  const thumbWaiters = [];
  const acquire = async () => {
    if (thumbActive >= 4) await new Promise((r) => thumbWaiters.push(r));
    thumbActive++;
  };
  const release = () => {
    thumbActive--;
    const next = thumbWaiters.shift();
    if (next) next();
  };

  ipcMain.handle('fs:thumbnail', async (_e, { path: p, mtime, size = 160 }) => {
    if (str(p) && p.startsWith('mtp://')) {
      return /\.(jpe?g|png|gif|webp|bmp|heic|mp4|mov|3gp|mkv|webm)$/i.test(p) ? mtp.thumbnail(p) : null;
    }
    if (!str(p) || remote.isRemote(p) || typeof nativeImage.createThumbnailFromPath !== 'function') return null;
    if (!isMac && !isWin) return null;
    const key = `${p}|${mtime}|${size}`;
    if (thumbCache.has(key)) {
      const v = thumbCache.get(key);
      thumbCache.delete(key);
      thumbCache.set(key, v); // refresh LRU position
      return v;
    }
    await acquire();
    try {
      const img = await nativeImage.createThumbnailFromPath(p, { width: size, height: size });
      const url = img.isEmpty() ? null : img.toDataURL();
      thumbCache.set(key, url);
      if (thumbCache.size > THUMB_MAX) thumbCache.delete(thumbCache.keys().next().value);
      return url;
    } catch {
      thumbCache.set(key, null);
      return null;
    } finally {
      release();
    }
  });
}

async function isDirectory(p) {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Build a case-insensitive matcher: plain text = substring; * and ? = glob over the whole name. */
function makeMatcher(query) {
  const q = query.trim().toLowerCase();
  if (!/[*?]/.test(q)) return (name) => name.toLowerCase().includes(q);
  const re = new RegExp(
    '^' +
      q
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
    'i'
  );
  return (name) => re.test(name);
}

/* ------------------------------------------------------------------ */
/* Application menu                                                    */
/* ------------------------------------------------------------------ */

function buildMenu() {
  const cmd = (label, command, accelerator, extra = {}) => ({
    label,
    accelerator,
    click: () => sendCommand(command),
    ...extra,
  });

  const template = [];

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push({
    label: 'File',
    submenu: [
      { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
      cmd('New Tab', 'newTab', 'CmdOrCtrl+T'),
      cmd('New Folder', 'newFolder', 'CmdOrCtrl+Shift+N'),
      cmd('Open', 'open', 'CmdOrCtrl+O'),
      { type: 'separator' },
      cmd('Close Tab', 'closeTab', 'CmdOrCtrl+W'),
      ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
    ],
  });

  template.push({
    label: 'Edit',
    submenu: [
      cmd('Undo', 'undo', 'CmdOrCtrl+Z'),
      { type: 'separator' },
      cmd('Cut', 'cut', 'CmdOrCtrl+X'),
      cmd('Copy', 'copy', 'CmdOrCtrl+C'),
      cmd('Paste', 'paste', 'CmdOrCtrl+V'),
      { type: 'separator' },
      cmd('Select All', 'selectAll', 'CmdOrCtrl+A'),
      { type: 'separator' },
      cmd('Find', 'find', 'CmdOrCtrl+F'),
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      cmd('Details', 'viewDetails', isMac ? 'Cmd+2' : 'Ctrl+Shift+6'),
      cmd('Icons', 'viewIcons', isMac ? 'Cmd+1' : 'Ctrl+Shift+2'),
      { type: 'separator' },
      cmd('Filters Panel', 'toggleFilters', 'CmdOrCtrl+Shift+F'),
      cmd('Show Hidden Files', 'toggleHidden', isMac ? 'Cmd+Shift+.' : 'Ctrl+H'),
      { type: 'separator' },
      cmd('Refresh', 'refresh', 'CmdOrCtrl+R'),
      { type: 'separator' },
      { role: 'togglefullscreen' },
      ...(DEV_URL ? [{ role: 'toggleDevTools' }] : []),
    ],
  });

  template.push({
    label: 'Go',
    submenu: [
      cmd('Back', 'back', isMac ? 'Cmd+[' : 'Alt+Left'),
      cmd('Forward', 'forward', isMac ? 'Cmd+]' : 'Alt+Right'),
      cmd('Up', 'up', isMac ? 'Cmd+Up' : 'Alt+Up'),
      cmd('Home', 'home', isMac ? 'Cmd+Shift+H' : 'Alt+Home'),
      { type: 'separator' },
      cmd('Go to Address', 'goToAddress', isMac ? 'Cmd+Shift+G' : 'Ctrl+L'),
      { type: 'separator' },
      cmd('Next Tab', 'nextTab', 'Ctrl+Tab'),
      cmd('Previous Tab', 'prevTab', 'Ctrl+Shift+Tab'),
    ],
  });

  template.push({
    label: 'Window',
    submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ role: 'front' }] : [{ role: 'close' }])],
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ */
/* App lifecycle                                                       */
/* ------------------------------------------------------------------ */

// One running copy per user: a second launch (for example the installed app while a dev copy is open) would
// otherwise fight the first one for the phone's USB connection.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    } else if (app.isReady()) createWindow();
  });
}

app.whenReady().then(() => {
  if (!gotLock) return;
  if (isMac && app.dock) app.dock.setIcon(nativeImage.createFromPath(ICON)); // Dock icon when run from source
  // fmfile://local/<path> serves files the renderer asked to preview (with Range support for video)
  protocol.handle('fmfile', (req) => {
    let p;
    try {
      p = preview.pathFromUrl(req.url);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    if (!preview.approved.has(p)) return new Response('Forbidden', { status: 403 });
    return net.fetch(require('node:url').pathToFileURL(p).toString(), { headers: req.headers });
  });
  remote.init({ userDataDir: app.getPath('userData'), safeStorage });
  registerIpc();
  buildMenu();
  createWindow(process.env.FM_START_PATH || undefined);
  pollDrives();
  setInterval(pollDrives, 5000);
  pollMtp();
  setInterval(pollMtp, 5000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  mtp.stopHelper();
  remote.clearTemp();
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
