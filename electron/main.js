const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  shell,
  clipboard,
  nativeImage,
} = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const isMac = process.platform === 'darwin';
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
      for (const n of names) {
        if (n.startsWith('.')) continue;
        drives.push({ name: n, path: path.join('/Volumes', n) });
      }
    } catch {
      /* ignore */
    }
  } else {
    drives.push({ name: 'Root', path: '/' });
  }
  return drives;
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
  ipcMain.handle('fs:list', async (_e, dir) => {
    if (!str(dir)) return { ok: false, error: 'Invalid path.' };
    try {
      const dirents = await fsp.readdir(dir, { withFileTypes: true });
      const entries = await mapLimit(dirents, 64, (d) => buildEntry(dir, d));
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

  ipcMain.handle('fs:drives', async () => {
    if (!lastDrives.length) await pollDrives();
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
    if (!str(dir)) return;
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
  ipcMain.handle('shell:open', async (_e, paths) => {
    const list = (Array.isArray(paths) ? paths : [paths]).filter(str);
    const errors = [];
    for (const p of list) {
      const msg = await shell.openPath(p);
      if (msg) errors.push(msg);
    }
    return { ok: errors.length === 0, error: errors[0] };
  });
  ipcMain.on('shell:showInFolder', (_e, p) => {
    if (str(p)) shell.showItemInFolder(p);
  });
  ipcMain.handle('shell:openFolder', async (_e, p) => {
    if (!str(p)) return { ok: false };
    const msg = await shell.openPath(p);
    return { ok: !msg, error: msg || undefined };
  });
  ipcMain.on('window:new', (_e, p) => createWindow(str(p) ? p : undefined));
  ipcMain.on('clipboard:writeText', (_e, text) => {
    if (typeof text === 'string') clipboard.writeText(text);
  });
  ipcMain.on('edit:text', (e, action) => {
    const c = e.sender;
    if (action === 'cut') c.cut();
    else if (action === 'copy') c.copy();
    else if (action === 'paste') c.paste();
    else if (action === 'selectAll') c.selectAll();
  });

  // Mutations
  ipcMain.handle('fs:newFolder', async (_e, dir) => {
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

  ipcMain.handle('fs:trash', async (_e, paths) => {
    const errors = [];
    for (const p of paths || []) {
      try {
        await shell.trashItem(p);
      } catch (err) {
        errors.push(`${path.basename(p)}: ${friendlyError(err, 'item')}`);
      }
    }
    return { ok: errors.length === 0, errors };
  });

  ipcMain.handle('fs:paste', async (_e, { items, dest, mode }) => {
    const errors = [];
    const pasted = [];
    for (const src of items || []) {
      try {
        const base = path.basename(src);
        if (isInside(dest, src) && (await isDirectory(src))) {
          errors.push(`Can't paste "${base}" into itself.`);
          continue;
        }
        const sameDir = samePath(path.dirname(src), dest);
        if (mode === 'cut' && sameDir) {
          pasted.push(src);
          continue; // moving to the same place is a no-op
        }
        let target = path.join(dest, base);
        if (await exists(target)) {
          const ext = path.extname(base);
          const stem = ext ? base.slice(0, -ext.length) : base;
          // Folders keep their dotted names intact
          const isDir = await isDirectory(src);
          const name = isDir
            ? await uniqueName(dest, base, '', 'copy')
            : await uniqueName(dest, stem, ext, 'copy');
          target = path.join(dest, name);
        }
        if (mode === 'cut') {
          try {
            await fsp.rename(src, target);
          } catch (err) {
            if (err.code === 'EXDEV') {
              await fsp.cp(src, target, { recursive: true, errorOnExist: true, force: false });
              await fsp.rm(src, { recursive: true, force: true });
            } else throw err;
          }
        } else {
          await fsp.cp(src, target, { recursive: true, errorOnExist: true, force: false });
        }
        pasted.push(target);
      } catch (err) {
        errors.push(`${path.basename(src)}: ${friendlyError(err, 'item')}`);
      }
    }
    return { ok: errors.length === 0, pasted, errors };
  });

  ipcMain.handle('fs:folderSize', async (_e, dir) => {
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
    if (!str(p) || typeof nativeImage.createThumbnailFromPath !== 'function') return null;
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

app.whenReady().then(() => {
  registerIpc();
  buildMenu();
  createWindow();
  pollDrives();
  setInterval(pollDrives, 5000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
