/** Windows-Explorer-style file operations: compress, extract, hide/unhide, properties, new file. */
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error((stderr || err.message || '').toString().trim().split('\n').slice(-2).join(' '));
        e.code = err.code;
        reject(e);
      } else resolve(stdout.toString());
    });
  });

const exists = (p) =>
  fsp.lstat(p).then(
    () => true,
    () => false
  );

async function uniquePath(dir, name, ext = '') {
  let n = 1;
  for (;;) {
    const cand = path.join(dir, `${name}${n === 1 ? '' : isWin ? ` (${n})` : ` ${n}`}${ext}`);
    if (!(await exists(cand))) return cand;
    n++;
  }
}

/* ------------------------------- archives -------------------------------- */

const ARCHIVE_EXT = /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz)$/i;
const isArchive = (p) => ARCHIVE_EXT.test(p);

/** Compress items (all in the same folder) into one .zip next to them. */
async function compress(paths) {
  if (!paths.length) throw new Error('Nothing to compress.');
  const dir = path.dirname(paths[0]);
  const names = paths.map((p) => path.basename(p));
  const single = names.length === 1;
  const stem = single ? names[0].replace(/\.[^.]+$/, '') || names[0] : 'Archive';
  const out = await uniquePath(dir, stem, '.zip');
  if (isWin) {
    const list = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
    await run('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Compress-Archive -LiteralPath ${list} -DestinationPath '${out.replace(/'/g, "''")}'`,
    ]);
  } else {
    // -y keeps symlinks, -r recurses, -q quiet; cwd = folder so entries are relative names
    await run('/usr/bin/zip', ['-r', '-q', '-y', out, ...names], { cwd: dir });
  }
  return out;
}

/** Extract an archive into a new folder named after it (never overwrites). */
async function extract(archive) {
  const dir = path.dirname(archive);
  const base = path.basename(archive).replace(ARCHIVE_EXT, '');
  const out = await uniquePath(dir, base || 'Extracted');
  await fsp.mkdir(out);
  try {
    if (/\.zip$/i.test(archive)) {
      if (isWin) {
        await run('powershell.exe', [
          '-NoProfile',
          '-Command',
          `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${out.replace(/'/g, "''")}'`,
        ]);
      } else if (isMac) {
        await run('/usr/bin/ditto', ['-x', '-k', archive, out]);
      } else {
        await run('unzip', ['-q', archive, '-d', out]);
      }
    } else {
      await run(isWin ? 'tar.exe' : 'tar', ['-xf', archive, '-C', out]);
    }
  } catch (err) {
    await fsp.rm(out, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  return out;
}

/* ------------------------------ hidden / readonly ------------------------------ */

/** Names in `dir` carrying the OS "hidden" attribute (macOS UF_HIDDEN, Windows H). */
async function hiddenNames(dir) {
  try {
    if (isMac) {
      const out = await run('/usr/bin/find', [dir, '-maxdepth', '1', '-mindepth', '1', '-flags', 'hidden', '-print0']);
      return new Set(out.split('\0').filter(Boolean).map((p) => path.basename(p)));
    }
    if (isWin) {
      const out = await run('cmd.exe', ['/c', 'dir', '/a:h', '/b', dir]);
      return new Set(out.split(/\r?\n/).filter(Boolean).map((p) => path.basename(p)));
    }
  } catch {
    /* attribute lookup is best effort */
  }
  return new Set();
}

async function setHidden(paths, hidden) {
  const out = [];
  for (const p of paths) {
    if (isMac) {
      await run('/usr/bin/chflags', [hidden ? 'hidden' : 'nohidden', p]);
      out.push(p);
    } else if (isWin) {
      await run('attrib', [hidden ? '+h' : '-h', p]);
      out.push(p);
    } else {
      // Linux has no hidden attribute: the dot prefix is the convention.
      const name = path.basename(p);
      const next = path.join(path.dirname(p), hidden ? (name.startsWith('.') ? name : '.' + name) : name.replace(/^\.+/, ''));
      if (next !== p) await fsp.rename(p, next);
      out.push(next);
    }
  }
  return out;
}

async function setReadOnly(paths, readonly) {
  for (const p of paths) {
    if (isWin) {
      await run('attrib', [readonly ? '+r' : '-r', p]);
    } else {
      const st = await fsp.stat(p);
      const w = 0o222;
      await fsp.chmod(p, readonly ? st.mode & ~w : st.mode | 0o200);
    }
  }
}

/* -------------------------------- properties -------------------------------- */

const rwx = (m) =>
  ['r', 'w', 'x']
    .map((c, i) => (m & (0o400 >> i) ? c : '-'))
    .join('') +
  ['r', 'w', 'x'].map((c, i) => (m & (0o40 >> i) ? c : '-')).join('') +
  ['r', 'w', 'x'].map((c, i) => (m & (0o4 >> i) ? c : '-')).join('');

async function properties(p) {
  const lst = await fsp.lstat(p);
  const st = await fsp.stat(p).catch(() => lst);
  const hidden = (await hiddenNames(path.dirname(p))).has(path.basename(p)) || path.basename(p).startsWith('.');
  let target;
  if (lst.isSymbolicLink()) target = await fsp.readlink(p).catch(() => undefined);
  return {
    ok: true,
    path: p,
    name: path.basename(p) || p,
    parent: path.dirname(p),
    isDir: st.isDirectory(),
    isSymlink: lst.isSymbolicLink(),
    target,
    size: st.isDirectory() ? 0 : st.size,
    sizeOnDisk: st.blocks ? st.blocks * 512 : undefined,
    created: st.birthtimeMs || st.ctimeMs,
    modified: st.mtimeMs,
    accessed: st.atimeMs,
    mode: st.mode & 0o777,
    modeText: rwx(st.mode),
    readOnly: !(st.mode & 0o200),
    hidden,
    uid: st.uid,
  };
}

async function newFile(dir) {
  const full = await uniquePath(dir, isWin ? 'New Text Document' : 'untitled', '.txt');
  await fsp.writeFile(full, '', { flag: 'wx' });
  return full;
}

module.exports = { isArchive, compress, extract, hiddenNames, setHidden, setReadOnly, properties, newFile };
